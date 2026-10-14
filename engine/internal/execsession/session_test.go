package execsession

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/remotecommand"
	utilexec "k8s.io/client-go/util/exec"

	"github.com/jimeh/hukube/engine/internal/index"
	"github.com/jimeh/hukube/engine/internal/protocol"
)

type fakeExecutor func(context.Context, remotecommand.StreamOptions) error

func (f fakeExecutor) StreamWithContext(ctx context.Context, o remotecommand.StreamOptions) error {
	return f(ctx, o)
}

type fakeCluster struct {
	executor fakeExecutor
	pod      *corev1.Pod
	err      error
	access   protocol.Access
	built    int
	reads    atomic.Int32
}

func (c *fakeCluster) ExecAccess(context.Context, string, string) (protocol.Access, error) {
	return c.access, nil
}
func (c *fakeCluster) Exec(protocol.ExecParams) (Executor, error) { c.built++; return c.executor, nil }
func (c *fakeCluster) ReadPod(context.Context, string, string) (*corev1.Pod, error) {
	c.reads.Add(1)
	return c.pod, c.err
}

type testOutput struct{ io.Writer }

func (o testOutput) WriteContext(_ context.Context, data []byte) (int, error) {
	return o.Write(data)
}

var testParams = protocol.ExecParams{Cluster: "c", Namespace: "ns", Pod: "pod", UID: "uid", Container: "main", Cols: 80, Rows: 24}
var testTiming = Timing{Hangup: 100 * time.Millisecond, Settle: 15 * time.Millisecond, Poll: time.Millisecond}

