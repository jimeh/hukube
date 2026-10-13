package logstream

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	"github.com/jimeh/hukube/engine/internal/index"
	"github.com/jimeh/hukube/engine/internal/notify"
	"github.com/jimeh/hukube/engine/internal/protocol"
	"github.com/jimeh/hukube/engine/internal/relationship"
)

const deadline = 5 * time.Second

var shortTiming = Timing{
	RetryMin:   10 * time.Millisecond,
	RetryMax:   50 * time.Millisecond,
	Graph:      5 * time.Millisecond,
	Status:     5 * time.Millisecond,
	Batch:      5 * time.Millisecond,
	Initial:    50 * time.Millisecond,
	Appear:     50 * time.Millisecond,
	Silent:     30 * time.Millisecond,
	FastWindow: 100 * time.Millisecond,
	FastBytes:  64,
	BatchBytes: 256 << 10,
	FrameBytes: 64 << 10,
	Pods:       20,
}

type logRequest struct {
	pod     string
	options corev1.PodLogOptions
}
type fakeCluster struct {
	mu        sync.Mutex
	pods      map[string]*corev1.Pod
	watchers  map[string]func(protocol.ResourceData)
	typeState protocol.TypeState
	phase     protocol.ClusterPhase
	signal    notify.Signal
	requests  chan logRequest
	open      func(context.Context, string, *corev1.PodLogOptions) (io.ReadCloser, error)
}

func (f *fakeCluster) Type(protocol.TypeKey) (protocol.ResourceType, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return protocol.ResourceType{State: f.typeState}, true
}
func (f *fakeCluster) Status() protocol.ClusterStatus {
	f.mu.Lock()
	defer f.mu.Unlock()
	return protocol.ClusterStatus{Phase: f.phase}
}
func (f *fakeCluster) TypesChanged() (<-chan struct{}, func())  { return f.signal.Subscribe() }
func (f *fakeCluster) StatusChanged() (<-chan struct{}, func()) { return f.signal.Subscribe() }
func (f *fakeCluster) WatchObject(ctx context.Context, ref protocol.ResourceRef, emit func(protocol.ResourceData), _ func(error)) {
	f.mu.Lock()
	f.watchers[ref.Name] = emit
	pod := f.pods[ref.Name]
	f.mu.Unlock()
	if pod != nil {
		raw, _ := json.Marshal(pod)
		emit(protocol.ResourceData{Object: raw})
	}
	go func() { <-ctx.Done() }()
}
func (f *fakeCluster) OpenPodLogs(ctx context.Context, _, name string, o *corev1.PodLogOptions) (io.ReadCloser, error) {
	f.requests <- logRequest{name, *o.DeepCopy()}
	return f.open(ctx, name, o)
}
func (f *fakeCluster) update(pod *corev1.Pod) {
	f.mu.Lock()
	f.pods[pod.Name] = pod.DeepCopy()
	emit := f.watchers[pod.Name]
	f.mu.Unlock()
	if emit != nil {
		raw, _ := json.Marshal(pod)
		emit(protocol.ResourceData{Object: raw})
	}
}

type fakeGraph struct {
	mu     sync.Mutex
	target relationship.Node
	owned  []relationship.Node
	found  bool
	signal notify.Signal
}

func (g *fakeGraph) Node(protocol.TypeKey, string, string) (relationship.Node, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.target, g.found
}
func (g *fakeGraph) AllOwned(relationship.Node) []relationship.Node {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.owned)
}
func (g *fakeGraph) Changed() (<-chan struct{}, func()) { return g.signal.Subscribe() }
func node(pod *corev1.Pod) relationship.Node {
	return relationship.Node{Type: "pods", Meta: index.Meta{UID: string(pod.UID), Name: pod.Name, Namespace: pod.Namespace, CreatedAt: pod.CreationTimestamp.Time}}
}
func pod(name string, names ...string) *corev1.Pod {
	p := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "test", UID: types.UID(name), CreationTimestamp: metav1.NewTime(time.Now())}, Spec: corev1.PodSpec{NodeName: "node"}}
	for _, name := range names {
		p.Spec.Containers = append(p.Spec.Containers, corev1.Container{Name: name})
		p.Status.ContainerStatuses = append(p.Status.ContainerStatuses, corev1.ContainerStatus{Name: name, ContainerID: name + "-1", State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}})
	}
	return p
}
func newFake(pods ...*corev1.Pod) (*fakeCluster, *fakeGraph) {
	f := &fakeCluster{pods: map[string]*corev1.Pod{}, watchers: map[string]func(protocol.ResourceData){}, typeState: protocol.TypeStateReady, phase: protocol.ClusterPhaseReady, requests: make(chan logRequest, 1000)}
	g := &fakeGraph{target: relationship.Node{Type: "deployments.apps", Meta: index.Meta{UID: "target", Name: "target"}}, found: true}
	for _, p := range pods {
		f.pods[p.Name] = p
		g.owned = append(g.owned, node(p))
	}
	f.open = func(ctx context.Context, _ string, _ *corev1.PodLogOptions) (io.ReadCloser, error) {
		r, w := io.Pipe()
		go func() { <-ctx.Done(); w.Close() }()
		return r, nil
	}
	return f, g
}

