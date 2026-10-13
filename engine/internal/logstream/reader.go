package logstream

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

// errStuck ends a follow that went silent after carrying a fast container.
var errStuck = errors.New("log follow went silent")

// maxErrorText bounds the error text of a response shown to a user.
const maxErrorText = 512

type containerSnapshot struct {
	node   string
	status corev1.ContainerStatus
}
type containerReader struct {
	s                         *stream
	id                        int
	namespace, pod, name, uid string
	ctx                       context.Context
	cancel                    context.CancelFunc
	done                      chan struct{}
	mu                        sync.Mutex
	snapshot                  containerSnapshot
	wake                      chan struct{}
	cursorInstance            string
	cursorTime                int64
	finished                  string
	delay                     time.Duration
}

func (s *stream) updatePod(pod *followedPod, manifest *corev1.Pod, initial <-chan struct{}) {
	names := []protocol.LogContainer{}
	statuses := map[string]corev1.ContainerStatus{}
	for _, status := range manifest.Status.ContainerStatuses {
		statuses[status.Name] = status
	}
	for _, status := range manifest.Status.InitContainerStatuses {
		statuses[status.Name] = status
	}
	for _, status := range manifest.Status.EphemeralContainerStatuses {
		statuses[status.Name] = status
	}
	for _, c := range manifest.Spec.Containers {
		names = append(names, protocol.LogContainer{Name: c.Name, Kind: protocol.LogContainerKindContainer})
	}
	for _, c := range manifest.Spec.InitContainers {
		names = append(names, protocol.LogContainer{Name: c.Name, Kind: protocol.LogContainerKindInit})
	}
	for _, c := range manifest.Spec.EphemeralContainers {
		names = append(names, protocol.LogContainer{Name: c.Name, Kind: protocol.LogContainerKindEphemeral})
	}
	pod.names = names
	for _, name := range names {
		if s.p.Container != "" && s.p.Container != name.Name {
			continue
		}
		r, ok := pod.readers[name.Name]
		if !ok {
			s.mu.Lock()
			if s.nextID > 65535 {
				s.mu.Unlock()
				s.fail(fmt.Errorf("log stream exhausted its source IDs"))
				return
			}
			id := s.nextID
			s.nextID++
			s.sources[id] = &sourceEntry{source: protocol.LogSource{ID: id, Pod: manifest.Name, PodUID: string(manifest.UID), Container: name.Name, State: protocol.LogSourceStateWaiting}}
			s.mu.Unlock()
			rctx, cancel := context.WithCancel(s.ctx)
			r = &containerReader{s: s, id: id, namespace: manifest.Namespace, pod: manifest.Name, name: name.Name, uid: string(manifest.UID), ctx: rctx, cancel: cancel, done: make(chan struct{}), wake: make(chan struct{}, 1), delay: s.t.RetryMin}
			for _, cursor := range s.p.Resume {
				if cursor.PodUID == r.uid && cursor.Container == r.name {
					r.cursorInstance = cursor.Instance
					r.cursorTime, _ = strconv.ParseInt(cursor.Time, 10, 64)
					break
				}
			}
			pod.readers[name.Name] = r
		}
		r.update(containerSnapshot{node: manifest.Spec.NodeName, status: statuses[name.Name]})
		if !ok {
			go func() {
				defer close(r.done)
				select {
				case <-initial:
					r.run()
				case <-r.ctx.Done():
				}
			}()
		}
	}
}