func fixture(executor fakeExecutor) (*fakeCluster, *index.Store) {
	c := &fakeCluster{executor: executor, access: protocol.Access{Allowed: true}, pod: &corev1.Pod{ObjectMeta: metav1.ObjectMeta{UID: types.UID(testParams.UID)}, Status: corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{Name: "main", State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}}}}}
	idx := index.New()
	idx.Apply([]index.Change{{Kind: index.Added, Type: "pods", Meta: index.Meta{Namespace: "ns", Name: "pod", UID: "uid"}}})
	return c, idx
}
func receive[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(time.Second):
		t.Fatal("operation did not reach its completion boundary")
		var zero T
		return zero
	}
}
func TestExecEchoAndResize(t *testing.T) {
	got := make(chan []byte, 1)
	sizes := make(chan []remotecommand.TerminalSize, 1)
	c, idx := fixture(func(_ context.Context, o remotecommand.StreamOptions) error {
		if !o.Tty || o.Stderr != nil {
			return errors.New("expected one TTY output")
		}
		sizes <- []remotecommand.TerminalSize{*o.TerminalSizeQueue.Next(), *o.TerminalSizeQueue.Next()}
		data := make([]byte, 6)
		if _, err := io.ReadFull(o.Stdin, data); err != nil {
			return err
		}
		if _, err := o.Stdout.Write(data); err != nil {
			return err
		}
		got <- data
		return nil
	})
	input, size := NewInput(nil), NewSizes()
	if !input.Write([]byte("abc")) || !input.Write([]byte("def")) {
		t.Fatal("input refused")
	}
	size.Resize(100, 30)
	size.Resize(132, 43)
	var output bytes.Buffer
	end := Run(context.Background(), c, idx, testParams, input, size, testOutput{&output}, testTiming)
	if end.ExitCode == nil || *end.ExitCode != 0 || output.String() != "abcdef" || string(receive(t, got)) != "abcdef" {
		t.Fatalf("echo=%q end=%+v", output.String(), end)
	}
	if actual := receive(t, sizes); !slices.Equal(actual, []remotecommand.TerminalSize{{Width: 80, Height: 24}, {Width: 132, Height: 43}}) {
		t.Fatalf("sizes=%v", actual)
	}
	if size.Next() != nil {
		t.Fatal("ended size queue stayed open")
	}
}
func TestExecExitClassification(t *testing.T) {
	for _, code := range []int{0, 3, 137} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			c, idx := fixture(func(context.Context, remotecommand.StreamOptions) error {
				if code == 0 {
					return nil
				}
				return utilexec.CodeExitError{Code: code}
			})
			end := Run(context.Background(), c, idx, testParams, NewInput(nil), NewSizes(), testOutput{io.Discard}, testTiming)
			if end.Reason != protocol.StreamEndReasonComplete || end.ExitCode == nil || *end.ExitCode != code {
				t.Fatalf("exit=%+v want %d", end, code)
			}
		})
	}
}
func TestExecPodClassification(t *testing.T) {
	for _, kind := range []string{"gone", "replaced", "deleting", "stopped", "restarted", "init", "ephemeral"} {
		t.Run(kind, func(t *testing.T) {
			c, idx := fixture(func(context.Context, remotecommand.StreamOptions) error { return utilexec.CodeExitError{Code: 137} })
			want := protocol.StreamEndReasonStopped
			switch kind {
			case "gone":
				c.err = apierrors.NewNotFound(schema.GroupResource{Resource: "pods"}, "pod")
				want = protocol.StreamEndReasonDeleted
			case "replaced":
				c.pod.UID = "other"
				want = protocol.StreamEndReasonDeleted
			case "deleting":
				now := metav1.Now()
				c.pod.DeletionTimestamp = &now
				want = protocol.StreamEndReasonDeleted
			case "stopped":
				c.pod.Status.ContainerStatuses[0].State.Running = nil
			case "restarted":
				c.pod.Status.ContainerStatuses[0].State.Running.StartedAt = metav1.NewTime(time.Now().Add(time.Hour))
			case "init":
				c.pod.Status.InitContainerStatuses = c.pod.Status.ContainerStatuses
				c.pod.Status.ContainerStatuses = nil
				c.pod.Status.InitContainerStatuses[0].State.Running = nil
			case "ephemeral":
				c.pod.Status.EphemeralContainerStatuses = c.pod.Status.ContainerStatuses
				c.pod.Status.ContainerStatuses = nil
				c.pod.Status.EphemeralContainerStatuses[0].State.Running = nil
			}
			end := Run(context.Background(), c, idx, testParams, NewInput(nil), NewSizes(), testOutput{io.Discard}, testTiming)
			if end.Reason != want || end.ExitCode != nil {
				t.Fatalf("end=%+v want %s", end, want)
			}
		})
	}
}
func TestExecStartFailures(t *testing.T) {
	for _, tt := range []struct {
		message string
		code    protocol.ErrorCode
		reason  string
	}{
		{`unable to upgrade connection: pods "x" is forbidden: User "u" cannot create resource "pods/exec"`, protocol.ErrorCodeForbidden, ""},
		{`unable to upgrade streaming request: pods "x" not found`, protocol.ErrorCodeNotFound, ""},
		{`container "x" not found`, protocol.ErrorCodeNotFound, ""},
		{`container x is not valid for pod x`, protocol.ErrorCodeNotFound, ""},
		{`OCI runtime exec failed: exec: "sh": executable file not found in $PATH`, protocol.ErrorCodeNotFound, "NoShell"},
		{`exec /bin/sh: no such file or directory`, protocol.ErrorCodeNotFound, "NoShell"},
		{`connection refused`, protocol.ErrorCodeUnavailable, ""},
	} {
		t.Run(tt.message, func(t *testing.T) {
			c, idx := fixture(func(context.Context, remotecommand.StreamOptions) error { return errors.New(tt.message) })
			end := Run(context.Background(), c, idx, testParams, NewInput(nil), NewSizes(), testOutput{io.Discard}, testTiming)
			if end.Error == nil || end.Error.Code != tt.code || end.Error.Reason != tt.reason || end.Error.Message != tt.message {
				t.Fatalf("start failure=%+v", end)
			}
		})
	}
}
func TestExecConnectionLost(t *testing.T) {
	c, idx := fixture(func(_ context.Context, o remotecommand.StreamOptions) error {
		_, _ = o.Stdout.Write([]byte("started"))
		return errors.New("connection reset")
	})
	end := Run(context.Background(), c, idx, testParams, NewInput(nil), NewSizes(), testOutput{io.Discard}, testTiming)
	if end.Error == nil || end.Error.Code != protocol.ErrorCodeUnavailable || end.Error.Reason != "ConnectionLost" || end.Error.Message != "connection reset" {
		t.Fatalf("lost=%+v", end)
	}
}
func TestExecPreflight(t *testing.T) {
	for _, kind := range []string{"missing", "missing and replaced", "replaced", "denied"} {
		t.Run(kind, func(t *testing.T) {
			c, idx := fixture(nil)
			want := protocol.StreamEndReasonDeleted
			switch kind {
			case "missing":
				idx.RemoveType("pods")
				c.err = apierrors.NewNotFound(schema.GroupResource{Resource: "pods"}, "pod")
			case "missing and replaced":
				idx.RemoveType("pods")
				c.pod.UID = "other"
			case "replaced":
				idx.Apply([]index.Change{{Kind: index.Modified, Type: "pods", Meta: index.Meta{Namespace: "ns", Name: "pod", UID: "other"}}})
			case "denied":
				c.access = protocol.Access{Reason: "review says no"}
				want = protocol.StreamEndReasonError
			}
			end := Run(context.Background(), c, idx, testParams, NewInput(nil), NewSizes(), testOutput{io.Discard}, testTiming)
			if c.built != 0 || end.Reason != want {
				t.Fatalf("preflight built=%d end=%+v", c.built, end)
			}
			if kind == "denied" && (end.Error == nil || end.Error.Code != protocol.ErrorCodeForbidden || end.Error.Message != "review says no") {
				t.Fatalf("denial=%+v", end)
			}
		})
	}
}
func TestExecIndexDeletion(t *testing.T) {
	started, cancelled := make(chan struct{}), make(chan struct{})
	c, idx := fixture(func(ctx context.Context, _ remotecommand.StreamOptions) error {
		close(started)
		<-ctx.Done()
		close(cancelled)
		return ctx.Err()
	})
	done := make(chan protocol.StreamEnd, 1)
	go func() {
		done <- Run(context.Background(), c, idx, testParams, NewInput(nil), NewSizes(), testOutput{io.Discard}, testTiming)
	}()
	receive(t, started)
	c.err = apierrors.NewNotFound(schema.GroupResource{Resource: "pods"}, "pod")
	idx.RemoveType("pods")
	receive(t, cancelled)
	if end := receive(t, done); end.Reason != protocol.StreamEndReasonDeleted {
		t.Fatalf("deletion=%+v", end)
	}
}