type capture struct {
	mu          sync.Mutex
	records     []record
	statuses    []protocol.LogStreamStatus
	statusTimes []time.Time
	frames      [][]byte
	changed     chan struct{}
}

func newCapture() *capture { return &capture{changed: make(chan struct{}, 1)} }
func (c *capture) notify() {
	select {
	case c.changed <- struct{}{}:
	default:
	}
}
func (c *capture) Status(s protocol.LogStreamStatus) {
	c.mu.Lock()
	c.statuses = append(c.statuses, s)
	c.statusTimes = append(c.statusTimes, time.Now())
	c.mu.Unlock()
	c.notify()
}
func decodeFrame(frame []byte) []record {
	out := []record{}
	for b := frame[1:]; len(b) > 0; {
		n := int(binary.BigEndian.Uint32(b[11:15]))
		out = append(out, record{source: int(binary.BigEndian.Uint16(b)), flags: b[2], time: int64(binary.BigEndian.Uint64(b[3:11])), content: append([]byte(nil), b[15:15+n]...)})
		b = b[15+n:]
	}
	return out
}
func (c *capture) Frame(frame []byte, count int) {
	records := decodeFrame(frame)
	if len(records) != count {
		panic("incorrect frame record count")
	}
	c.mu.Lock()
	c.frames = append(c.frames, append([]byte(nil), frame...))
	c.records = append(c.records, records...)
	c.mu.Unlock()
	c.notify()
}
func (c *capture) snapshot() ([]record, protocol.LogStreamStatus) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := emptyStatus()
	if len(c.statuses) > 0 {
		s = c.statuses[len(c.statuses)-1]
	}
	return slices.Clone(c.records), s
}
func (c *capture) await(t *testing.T, match func([]record, protocol.LogStreamStatus) bool) ([]record, protocol.LogStreamStatus) {
	t.Helper()
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	for {
		r, s := c.snapshot()
		if match(r, s) {
			return r, s
		}
		select {
		case <-c.changed:
		case <-timer.C:
			t.Fatalf("condition not reached: records=%s status=%+v", describe(r), s)
		}
	}
}
func describe(records []record) string {
	s := []string{}
	for i, r := range records {
		if i >= 20 {
			s = append(s, fmt.Sprintf("... %d more records", len(records)-i))
			break
		}
		text := string(r.content)
		if len(text) > 80 {
			text = text[:80] + "..."
		}
		s = append(s, fmt.Sprintf("%d/%d/%d:%s", r.source, r.flags, r.time, text))
	}
	return strings.Join(s, "|")
}
func start(t *testing.T, f *fakeCluster, g *fakeGraph, p protocol.LogStreamParams) (*capture, <-chan protocol.StreamEnd, context.CancelFunc) {
	return startTimed(t, f, g, p, shortTiming)
}
func startTimed(t *testing.T, f *fakeCluster, g *fakeGraph, p protocol.LogStreamParams, timing Timing) (*capture, <-chan protocol.StreamEnd, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	out := newCapture()
	end := make(chan protocol.StreamEnd, 1)
	go func() { end <- Run(ctx, f, g, p, out, timing) }()
	return out, end, cancel
}
func targetParams() protocol.LogStreamParams {
	return protocol.LogStreamParams{Type: "deployments.apps", Name: "target", UID: "target"}
}
func awaitRequest(t *testing.T, f *fakeCluster) logRequest {
	t.Helper()
	select {
	case r := <-f.requests:
		return r
	case <-time.After(deadline):
		t.Fatal("log request not opened")
		return logRequest{}
	}
}
func awaitEnd(t *testing.T, ch <-chan protocol.StreamEnd) protocol.StreamEnd {
	t.Helper()
	select {
	case e := <-ch:
		return e
	case <-time.After(deadline):
		t.Fatal("Log Stream did not end")
		return protocol.StreamEnd{}
	}
}
func textBody(text string) io.ReadCloser { return io.NopCloser(strings.NewReader(text)) }
func line(n int, text string) string     { return fmt.Sprintf("2026-01-01T00:00:00.%09dZ %s\n", n, text) }

