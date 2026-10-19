// Package execsession runs one interactive process in a Pod's container.
package execsession

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/tools/remotecommand"
	utilexec "k8s.io/client-go/util/exec"

	"github.com/jimeh/hukube/engine/internal/index"
	"github.com/jimeh/hukube/engine/internal/protocol"
)

type Executor interface {
	StreamWithContext(context.Context, remotecommand.StreamOptions) error
}
type Cluster interface {
	ExecAccess(context.Context, string, string) (protocol.Access, error)
	Exec(protocol.ExecParams) (Executor, error)
	ReadPod(context.Context, string, string) (*corev1.Pod, error)
}
type Index interface {
	Get(protocol.TypeKey, string) (index.Meta, bool)
	Changed(...protocol.TypeKey) (<-chan struct{}, func())
}

// Consumer accepts output under the executor's lifetime, including hang-up.
type Consumer interface {
	WriteContext(context.Context, []byte) (int, error)
}

type Timing struct{ Hangup, Settle, Poll time.Duration }

var DefaultTiming = Timing{Hangup: time.Second, Settle: 2 * time.Second, Poll: 200 * time.Millisecond}

func failure(err error) protocol.StreamEnd {
	var detail *protocol.ErrorDetail
	if !errors.As(err, &detail) {
		detail = &protocol.ErrorDetail{Code: protocol.ErrorCodeUnavailable, Message: err.Error()}
	}
	return protocol.StreamEnd{Reason: protocol.StreamEndReasonError, Error: detail}
}
func deleted() protocol.StreamEnd { return protocol.StreamEnd{Reason: protocol.StreamEndReasonDeleted} }

// Run owns the executor until it exits or is cancelled after a hang-up.
func Run(ctx context.Context, c Cluster, idx Index, p protocol.ExecParams, input *Input, sizes *Sizes, out Consumer, timing Timing) protocol.StreamEnd {
	defer input.Close()
	defer sizes.Close()
	changed, stop := idx.Changed("pods")
	defer stop()
	// The index is empty while the Engine lists Pods, at its start and whenever
	// it lists them again, so only the Cluster can say that a Pod is gone.
	present := func() bool {
		if meta, ok := idx.Get("pods", p.Namespace+"/"+p.Pod); ok {
			return meta.UID == p.UID
		}
		rctx, cancel := context.WithTimeout(ctx, timing.Settle)
		defer cancel()
		pod, err := c.ReadPod(rctx, p.Namespace, p.Pod)
		if err != nil {
			return !apierrors.IsNotFound(err)
		}
		return string(pod.UID) == p.UID
	}
	if !present() {
		return deleted()
	}
	access, err := c.ExecAccess(ctx, p.Namespace, p.Pod)
	if err != nil {
		return failure(err)
	}
	if !access.Allowed {
		return failure(&protocol.ErrorDetail{Code: protocol.ErrorCodeForbidden, Message: access.Reason})
	}
	if ctx.Err() != nil {
		return failure(ctx.Err())
	}
	// Access review may have taken long enough for the Pod to be replaced.
	if !present() {
		return deleted()
	}
	executor, err := c.Exec(p)
	if err != nil {
		return startFailure(err, len(p.Command) > 0)
	}
	sizes.Initial(p.Cols, p.Rows)
	ectx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	defer cancel()
	started := time.Now()
	output := &outputWriter{writer: out, ctx: ectx}
	result := make(chan error, 1)
	go func() {
		result <- executor.StreamWithContext(ectx, remotecommand.StreamOptions{Stdin: input, Stdout: output, Tty: true, TerminalSizeQueue: sizes})
	}()
	for {
		select {
		case <-ctx.Done():
			input.Hangup()
			timer := time.NewTimer(timing.Hangup)
			var err error
			select {
			case err = <-result:
				timer.Stop()
			case <-timer.C:
				cancel()
				input.Close()
				sizes.Close()
				err = <-result
			}
			return classify(ctx, c, p, started, err, output.seen.Load(), timing)
		case <-changed:
			if !present() {
				cancel()
				input.Close()
				sizes.Close()
				<-result
				return deleted()
			}
		case err := <-result:
			return classify(ctx, c, p, started, err, output.seen.Load(), timing)
		}
	}
}

type outputWriter struct {
	ctx    context.Context
	writer Consumer
	seen   atomic.Bool
}

func (w *outputWriter) Write(data []byte) (int, error) {
	if len(data) > 0 {
		w.seen.Store(true)
	}
	return w.writer.WriteContext(w.ctx, data)
}

func classify(ctx context.Context, c Cluster, p protocol.ExecParams, started time.Time, err error, output bool, timing Timing) protocol.StreamEnd {
	code := 0
	var exit utilexec.ExitError
	if err == nil || errors.As(err, &exit) {
		if exit != nil {
			code = exit.ExitStatus()
		}
		if code != 137 {
			return protocol.StreamEnd{Reason: protocol.StreamEndReasonComplete, ExitCode: &code}
		}
	} else if !output {
		return startFailure(err, len(p.Command) > 0)
	}
	if reason := settle(ctx, c, p, started, timing); reason != "" {
		return protocol.StreamEnd{Reason: reason}
	}
	if exit != nil {
		return protocol.StreamEnd{Reason: protocol.StreamEndReasonComplete, ExitCode: &code}
	}
	return failure(&protocol.ErrorDetail{Code: protocol.ErrorCodeUnavailable, Reason: protocol.ExecReasonConnectionLost, Message: err.Error()})
}
func settle(ctx context.Context, c Cluster, p protocol.ExecParams, started time.Time, timing Timing) protocol.StreamEndReason {
	ctx, cancel := context.WithTimeout(ctx, timing.Settle)
	defer cancel()
	for {
		pod, err := c.ReadPod(ctx, p.Namespace, p.Pod)
		if apierrors.IsNotFound(err) {
			return protocol.StreamEndReasonDeleted
		}
		if err == nil {
			if string(pod.UID) != p.UID || pod.DeletionTimestamp != nil {
				return protocol.StreamEndReasonDeleted
			}
			statuses := append(append([]corev1.ContainerStatus{}, pod.Status.ContainerStatuses...), pod.Status.InitContainerStatuses...)
			statuses = append(statuses, pod.Status.EphemeralContainerStatuses...)
			running := false
			for _, status := range statuses {
				if status.Name != p.Container {
					continue
				}
				running = status.State.Running != nil && !status.State.Running.StartedAt.After(started)
				break
			}
			if !running {
				return protocol.StreamEndReasonStopped
			}
		}
		timer := time.NewTimer(timing.Poll)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ""
		case <-timer.C:
		}
	}
}
func startFailure(err error, chosen bool) protocol.StreamEnd {
	message := err.Error()
	detail := &protocol.ErrorDetail{Code: protocol.ErrorCodeUnavailable, Message: message}
	switch {
	case strings.Contains(message, "is forbidden"):
		detail.Code = protocol.ErrorCodeForbidden
	case strings.Contains(message, "executable file not found"), strings.Contains(message, "no such file or directory"):
		detail.Code, detail.Reason = protocol.ErrorCodeNotFound, protocol.ExecReasonNoShell
		if chosen {
			detail.Reason = protocol.ExecReasonCommandNotFound
		}
	case strings.Contains(message, "is not valid for pod"):
		detail.Code = protocol.ErrorCodeNotFound
	default:
		for _, noun := range []string{"pods", "container"} {
			if at := strings.Index(message, noun); at >= 0 && strings.Contains(message[at:], "not found") {
				detail.Code = protocol.ErrorCodeNotFound
			}
		}
	}
	return failure(detail)
}