// The Engine empties a type's index when it lists the type again. A Pod the
// Cluster still has is not gone.
func TestExecSurvivesAnEmptyIndex(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	c, idx := fixture(func(context.Context, remotecommand.StreamOptions) error {
		close(started)
		<-release
		return nil
	})
	idx.RemoveType("pods")
	done := make(chan protocol.StreamEnd, 1)
	go func() {
		done <- Run(context.Background(), c, idx, testParams, NewInput(nil), NewSizes(), testOutput{io.Discard}, testTiming)
	}()
	// The session started although the index had no Pods.
	receive(t, started)
	// Another Pod's change wakes the session, which asks the Cluster about its
	// own Pod again and carries on. The executor is released only after that
	// read, so an end that came from the read could not be mistaken for it.
	before := c.reads.Load()
	idx.Apply([]index.Change{{Kind: index.Added, Type: "pods", Meta: index.Meta{Namespace: "ns", Name: "other", UID: "other"}}})
	deadline := time.Now().Add(time.Second)
	for c.reads.Load() == before {
		if time.Now().After(deadline) {
			t.Fatal("the session did not ask the Cluster about its Pod")
		}
		timer := time.NewTimer(time.Millisecond)
		<-timer.C
	}
	select {
	case end := <-done:
		t.Fatalf("the session ended on an empty index: %+v", end)
	default:
	}
	close(release)
	if end := receive(t, done); end.Reason != protocol.StreamEndReasonComplete || end.ExitCode == nil || *end.ExitCode != 0 {
		t.Fatalf("end=%+v", end)
	}
}
func TestExecHangup(t *testing.T) {
	for _, exits := range []bool{true, false} {
		t.Run(fmt.Sprint(exits), func(t *testing.T) {
			started, read, cancelled := make(chan struct{}), make(chan []byte, 1), make(chan struct{})
			alive := make(chan bool, 1)
			release := make(chan struct{})
			c, idx := fixture(func(ctx context.Context, o remotecommand.StreamOptions) error {
				close(started)
				<-release
				data := make([]byte, 100)
				n, err := o.Stdin.Read(data)
				if err != nil {
					return err
				}
				read <- data[:n]
				alive <- ctx.Err() == nil
				if exits {
					return nil
				}
				<-ctx.Done()
				close(cancelled)
				return ctx.Err()
			})
			input := NewInput(nil)
			input.Write([]byte("must be discarded"))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan protocol.StreamEnd, 1)
			go func() { done <- Run(ctx, c, idx, testParams, input, NewSizes(), testOutput{io.Discard}, testTiming) }()
			receive(t, started)
			cancel()
			// Observe that Hangup replaced the queue before allowing the executor to read.
			deadline := time.Now().Add(time.Second)
			for {
				input.mu.Lock()
				hanging := input.hanging
				input.mu.Unlock()
				if hanging {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("hang-up did not start")
				}
				// Polling is bounded by observed input state, rather than a delay for completion.
				timer := time.NewTimer(time.Millisecond)
				<-timer.C
			}
			close(release)
			if got := receive(t, read); !bytes.Equal(got, []byte{4}) {
				t.Fatalf("hang-up input=%v", got)
			}
			if !receive(t, alive) {
				t.Fatal("executor context was cancelled before hang-up")
			}
			if !exits {
				receive(t, cancelled)
			}
			receive(t, done)
			if input.Write([]byte("late")) {
				t.Fatal("input accepted after hang-up")
			}
		})
	}
}