func TestLogLinesOrderAndResume(t *testing.T) {
	p := pod("pod", "main")
	f, g := newFake(p)
	var mu sync.Mutex
	count := 0
	f.open = func(ctx context.Context, _ string, o *corev1.PodLogOptions) (io.ReadCloser, error) {
		mu.Lock()
		defer mu.Unlock()
		count++
		switch count {
		case 1:
			return textBody(line(1, "a") + line(2, "b")), nil
		case 2:
			if o.SinceTime == nil {
				t.Error("retry did not resume")
			}
			return textBody(line(1, "a") + line(2, "b") + line(3, "c") + line(2, "runtime out of order")), nil
		default:
			r, w := io.Pipe()
			go func() { <-ctx.Done(); w.Close() }()
			return r, nil
		}
	}
	out, _, cancel := start(t, f, g, targetParams())
	defer cancel()
	r, _ := out.await(t, func(r []record, _ protocol.LogStreamStatus) bool { return len(r) >= 4 })
	if got := describe(r); got != "0/0/1767225600000000001:a|0/0/1767225600000000002:b|0/0/1767225600000000003:c|0/0/1767225600000000002:runtime out of order" {
		t.Fatalf("container order or duplicate suppression=%s", got)
	}
}

func TestLogContainerSelection(t *testing.T) {
	for _, selected := range []string{"", "main", "absent"} {
		t.Run("container="+selected, func(t *testing.T) {
			p := pod("pod", "main")
			p.Spec.InitContainers = []corev1.Container{{Name: "setup"}}
			p.Spec.EphemeralContainers = []corev1.EphemeralContainer{{EphemeralContainerCommon: corev1.EphemeralContainerCommon{Name: "debug"}}}
			p.Status.InitContainerStatuses = []corev1.ContainerStatus{{Name: "setup", ContainerID: "setup-1", State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ContainerID: "setup-1", Reason: "Completed"}}}}
			p.Status.EphemeralContainerStatuses = []corev1.ContainerStatus{{Name: "debug", ContainerID: "debug-1", State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}}
			f, g := newFake(p, pod("without-main", "helper"))
			params := targetParams()
			params.Container = selected
			out, end, cancel := start(t, f, g, params)
			want := 4
			if selected != "" {
				want = 1
			}
			if selected == "absent" {
				want = 0
			}
			_, s := out.await(t, func(_ []record, s protocol.LogStreamStatus) bool {
				return len(s.Containers) == 4 && len(s.Sources) == want
			})
			if !reflect.DeepEqual(s.Containers, []protocol.LogContainer{{Name: "helper", Kind: protocol.LogContainerKindContainer}, {Name: "main", Kind: protocol.LogContainerKindContainer}, {Name: "setup", Kind: protocol.LogContainerKindInit}, {Name: "debug", Kind: protocol.LogContainerKindEphemeral}}) {
				t.Fatalf("container chooser=%+v", s.Containers)
			}
			for range want {
				r := awaitRequest(t, f)
				if !r.options.Timestamps || !r.options.Follow || r.options.TailLines == nil || *r.options.TailLines != int64(min(1000, 2000/max(1, want))) {
					t.Fatalf("initial log request options=%+v", r.options)
				}
				if selected != "" && r.options.Container != selected {
					t.Fatalf("wrong container request=%+v", r)
				}
			}
			cancel()
			awaitEnd(t, end)
			if len(f.requests) != 0 {
				t.Fatalf("unselected containers opened %d requests", len(f.requests))
			}
		})
	}

	t.Run("name in two kinds", func(t *testing.T) {
		a := pod("a", "main")
		a.Spec.InitContainers = []corev1.Container{{Name: "setup"}}
		b := pod("b", "setup")
		f, g := newFake(a, b)
		out, end, cancel := start(t, f, g, targetParams())
		_, status := out.await(t, func(_ []record, s protocol.LogStreamStatus) bool { return s.Followed == 2 && len(s.Sources) == 3 })
		if !reflect.DeepEqual(status.Containers, []protocol.LogContainer{{Name: "main", Kind: protocol.LogContainerKindContainer}, {Name: "setup", Kind: protocol.LogContainerKindContainer}}) {
			t.Fatalf("duplicate chooser name across kinds: %+v", status.Containers)
		}
		cancel()
		awaitEnd(t, end)
	})
}