func current(s corev1.ContainerStatus) string {
	if s.State.Running != nil || s.State.Terminated != nil {
		return s.ContainerID
	}
	return previous(s)
}
func previous(s corev1.ContainerStatus) string {
	if s.LastTerminationState.Terminated != nil {
		return s.LastTerminationState.Terminated.ContainerID
	}
	return ""
}
func sourceState(s corev1.ContainerStatus) protocol.LogSourceState {
	if s.State.Running != nil {
		return protocol.LogSourceStateRunning
	}
	if s.State.Terminated != nil {
		return protocol.LogSourceStateTerminated
	}
	return protocol.LogSourceStateWaiting
}
func (r *containerReader) get() containerSnapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.snapshot
}
func (r *containerReader) update(snapshot containerSnapshot) {
	r.mu.Lock()
	r.snapshot = snapshot
	r.mu.Unlock()
	r.s.mu.Lock()
	if e, ok := r.s.sources[r.id]; ok {
		e.source.State = sourceState(snapshot.status)
		e.source.Reason = ""
		e.source.Message = ""
		e.source.ExitCode = nil
		e.source.Previous = previous(snapshot.status) != ""
		if w := snapshot.status.State.Waiting; w != nil {
			e.source.Reason = w.Reason
			e.source.Message = w.Message
		}
		if t := snapshot.status.State.Terminated; t != nil {
			e.source.Reason = t.Reason
			e.source.Message = t.Message
			code := t.ExitCode
			e.source.ExitCode = &code
		}
	}
	r.s.mu.Unlock()
	select {
	case r.wake <- struct{}{}:
	default:
	}
}
func (r *containerReader) settled() {
	r.s.mu.Lock()
	if e := r.s.sources[r.id]; e != nil {
		e.settled = true
	}
	r.s.mu.Unlock()
}
func (r *containerReader) setError(err error) {
	r.s.mu.Lock()
	defer r.s.mu.Unlock()
	if e := r.s.sources[r.id]; e != nil {
		e.source.Error = ""
		if err != nil {
			e.source.Error = err.Error()
		}
	}
}
func (r *containerReader) instance(instance string) {
	r.s.mu.Lock()
	if e := r.s.sources[r.id]; e != nil && e.source.Instance != instance {
		r.s.flushLocked()
		e.source.Instance = instance
	}
	r.s.mu.Unlock()
	// A new request waits for its source description, rather than holding back
	// an already open log response to respect the status interval.
	for r.ctx.Err() == nil {
		r.s.mu.Lock()
		wait := r.s.t.Status - time.Since(r.s.lastStatus)
		if wait <= 0 {
			r.s.statusLocked(true)
			r.s.mu.Unlock()
			return
		}
		r.s.mu.Unlock()
		timer := time.NewTimer(wait)
		select {
		case <-timer.C:
		case <-r.ctx.Done():
			timer.Stop()
			return
		}
	}
}
func (r *containerReader) gap() { r.s.add(r.id, record{flags: protocol.LogRecordFlagGap}) }
func (r *containerReader) exited(instance string) {
	s := r.get().status
	terminated := s.State.Terminated
	if terminated == nil || s.ContainerID != instance {
		terminated = s.LastTerminationState.Terminated
	}
	content := "Exited"
	if terminated != nil {
		content = fmt.Sprintf("%s, exit code %d", terminated.Reason, terminated.ExitCode)
	}
	r.s.add(r.id, record{flags: protocol.LogRecordFlagExited, content: []byte(content)})
	r.finished = instance
}

func (r *containerReader) wait(snapshot containerSnapshot, retry bool) {
	r.settled()
	var timer *time.Timer
	var timeout <-chan time.Time
	if retry {
		timer = time.NewTimer(r.delay)
		timeout = timer.C
		defer timer.Stop()
		r.delay = min(r.delay*2, r.s.t.RetryMax)
	}
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-timeout:
			return
		case <-r.wake:
			latest := r.get()
			if latest.node != snapshot.node || current(latest.status) != current(snapshot.status) || sourceState(latest.status) != sourceState(snapshot.status) {
				return
			}
		}
	}
}