func TestExecInputWindow(t *testing.T) {
	ack := make(chan uint64, 1)
	input := NewInput(func(total uint64) { ack <- total })
	defer input.Close()
	for range protocol.ExecInputWindow / protocol.ExecInputFrame {
		if !input.Write(make([]byte, protocol.ExecInputFrame)) {
			t.Fatal("window refused input before full")
		}
	}
	if input.Write([]byte{42}) {
		t.Fatal("input beyond the window was accepted")
	}
	buffer := make([]byte, protocol.ExecInputFrame)
	if n, err := input.Read(buffer); err != nil || n != len(buffer) {
		t.Fatalf("read=%d error=%v", n, err)
	}
	if total := receive(t, ack); total != uint64(len(buffer)) {
		t.Fatalf("input ack=%d", total)
	}
	if !input.Write(buffer) {
		t.Fatal("acknowledged capacity was not released")
	}
}

// blockedOutput holds every write until its context ends, as a full window does.
type blockedOutput struct{ entered chan struct{} }

func (o blockedOutput) WriteContext(ctx context.Context, _ []byte) (int, error) {
	select {
	case o.entered <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return 0, ctx.Err()
}

func TestExecHangupDiscardsOutput(t *testing.T) {
	entered := make(chan struct{}, 1)
	// A process that cannot write its output never reads its input.
	c, idx := fixture(func(_ context.Context, o remotecommand.StreamOptions) error {
		if _, err := o.Stdout.Write([]byte("output")); err != nil {
			return err
		}
		data := make([]byte, 1)
		if _, err := o.Stdin.Read(data); err != nil {
			return err
		}
		if data[0] != 4 {
			return errors.New("expected end-of-transmission")
		}
		_, err := o.Stdout.Write([]byte("exit"))
		return err
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// The executor must return by itself, well before the hang-up gives up.
	timing := testTiming
	timing.Hangup = time.Minute
	done := make(chan protocol.StreamEnd, 1)
	go func() {
		done <- Run(ctx, c, idx, testParams, NewInput(nil), NewSizes(), blockedOutput{entered}, timing)
	}()
	receive(t, entered)
	cancel()
	if end := receive(t, done); end.Reason != protocol.StreamEndReasonComplete || end.ExitCode == nil || *end.ExitCode != 0 {
		t.Fatalf("end=%+v", end)
	}
}

func TestInputDuringHangupIsDropped(t *testing.T) {
	input := NewInput(nil)
	defer input.Close()
	input.Hangup()
	if !input.Write([]byte("late")) {
		t.Fatal("input during a hang-up was refused")
	}
	data := make([]byte, 8)
	if n, err := input.Read(data); err != nil || !bytes.Equal(data[:n], []byte{4}) {
		t.Fatalf("read=%v error=%v", data[:n], err)
	}
}