func TestLogPrevious(t *testing.T) {
	f, g := newFake(pod("pod", "yes", "none"))
	f.open = func(_ context.Context, _ string, o *corev1.PodLogOptions) (io.ReadCloser, error) {
		if !o.Previous || o.Follow || o.TailLines == nil {
			t.Errorf("previous options=%+v", o)
		}
		if o.Container == "none" {
			return nil, apierrors.NewBadRequest("no previous")
		}
		return textBody(line(1, "previous")), nil
	}
	p := targetParams()
	p.Previous = true
	out, end, _ := start(t, f, g, p)
	e := awaitEnd(t, end)
	r, _ := out.snapshot()
	if e.Reason != protocol.StreamEndReasonComplete || len(r) != 1 || string(r[0].content) != "previous" {
		t.Fatalf("previous run: end=%+v records=%s", e, describe(r))
	}
}

func TestLogRestartAndCrashLoop(t *testing.T) {
	p := pod("pod", "main")
	f, g := newFake(p)
	firstR, firstW := io.Pipe()
	secondR, secondW := io.Pipe()
	var mu sync.Mutex
	calls := 0
	f.open = func(_ context.Context, _ string, o *corev1.PodLogOptions) (io.ReadCloser, error) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		if calls == 1 {
			return firstR, nil
		}
		if calls == 2 {
			if o.SinceTime == nil {
				t.Error("stale running EOF did not resume")
			}
			return secondR, nil
		}
		// The old run is read once more when its status changed only after its
		// response ended. It has nothing more to give.
		if o.SinceTime != nil {
			return textBody(""), nil
		}
		return textBody(line(3, "new run")), nil
	}
	out, end, cancel := start(t, f, g, targetParams())
	awaitRequest(t, f)
	if _, err := io.WriteString(firstW, line(1, "first")+line(2, "last")); err != nil {
		t.Fatal(err)
	}
	firstW.Close()
	awaitRequest(t, f)
	r, _ := out.await(t, func(r []record, _ protocol.LogStreamStatus) bool { return len(r) >= 2 })
	if len(r) != 2 || r[0].flags != 0 || r[1].flags != 0 {
		t.Fatalf("stale running EOF replayed or exited: %s", describe(r))
	}
	waiting := p.DeepCopy()
	waiting.Status.ContainerStatuses[0].State = corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}}
	waiting.Status.ContainerStatuses[0].LastTerminationState = corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ContainerID: "main-1", Reason: "Error", ExitCode: 1}}
	f.update(waiting)
	secondW.Close()
	out.await(t, func(r []record, s protocol.LogStreamStatus) bool {
		return len(r) == 3 && r[2].flags == protocol.LogRecordFlagExited && s.Sources[0].Reason == "CrashLoopBackOff"
	})
	// Whether the old run was read once more depends on which arrived first,
	// the end of its response or its new status. Either way that happened
	// before the exited record.
	for len(f.requests) > 0 {
		if request := <-f.requests; request.options.SinceTime == nil {
			t.Fatalf("read a new run before the old one was over: %+v", request.options)
		}
	}
	// A status change wakes the waiting reader, but the same finished instance
	// must stay closed through a later, observable watch/status boundary.
	waiting = waiting.DeepCopy()
	waiting.Status.ContainerStatuses[0].State.Waiting.Message = "backoff observed"
	f.update(waiting)
	out.await(t, func(_ []record, s protocol.LogStreamStatus) bool { return s.Sources[0].Message == "backoff observed" })
	if len(f.requests) != 0 {
		t.Fatal("opened a request during CrashLoopBackOff")
	}
	restarted := waiting.DeepCopy()
	restarted.Status.ContainerStatuses[0].State = corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Completed"}}
	restarted.Status.ContainerStatuses[0].ContainerID = "main-2"
	f.update(restarted)
	request := awaitRequest(t, f)
	if request.options.SinceTime != nil || request.options.TailLines != nil {
		t.Fatalf("new run was not read from start: %+v", request.options)
	}
	r, _ = out.await(t, func(r []record, _ protocol.LogStreamStatus) bool { return len(r) >= 5 })
	if string(r[2].content) != "Error, exit code 1" || string(r[3].content) != "new run" || string(r[4].content) != "Completed, exit code 0" {
		t.Fatalf("restart order=%s", describe(r))
	}
	cancel()
	awaitEnd(t, end)

	t.Run("new status before old response ends", func(t *testing.T) {
		original := pod("overlap", "main")
		f, g := newFake(original)
		oldReader, oldWriter := io.Pipe()
		var mu sync.Mutex
		calls := 0
		f.open = func(_ context.Context, _ string, o *corev1.PodLogOptions) (io.ReadCloser, error) {
			mu.Lock()
			defer mu.Unlock()
			calls++
			if calls == 1 {
				return oldReader, nil
			}
			return textBody(line(3, "new")), nil
		}
		timing := shortTiming
		timing.Status = 20 * time.Millisecond
		out, end, cancel := startTimed(t, f, g, targetParams(), timing)
		awaitRequest(t, f)
		_, err := io.WriteString(oldWriter, line(1, "old first"))
		if err != nil {
			t.Fatal(err)
		}
		out.await(t, func(r []record, _ protocol.LogStreamStatus) bool { return len(r) == 1 })
		next := original.DeepCopy()
		next.Status.ContainerStatuses[0].ContainerID = "main-2"
		next.Status.ContainerStatuses[0].LastTerminationState = corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ContainerID: "main-1", Reason: "Error", ExitCode: 1}}
		f.update(next)
		out.await(t, func(_ []record, s protocol.LogStreamStatus) bool {
			return len(s.Sources) == 1 && s.Sources[0].Previous && s.Sources[0].Instance == "main-1"
		})
		if _, err := io.WriteString(oldWriter, line(2, "old last")); err != nil {
			t.Fatalf("old follow closed before its last line: %v", err)
		}
		_ = oldWriter.Close()
		r, _ := out.await(t, func(r []record, _ protocol.LogStreamStatus) bool { return len(r) >= 4 })
		if string(r[0].content) != "old first" || string(r[1].content) != "old last" || r[2].flags != protocol.LogRecordFlagExited || string(r[3].content) != "new" {
			t.Fatalf("old response did not drain before new run: %s", describe(r))
		}
		cancel()
		awaitEnd(t, end)
	})
}

