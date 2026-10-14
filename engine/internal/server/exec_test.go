package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/remotecommand"

	"github.com/jimeh/hukube/engine/internal/cluster"
	"github.com/jimeh/hukube/engine/internal/execsession"
	"github.com/jimeh/hukube/engine/internal/protocol"
	"github.com/jimeh/hukube/engine/internal/testenv"
)

type sessionExecutor func(context.Context, remotecommand.StreamOptions) error

func (f sessionExecutor) StreamWithContext(ctx context.Context, o remotecommand.StreamOptions) error {
	return f(ctx, o)
}
func replaceExecutor(t *testing.T, f func(*cluster.Cluster, protocol.ExecParams) (execsession.Executor, error)) {
	t.Helper()
	old := newPodExecutor
	newPodExecutor = f
	t.Cleanup(func() { newPodExecutor = old })
}
func pollExec(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.NewTimer(waitTimeout)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for !condition() {
		select {
		case <-deadline.C:
			t.Fatal("Exec Session did not reach the expected state")
		case <-tick.C:
		}
	}
}
func execServer(t *testing.T, pod *corev1.Pod) (*Server, *httptest.Server) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	source := testenv.Source{Config: cfg}
	log := slog.New(slog.DiscardHandler)
	manager := cluster.NewManager(ctx, source, log)
	c, err := manager.Get(testenv.ClusterID)
	if err != nil {
		t.Fatal(err)
	}
	pollExec(t, func() bool {
		meta, ok := c.Index.Get("pods", pod.Namespace+"/"+pod.Name)
		return ok && meta.UID == string(pod.UID)
	})
	srv := New(Config{Token: testToken, Source: source, Clusters: manager, Log: log})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	return srv, ts
}
func execPod(t *testing.T) *corev1.Pod {
	cs := kubernetes.NewForConfigOrDie(cfg)
	return createLogPod(t, cs, logNamespace(t, cs), "exec")
}
func execParams(p *corev1.Pod) protocol.ExecParams {
	return protocol.ExecParams{Cluster: testenv.ClusterID, Namespace: p.Namespace, Pod: p.Name, UID: string(p.UID), Container: "main", Session: "session", Window: "window", Start: true, Cols: 80, Rows: 24}
}
func openExec(c *streamClient, p protocol.ExecParams) {
	c.send(protocol.StreamClientMessage{Type: protocol.StreamClientTypeOpen, Method: protocol.StreamPodExec.Name, Params: params(p)})
}
func sendInput(c *streamClient, data []byte) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
	defer cancel()
	if err := c.conn.Write(ctx, websocket.MessageBinary, append([]byte{0}, data...)); err != nil {
		c.t.Fatal(err)
	}
}
func TestPodExecReadOnly(t *testing.T) {
	var built atomic.Int32
	replaceExecutor(t, func(*cluster.Cluster, protocol.ExecParams) (execsession.Executor, error) {
		built.Add(1)
		return nil, fmt.Errorf("must not run")
	})
	c := dialStream(t, newEditServer(t, cfg, true))
	// Read-only refusal precedes params decoding and any Cluster lookup.
	c.send(protocol.StreamClientMessage{Type: protocol.StreamClientTypeOpen, Method: protocol.StreamPodExec.Name, Params: json.RawMessage(`[]`)})
	end := awaitLogEnd(c)
	if end.Error == nil || end.Error.Code != protocol.ErrorCodeForbidden || end.Error.Message != execReadOnlyReason || built.Load() != 0 {
		t.Fatalf("read-only end=%+v built=%d", end, built.Load())
	}
}
func TestPodExecWireInputAndResize(t *testing.T) {
	got := make(chan []byte, 1)
	size := make(chan remotecommand.TerminalSize, 1)
	replaceExecutor(t, func(_ *cluster.Cluster, p protocol.ExecParams) (execsession.Executor, error) {
		return sessionExecutor(func(_ context.Context, o remotecommand.StreamOptions) error {
			first := o.TerminalSizeQueue.Next()
			if first.Width != p.Cols || first.Height != p.Rows {
				return fmt.Errorf("wrong first size")
			}
			data := make([]byte, 6)
			if _, err := io.ReadFull(o.Stdin, data); err != nil {
				return err
			}
			got <- data
			size <- *o.TerminalSizeQueue.Next()
			_, err := o.Stdout.Write(data)
			return err
		}), nil
	})
	p := execPod(t)
	_, ts := execServer(t, p)
	c := dialStream(t, ts)
	openExec(c, execParams(p))
	sendInput(c, []byte("abc"))
	sendInput(c, []byte("def"))
	c.send(protocol.StreamClientMessage{Type: protocol.StreamClientTypeResize, Cols: 132, Rows: 43})
	var output []byte
	var ack uint64
	for {
		m, frame := c.read(true)
		if len(frame) > 0 {
			if frame[0] != 1 {
				t.Fatalf("output channel=%d", frame[0])
			}
			output = append(output, frame[1:]...)
		}
		if m.Type == protocol.StreamServerTypeAck {
			ack = m.Bytes
		}
		if m.End != nil {
			if m.End.ExitCode == nil || *m.End.ExitCode != 0 {
				t.Fatalf("end=%+v", m.End)
			}
			break
		}
	}
	if string(output) != "abcdef" || ack != 6 || string(<-got) != "abcdef" || (<-size) != (remotecommand.TerminalSize{Width: 132, Height: 43}) {
		t.Fatalf("output=%q ack=%d", output, ack)
	}
}
func TestPodExecInputWindowDoesNotBlockAcks(t *testing.T) {
	next := make(chan struct{})
	replaceExecutor(t, func(*cluster.Cluster, protocol.ExecParams) (execsession.Executor, error) {
		return sessionExecutor(func(ctx context.Context, o remotecommand.StreamOptions) error {
			chunk := make([]byte, (32<<10)-1)
			for range 32 {
				if _, err := o.Stdout.Write(chunk); err != nil {
					return err
				}
				select {
				case <-next:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			_, _ = o.Stdout.Write([]byte("after ack"))
			<-ctx.Done()
			return ctx.Err()
		}), nil
	})
	p := execPod(t)
	_, ts := execServer(t, p)
	c := dialStream(t, ts)
	openExec(c, execParams(p))
	for range 32 {
		for {
			_, frame := c.read(false)
			if len(frame) == 0 {
				continue
			}
			if len(frame) != 32<<10 {
				t.Fatalf("output frame=%d", len(frame))
			}
			break
		}
		next <- struct{}{}
	}
	for range protocol.ExecInputWindow / protocol.ExecInputFrame {
		sendInput(c, make([]byte, protocol.ExecInputFrame))
	}
	c.send(protocol.StreamClientMessage{Type: protocol.StreamClientTypeAck, Bytes: c.consumed})
	for {
		_, frame := c.read(true)
		if len(frame) == 0 {
			continue
		}
		if string(frame[1:]) != "after ack" {
			t.Fatalf("output acknowledgement was blocked: %q", frame)
		}
		break
	}
	sendInput(c, []byte{42})
	end := awaitLogEnd(c)
	if end.Error == nil || end.Error.Code != protocol.ErrorCodeBadRequest {
		t.Fatalf("input overflow=%+v", end)
	}
}
func TestPodExecHangupAndShutdown(t *testing.T) {
	for _, shutdown := range []bool{false, true} {
		t.Run(fmt.Sprint(shutdown), func(t *testing.T) {
			started, hangup := make(chan struct{}), make(chan byte, 1)
			replaceExecutor(t, func(*cluster.Cluster, protocol.ExecParams) (execsession.Executor, error) {
				return sessionExecutor(func(ctx context.Context, o remotecommand.StreamOptions) error {
					close(started)
					data := make([]byte, 1)
					_, err := io.ReadFull(o.Stdin, data)
					if err != nil {
						return err
					}
					hangup <- data[0]
					if ctx.Err() != nil {
						return fmt.Errorf("executor cancelled before hang-up")
					}
					return nil
				}), nil
			})
			p := execPod(t)
			srv, ts := execServer(t, p)
			c := dialStream(t, ts)
			openExec(c, execParams(p))
			awaitSignal(t, started)
			if shutdown {
				ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
				defer cancel()
				if err := srv.Shutdown(ctx); err != nil {
					t.Fatal(err)
				}
				// Shutdown returned only once the session's socket had sent its end.
				srv.execMu.Lock()
				open := len(srv.execSockets)
				srv.execMu.Unlock()
				if open != 0 {
					t.Fatalf("%d session sockets still had something to send", open)
				}
			} else {
				_ = c.conn.CloseNow()
				if err := srv.execs.End(protocol.ExecEndParams{Cluster: testenv.ClusterID, Session: "session"}); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case b := <-hangup:
				if b != 4 {
					t.Fatalf("hang-up byte=%d", b)
				}
			case <-time.After(waitTimeout):
				t.Fatal("hang-up not delivered")
			}
			if !shutdown {
				return
			}
			// The shell exited because of the hang-up, and the client is told why.
			for {
				m, _ := c.read(true)
				if m.End == nil {
					continue
				}
				if m.End.Reason != protocol.StreamEndReasonError || m.End.Error == nil || m.End.Error.Reason != protocol.ExecReasonEngineStopped {
					t.Fatalf("end=%+v error=%+v", m.End, m.End.Error)
				}
				return
			}
		})
	}
}
func TestLogStreamRefusesInput(t *testing.T) {
	for _, binary := range []bool{false, true} {
		t.Run(fmt.Sprint(binary), func(t *testing.T) {
			replaceLogOpener(t, func(_ *cluster.Cluster, ctx context.Context, _, _ string, _ *corev1.PodLogOptions) (io.ReadCloser, error) {
				r, w := io.Pipe()
				go func() { <-ctx.Done(); _ = w.Close() }()
				return r, nil
			})
			p := execPod(t)
			_, ts := execServer(t, p)
			c := dialStream(t, ts)
			openLogs(c, logParams(p))
			awaitLogStatus(c, func(s protocol.LogStreamStatus) bool { return s.Ready })
			if binary {
				sendInput(c, []byte{42})
			} else {
				c.send(protocol.StreamClientMessage{Type: protocol.StreamClientTypeResize, Cols: 80, Rows: 24})
			}
			end := awaitLogEnd(c)
			if end.Error == nil || end.Error.Code != protocol.ErrorCodeBadRequest {
				t.Fatalf("Log Stream input=%+v", end)
			}
		})
	}
}
func TestPodExecInvalidInput(t *testing.T) {
	for _, kind := range []string{"channel", "frame", "resize"} {
		t.Run(kind, func(t *testing.T) {
			started := make(chan struct{})
			replaceExecutor(t, func(*cluster.Cluster, protocol.ExecParams) (execsession.Executor, error) {
				return sessionExecutor(func(ctx context.Context, _ remotecommand.StreamOptions) error {
					close(started)
					<-ctx.Done()
					return ctx.Err()
				}), nil
			})
			p := execPod(t)
			_, ts := execServer(t, p)
			c := dialStream(t, ts)
			openExec(c, execParams(p))
			awaitSignal(t, started)
			switch kind {
			case "frame":
				sendInput(c, make([]byte, protocol.ExecInputFrame+1))
			case "resize":
				c.send(protocol.StreamClientMessage{Type: protocol.StreamClientTypeResize, Cols: 0, Rows: 24})
			case "channel":
				ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
				defer cancel()
				if err := c.conn.Write(ctx, websocket.MessageBinary, []byte{1, 42}); err != nil {
					t.Fatal(err)
				}
			}
			end := awaitLogEnd(c)
			if end.Error == nil || end.Error.Code != protocol.ErrorCodeBadRequest {
				t.Fatalf("invalid input=%+v", end)
			}
		})
	}
}

func TestPodExecShutdownDeadline(t *testing.T) {
	started, hangup, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	defer close(release)
	replaceExecutor(t, func(*cluster.Cluster, protocol.ExecParams) (execsession.Executor, error) {
		return sessionExecutor(func(ctx context.Context, o remotecommand.StreamOptions) error {
			close(started)
			data := make([]byte, 1)
			if _, err := io.ReadFull(o.Stdin, data); err != nil {
				return err
			}
			close(hangup)
			<-release
			return ctx.Err()
		}), nil
	})
	p := execPod(t)
	srv, ts := execServer(t, p)
	c := dialStream(t, ts)
	openExec(c, execParams(p))
	awaitSignal(t, started)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := srv.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("shutdown deadline=%v", err)
	}
	awaitSignal(t, hangup)
}

func TestInputAcknowledgementsCoalesce(t *testing.T) {
	q := newStreamQueue(defaultStreamLimits)
	q.acknowledgeInput(1)
	q.acknowledgeInput(5)
	q.frame([]byte{protocol.StreamChannelStdout, 'x'}, 0)
	q.acknowledgeInput(9)
	var got []uint64
	for {
		item, ready, _, _ := q.next()
		if !ready {
			break
		}
		if item.msg.Type == protocol.StreamServerTypeAck {
			got = append(got, item.msg.Bytes)
		}
	}
	// The second total replaced the first, and data kept its place between them.
	if !slices.Equal(got, []uint64{5, 9}) {
		t.Fatalf("acknowledgements=%v", got)
	}
}