func (r *containerReader) run() {
	if r.s.p.Previous {
		snapshot := r.get()
		r.instance(previous(snapshot.status))
		options := &corev1.PodLogOptions{Container: r.name, Timestamps: true, Previous: true, TailLines: &r.s.tail}
		_, err := r.read(options, "", 0)
		if apierrors.IsForbidden(err) || apierrors.IsUnauthorized(err) {
			r.s.fail(err)
		} else if err != nil && !apierrors.IsBadRequest(err) {
			r.setError(err)
		}
		r.settled()
		return
	}
	lastInstance := ""
	for r.ctx.Err() == nil {
		snapshot := r.get()
		instance := current(snapshot.status)
		if instance != lastInstance {
			r.delay = r.s.t.RetryMin
			lastInstance = instance
		}
		if snapshot.node == "" || instance == "" || instance == r.finished {
			r.wait(snapshot, false)
			continue
		}
		options := &corev1.PodLogOptions{Container: r.name, Timestamps: true, Follow: true}
		readInstance := instance
		if r.cursorInstance != "" && r.cursorInstance == previous(snapshot.status) && r.finished != r.cursorInstance {
			readInstance = r.cursorInstance
		}
		r.instance(readInstance)
		switch {
		case r.cursorInstance == "":
			options.TailLines = &r.s.tail
		case r.cursorInstance == instance:
			stamp := metav1.NewTime(time.Unix(0, r.cursorTime).Truncate(time.Second))
			options.SinceTime = &stamp
		case r.cursorInstance == previous(snapshot.status):
			if r.finished == r.cursorInstance {
				r.cursorInstance = ""
				r.cursorTime = 0
				break
			}
			r.instance(r.cursorInstance)
			stamp := metav1.NewTime(time.Unix(0, r.cursorTime).Truncate(time.Second))
			oldOptions := &corev1.PodLogOptions{Container: r.name, Timestamps: true, Previous: true, SinceTime: &stamp}
			_, err := r.read(oldOptions, r.cursorInstance, r.cursorTime)
			if apierrors.IsForbidden(err) || apierrors.IsUnauthorized(err) {
				r.s.fail(err)
				return
			}
			if err != nil {
				r.gap()
			} else {
				r.exited(r.cursorInstance)
			}
			r.cursorInstance = ""
			r.cursorTime = 0
		default:
			r.gap()
			r.cursorInstance = ""
			r.cursorTime = 0
		}
		r.instance(instance)
		_, err := r.read(options, instance, r.cursorTime)
		if r.ctx.Err() != nil {
			return
		}
		if errors.Is(err, errStuck) {
			r.delay = r.s.t.RetryMin
			continue
		}
		if apierrors.IsForbidden(err) || apierrors.IsUnauthorized(err) {
			r.s.fail(err)
			return
		}
		if err != nil && !apierrors.IsBadRequest(err) && !apierrors.IsNotFound(err) {
			r.setError(err)
		}
		latest := r.get()
		if err == nil && (current(latest.status) != instance || latest.status.State.Running == nil) {
			r.exited(instance)
		}
		// A response that ended while the status still says running is read
		// again after the wait, even if the status has changed by then: the
		// response may have been cut, and only another read shows the rest.
		r.wait(snapshot, true)
	}
}

func (r *containerReader) read(options *corev1.PodLogOptions, instance string, cursor int64) (bool, error) {
	ctx, cancel := context.WithCancel(r.ctx)
	defer cancel()
	body, err := r.s.c.OpenPodLogs(ctx, r.namespace, r.pod, options)
	if err != nil {
		return false, err
	}
	defer body.Close()
	r.setError(nil)
	var mu sync.Mutex
	start, last := time.Now(), time.Now()
	volume := 0
	fast := false
	monitorDone := make(chan struct{})
	defer close(monitorDone)
	stuckCh := make(chan struct{})
	var stuckOnce sync.Once
	go func() {
		timer := time.NewTicker(min(r.s.t.Batch, r.s.t.Silent))
		defer timer.Stop()
		for {
			select {
			case <-monitorDone:
				return
			case <-ctx.Done():
				body.Close()
				return
			case <-timer.C:
				mu.Lock()
				stuck := fast && time.Since(last) >= r.s.t.Silent
				mu.Unlock()
				snapshot := r.get()
				if stuck && snapshot.status.State.Running != nil {
					stuckOnce.Do(func() { close(stuckCh) })
					cancel()
					body.Close()
					return
				}
			}
		}
	}()
	traffic := func(n int) {
		if n == 0 {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		now := time.Now()
		if now.Sub(start) > r.s.t.FastWindow {
			start = now
			volume = 0
		}
		volume += n
		last = now
		if volume > r.s.t.FastBytes {
			fast = true
		}
	}
	resuming := options.SinceTime != nil
	firstTimed := true
	sent := false
	err = readLines(body, traffic, func(line record) {
		if line.time != 0 && resuming {
			if firstTimed {
				firstTimed = false
				if line.time > cursor {
					r.gap()
				}
			}
			if line.time <= cursor {
				return
			}
			resuming = false
		}
		if instance != "" && r.cursorInstance != instance {
			r.cursorInstance = instance
			r.cursorTime = 0
		}
		if line.time != 0 {
			r.cursorTime = max(r.cursorTime, line.time)
		}
		r.s.add(r.id, line)
		sent = true
		r.delay = r.s.t.RetryMin
	})
	select {
	case <-stuckCh:
		return sent, errStuck
	default:
	}
	var text *responseText
	if errors.As(err, &text) {
		// The kubelet's own error text, which can carry any bytes.
		message := strings.ToValidUTF8(text.text, "\uFFFD")
		if len(message) > maxErrorText {
			message = strings.ToValidUTF8(message[:maxErrorText], "") + "…"
		}
		return sent, errors.New(message)
	}
	return sent, err
}