func TestLogResumeTable(t *testing.T) {
	for _, tt := range []struct {
		name, instance, body   string
		previous, failPrevious bool
		want                   string
	}{
		{"none", "", line(3, "fresh"), false, false, "fresh"},
		{"same-present", "main-2", line(2, "held") + line(3, "new") + line(1, "later"), false, false, "new|later"},
		{"same-rotated", "main-2", line(3, "new"), false, false, "gap|new"},
		{"previous", "main-1", line(2, "held") + line(3, "rest"), true, false, "rest|exited|current"},
		{"older", "main-0", line(3, "current"), false, false, "gap|current"},
		{"failed-previous", "main-1", "", true, true, "gap|current"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p := pod("pod", "main")
			p.Status.ContainerStatuses[0].ContainerID = "main-2"
			p.Status.ContainerStatuses[0].State = corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ContainerID: "main-2"}}
			p.Status.ContainerStatuses[0].LastTerminationState = corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ContainerID: "main-1", Reason: "Error", ExitCode: 1}}
			f, g := newFake(p)
			f.open = func(_ context.Context, _ string, o *corev1.PodLogOptions) (io.ReadCloser, error) {
				if o.Previous {
					if !tt.previous || o.Follow || o.SinceTime == nil {
						t.Errorf("previous resume options=%+v", o)
					}
					if tt.failPrevious {
						return nil, fmt.Errorf("missing old run")
					}
					return textBody(tt.body), nil
				}
				if tt.previous {
					if o.SinceTime != nil || o.TailLines != nil {
						t.Errorf("current did not start at beginning: %+v", o)
					}
					return textBody(line(4, "current")), nil
				}
				if tt.instance == "main-2" && (o.SinceTime == nil || o.SinceTime.Nanosecond() != 0) {
					t.Errorf("sinceTime not whole-second: %+v", o)
				}
				return textBody(tt.body), nil
			}
			params := targetParams()
			if tt.instance != "" {
				params.Resume = []protocol.LogCursor{{PodUID: "pod", Container: "main", Instance: tt.instance, Time: "1767225600000000002"}}
			}
			out, end, cancel := start(t, f, g, params)
			r, _ := out.await(t, func(r []record, _ protocol.LogStreamStatus) bool {
				return len(r) >= len(strings.Split(tt.want, "|"))+1 && r[len(r)-1].flags == protocol.LogRecordFlagExited
			})
			parts := []string{}
			for _, r := range r[:len(r)-1] {
				switch r.flags {
				case protocol.LogRecordFlagGap:
					parts = append(parts, "gap")
				case protocol.LogRecordFlagExited:
					parts = append(parts, "exited")
				default:
					parts = append(parts, string(r.content))
				}
			}
			if strings.Join(parts, "|") != tt.want {
				t.Fatalf("resume %s=%s want %s", tt.name, strings.Join(parts, "|"), tt.want)
			}
			cancel()
			awaitEnd(t, end)
		})
	}
}

func TestLogLongLine(t *testing.T) {
	input := line(1, strings.Repeat("x", 4<<20)) + line(2, "next")
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	var records []record
	if err := readLines(strings.NewReader(input), func(int) {}, func(r record) { records = append(records, r) }); err != nil {
		t.Fatal(err)
	}
	runtime.ReadMemStats(&after)
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > 512<<10 {
		t.Fatalf("reader allocated %d bytes for one long line, want bounded buffers", allocated)
	}
	if len(records) != 2 || len(records[0].content) != 64<<10 || records[0].flags != protocol.LogRecordFlagCut || string(records[1].content) != "next" {
		t.Fatalf("bounded long line: records=%s length=%d", describe(records), len(records[0].content))
	}
	// readLines has one 64 KiB bufio buffer and a 64 KiB + 64 byte prefix;
	// its traffic callback confirms the overlong remainder is drained.
	var volume int
	_ = readLines(strings.NewReader(input), func(n int) { volume += n }, func(record) {})
	if volume != len(input) {
		t.Fatalf("drained %d bytes, want %d", volume, len(input))
	}
}

func TestLogResponseErrorAndUntimedLines(t *testing.T) {
	f, g := newFake(pod("pod", "main"))
	f.open = func(context.Context, string, *corev1.PodLogOptions) (io.ReadCloser, error) {
		return textBody("kubelet error text"), nil
	}
	out, end, cancel := start(t, f, g, targetParams())
	awaitRequest(t, f)
	r, s := out.await(t, func(_ []record, s protocol.LogStreamStatus) bool {
		return len(s.Sources) == 1 && s.Sources[0].Error != ""
	})
	if len(r) != 0 || s.Sources[0].Error != "kubelet error text" {
		t.Fatalf("200 error emitted as line: %s %+v", describe(r), s)
	}
	cancel()
	awaitEnd(t, end)
	var lines []record
	if err := readLines(strings.NewReader("no time\n"+strings.TrimSuffix(line(2, "last"), "\n")), func(int) {}, func(r record) { lines = append(lines, r) }); err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 || lines[0].time != 0 || string(lines[1].content) != "last" {
		t.Fatalf("untimed or final timed line=%s", describe(lines))
	}

	partial := []record{}
	err := readLines(io.MultiReader(strings.NewReader(strings.TrimSuffix(line(4, "partial"), "\n")), failedRead{}), func(int) {}, func(r record) { partial = append(partial, r) })
	if !errors.Is(err, io.ErrUnexpectedEOF) || len(partial) != 0 {
		t.Fatalf("partial failed response was sent as a line: error=%v records=%s", err, describe(partial))
	}
}

type failedRead struct{}

func (failedRead) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestLogStuckFollow(t *testing.T) {
	f, g := newFake(pod("pod", "main"))
	var mu sync.Mutex
	calls := 0
	f.open = func(ctx context.Context, _ string, o *corev1.PodLogOptions) (io.ReadCloser, error) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		if calls == 1 {
			r, w := io.Pipe()
			// A cancelled request fails its read, as client-go's does.
			go func() {
				_, _ = io.WriteString(w, line(1, strings.Repeat("x", 100)))
				<-ctx.Done()
				w.CloseWithError(ctx.Err())
			}()
			return r, nil
		}
		if o.SinceTime == nil {
			t.Error("stuck request did not resume")
		}
		return textBody(line(3, "after rotation")), nil
	}
	out, end, cancel := start(t, f, g, targetParams())
	awaitRequest(t, f)
	awaitRequest(t, f)
	r, _ := out.await(t, func(r []record, _ protocol.LogStreamStatus) bool { return len(r) >= 3 })
	if r[1].flags != protocol.LogRecordFlagGap || string(r[2].content) != "after rotation" {
		t.Fatalf("stuck follow resume=%s", describe(r))
	}
	cancel()
	awaitEnd(t, end)
	// Opening a stuck follow again is the Engine's own doing, not a failure
	// to read the container's logs.
	out.mu.Lock()
	defer out.mu.Unlock()
	for _, status := range out.statuses {
		for _, source := range status.Sources {
			if source.Error != "" {
				t.Fatalf("a stuck follow was reported as an error: %q", source.Error)
			}
		}
	}
}

func TestLogMergeAndRollout(t *testing.T) {
	a, b := pod("a", "main"), pod("b", "main")
	f, g := newFake(a, b)
	f.open = func(_ context.Context, name string, _ *corev1.PodLogOptions) (io.ReadCloser, error) {
		if name == "a" {
			return textBody(line(3, "a3") + "untimed\n" + line(1, "a1")), nil
		}
		return textBody(line(2, name+"2")), nil
	}
	out, end, cancel := start(t, f, g, targetParams())
	r, _ := out.await(t, func(r []record, _ protocol.LogStreamStatus) bool { return len(r) >= 4 })
	if got := strings.Join([]string{string(r[0].content), string(r[1].content), string(r[2].content), string(r[3].content)}, "|"); got != "b2|a3|untimed|a1" {
		t.Fatalf("merged container order=%s", got)
	}
	c := pod("c", "main")
	f.update(c)
	g.mu.Lock()
	g.owned = []relationship.Node{node(b), node(c)}
	g.mu.Unlock()
	g.signal.Notify()
	out.await(t, func(r []record, s protocol.LogStreamStatus) bool {
		names := []string{}
		for _, source := range s.Sources {
			names = append(names, source.Pod)
		}
		return slices.Contains(names, "c") && !slices.Contains(names, "a") && s.Followed == 2 && len(r) >= 5
	})
	cancel()
	awaitEnd(t, end)

	t.Run("leading untimed record", func(t *testing.T) {
		f, g := newFake(pod("a", "main"), pod("b", "main"))
		f.open = func(_ context.Context, name string, _ *corev1.PodLogOptions) (io.ReadCloser, error) {
			if name == "a" {
				return textBody("untimed\n" + line(1, "a1")), nil
			}
			return textBody(line(2, "b2")), nil
		}
		out, end, cancel := start(t, f, g, targetParams())
		r, _ := out.await(t, func(r []record, _ protocol.LogStreamStatus) bool { return len(r) >= 3 })
		got := strings.Join([]string{string(r[0].content), string(r[1].content), string(r[2].content)}, "|")
		if got != "untimed|a1|b2" {
			t.Fatalf("leading untimed line blocked timestamp merge: %s", got)
		}
		cancel()
		awaitEnd(t, end)
	})
}

func TestLogPodLimit(t *testing.T) {
	all := []*corev1.Pod{}
	for i := 0; i < 23; i++ {
		p := pod(fmt.Sprintf("pod-%02d", i), "main")
		p.CreationTimestamp = metav1.NewTime(time.Unix(int64(i), 0))
		all = append(all, p)
	}
	f, g := newFake(all...)
	out, end, cancel := start(t, f, g, targetParams())
	_, s := out.await(t, func(_ []record, s protocol.LogStreamStatus) bool {
		return s.Pods == 23 && s.Followed == 20 && len(s.Sources) == 20
	})
	for _, source := range s.Sources {
		if source.Pod < "pod-03" {
			t.Fatalf("followed old Pod %s", source.Pod)
		}
	}
	newPod := pod("pod-new", "main")
	f.update(newPod)
	g.mu.Lock()
	g.owned = append(g.owned, node(newPod))
	g.mu.Unlock()
	g.signal.Notify()
	_, s = out.await(t, func(_ []record, s protocol.LogStreamStatus) bool { return s.Pods == 24 })
	for _, source := range s.Sources {
		if source.Pod == "pod-new" {
			t.Fatal("new Pod displaced a followed Pod")
		}
	}
	g.mu.Lock()
	g.owned = slices.DeleteFunc(g.owned, func(n relationship.Node) bool { return n.Meta.Name == "pod-22" })
	g.mu.Unlock()
	g.signal.Notify()
	_, s = out.await(t, func(_ []record, s protocol.LogStreamStatus) bool {
		for _, source := range s.Sources {
			if source.Pod == "pod-new" {
				return s.Followed == 20
			}
		}
		return false
	})
	for _, source := range s.Sources {
		if source.Pod == "pod-22" {
			t.Fatal("deleted followed Pod retained")
		}
	}
	cancel()
	awaitEnd(t, end)
}

func TestLogTargetStates(t *testing.T) {
	for _, tt := range []struct {
		state  protocol.TypeState
		reason protocol.StreamEndReason
		code   protocol.ErrorCode
	}{
		{protocol.TypeStateForbidden, protocol.StreamEndReasonError, protocol.ErrorCodeForbidden},
		{protocol.TypeStateFailed, protocol.StreamEndReasonError, protocol.ErrorCodeInternal},
		{protocol.TypeStateReady, protocol.StreamEndReasonDeleted, ""},
	} {
		t.Run(string(tt.state), func(t *testing.T) {
			f, g := newFake()
			f.typeState = tt.state
			g.found = false
			out, end, _ := start(t, f, g, targetParams())
			e := awaitEnd(t, end)
			_, s := out.snapshot()
			if e.Reason != tt.reason || (e.Error != nil && e.Error.Code != tt.code) || s.Sources == nil || s.Containers == nil {
				t.Fatalf("target state=%+v status=%+v", e, s)
			}
		})
	}
	t.Run("a target the index has not shown yet", func(t *testing.T) {
		f, g := newFake(pod("pod", "main"))
		g.found = false
		timing := shortTiming
		timing.Appear = deadline
		out, end, cancel := startTimed(t, f, g, targetParams(), timing)
		// The first status proves the stream looked the target up and went on waiting.
		out.await(t, func(_ []record, s protocol.LogStreamStatus) bool { return s.Sources != nil && !s.Ready })
		select {
		case e := <-end:
			t.Fatalf("ended before the target could appear: %+v", e)
		case <-time.After(10 * timing.Graph):
		}
		g.mu.Lock()
		g.found = true
		g.mu.Unlock()
		g.signal.Notify()
		out.await(t, func(_ []record, s protocol.LogStreamStatus) bool { return s.Ready && len(s.Sources) == 1 })
		// Once it has been seen, its absence means it was deleted.
		g.mu.Lock()
		g.found = false
		g.mu.Unlock()
		g.signal.Notify()
		if e := awaitEnd(t, end); e.Reason != protocol.StreamEndReasonDeleted {
			t.Fatalf("end after the target left=%+v", e)
		}
		cancel()
	})
	t.Run("a Resource that owns no Pods", func(t *testing.T) {
		f, g := newFake()
		out, end, cancel := start(t, f, g, targetParams())
		// Only Ready tells "owns no Pods" from "not looked up yet".
		_, s := out.await(t, func(_ []record, s protocol.LogStreamStatus) bool { return s.Ready })
		if s.Pods != 0 || len(s.Sources) != 0 {
			t.Fatalf("status of a Resource without Pods=%+v", s)
		}
		cancel()
		awaitEnd(t, end)
	})
	f, g := newFake(pod("pod", "main"))
	f.typeState = protocol.TypeStateSyncing
	out, end, cancel := start(t, f, g, targetParams())
	out.await(t, func(_ []record, s protocol.LogStreamStatus) bool { return s.Sources != nil })
	f.mu.Lock()
	f.typeState = protocol.TypeStateReady
	f.mu.Unlock()
	f.signal.Notify()
	out.await(t, func(_ []record, s protocol.LogStreamStatus) bool { return len(s.Sources) == 1 })
	cancel()
	awaitEnd(t, end)
}

func TestLogFrameGolden(t *testing.T) {
	frame := []byte{protocol.StreamChannelStdout}
	for _, r := range []record{{source: 7, time: 1767225600123456789, content: []byte("hello")}, {source: 7, flags: protocol.LogRecordFlagCut, time: -1, content: []byte{0xff, 0, 27}}, {source: 9, flags: protocol.LogRecordFlagGap}, {source: 9, flags: protocol.LogRecordFlagExited, content: []byte("Error, exit code 1")}} {
		before := len(frame)
		frame = appendRecord(frame, r)
		if header := len(frame) - before - len(r.content); header != protocol.LogRecordHeaderSize {
			t.Fatalf("record header is %d bytes, advertised %d", header, protocol.LogRecordHeaderSize)
		}
	}
	if os.Getenv("UPDATE_LOG_FRAME") == "1" {
		if err := os.WriteFile("../protocol/testdata/log-frame.golden", frame, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	written := filepath.Join(t.TempDir(), "log-frame.golden")
	if err := os.WriteFile(written, frame, 0o600); err != nil {
		t.Fatal(err)
	}
	golden, err := os.ReadFile("../protocol/testdata/log-frame.golden")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(frame, golden) {
		t.Fatalf("log frame layout differs from golden: got %x want %x", frame, golden)
	}
}

func TestLogStatusInterval(t *testing.T) {
	p := pod("pod", "main")
	p.Status.ContainerStatuses[0].LastTerminationState = corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ContainerID: "main-0"}}
	f, g := newFake(p)
	f.open = func(context.Context, string, *corev1.PodLogOptions) (io.ReadCloser, error) {
		return nil, fmt.Errorf("previous unavailable")
	}
	params := targetParams()
	params.Previous = true
	timing := shortTiming
	timing.Status = 40 * time.Millisecond
	out, end, _ := startTimed(t, f, g, params, timing)
	if e := awaitEnd(t, end); e.Reason != protocol.StreamEndReasonComplete {
		t.Fatalf("previous end=%+v", e)
	}
	out.mu.Lock()
	defer out.mu.Unlock()
	if len(out.statuses) < 3 || out.statuses[len(out.statuses)-1].Sources[0].Error != "previous unavailable" {
		t.Fatalf("final source error not delivered: %+v", out.statuses)
	}
	for i := 1; i < len(out.statusTimes); i++ {
		if interval := out.statusTimes[i].Sub(out.statusTimes[i-1]); interval < timing.Status {
			t.Fatalf("status interval=%s, want at least %s", interval, timing.Status)
		}
	}
}
