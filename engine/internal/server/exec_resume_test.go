package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"testing/synctest"
	"time"

	"github.com/coder/websocket"
	corev1 "k8s.io/api/core/v1"

	"k8s.io/client-go/tools/remotecommand"

	"github.com/jimeh/hukube/engine/internal/cluster"
	"github.com/jimeh/hukube/engine/internal/execsession"
	"github.com/jimeh/hukube/engine/internal/index"
	"github.com/jimeh/hukube/engine/internal/protocol"
	"github.com/jimeh/hukube/engine/internal/testenv"
)

func awaitExecSync(c *streamClient) protocol.ExecSync {
	c.t.Helper()
	m, frame := c.read(false)
	if m.Type != protocol.StreamServerTypeEvent || len(frame) != 0 {
		c.t.Fatalf("first session message=%+v %q", m, frame)
	}
	raw, err := json.Marshal(m.Event)
	if err != nil {
		c.t.Fatal(err)
	}
	var sync protocol.ExecSync
	if err := json.Unmarshal(raw, &sync); err != nil {
		c.t.Fatal(err)
	}
	return sync
}

func TestPodExecResumeAndReceivedEnd(t *testing.T) {
	commands := make(chan []byte)
	written := make(chan struct{})
	replaceExecutor(t, func(*cluster.Cluster, protocol.ExecParams) (execsession.Executor, error) {
		return sessionExecutor(func(ctx context.Context, o remotecommand.StreamOptions) error {
			for {
				select {
				case data := <-commands:
					if data == nil {
						return nil
					}
					_, err := o.Stdout.Write(data)
					written <- struct{}{}
					if err != nil {
						return err
					}
				case <-ctx.Done():
					return ctx.Err()
				}
			}
		}), nil
	})
	p := execPod(t)
	srv, ts := execServer(t, p)
	first := dialStream(t, ts)
	params := execParams(p)
	openExec(first, params)
	awaitExecSync(first)
	commands <- []byte("before")
	<-written
	_, frame := first.read(true)
	if string(frame[1:]) != "before" {
		t.Fatalf("before=%q", frame)
	}
	_ = first.conn.CloseNow()
	pollExec(t, func() bool { srv.execMu.Lock(); defer srv.execMu.Unlock(); return len(srv.execSockets) == 0 })
	commands <- []byte("missed")
	<-written
	commands <- nil
	// The next socket observes the over session; starting was not repeated.
	params.Start = false
	resume := uint64(6)
	params.Resume = &resume
	second := dialStream(t, ts)
	openExec(second, params)
	if sync := awaitExecSync(second); sync.Offset != 6 || sync.Replay != 6 || sync.Reset {
		t.Fatal(sync)
	}
	_, frame = second.read(true)
	if string(frame[1:]) != "missed" {
		t.Fatalf("replay=%q", frame)
	}
	end := awaitLogEnd(second)
	if end.ExitCode == nil || *end.ExitCode != 0 {
		t.Fatalf("end=%+v", end)
	}
	// Abort the close handshake. Merely writing end cannot remove the session.
	_ = second.conn.CloseNow()
	pollExec(t, func() bool { srv.execMu.Lock(); defer srv.execMu.Unlock(); return len(srv.execSockets) == 0 })
	third := dialStream(t, ts)
	openExec(third, params)
	awaitExecSync(third)
	awaitLogEnd(third)
	if err := third.conn.Close(websocket.StatusNormalClosure, "received end"); err != nil {
		t.Fatal(err)
	}
	pollExec(t, func() bool { srv.execMu.Lock(); defer srv.execMu.Unlock(); return len(srv.execSockets) == 0 })
	gone := dialStream(t, ts)
	openExec(gone, params)
	if end := awaitLogEnd(gone); end.Error == nil || end.Error.Reason != protocol.ExecReasonSessionGone {
		t.Fatalf("received end did not remove session: %+v", end)
	}
}

func TestExecEndRequest(t *testing.T) {
	srv := New(Config{Token: testToken})
	p := protocol.ExecEndParams{Cluster: testenv.ClusterID, Session: "gone"}
	if _, err := requests[protocol.RequestExecEnd.Name](context.Background(), srv, params(p)); err != nil {
		t.Fatalf("idempotent end=%v", err)
	}
	srv.cfg.ReadOnly = true
	if _, err := requests[protocol.RequestExecEnd.Name](context.Background(), srv, params(p)); err == nil || toProtocolError(err).Code != protocol.ErrorCodeForbidden {
		t.Fatalf("read-only end=%v", err)
	}
}

type queueExecCluster struct{ executor sessionExecutor }

func (c queueExecCluster) ExecAccess(context.Context, string, string) (protocol.Access, error) {
	return protocol.Access{Allowed: true}, nil
}
func (c queueExecCluster) Exec(protocol.ExecParams) (execsession.Executor, error) {
	return c.executor, nil
}
func (c queueExecCluster) ReadPod(context.Context, string, string) (*corev1.Pod, error) {
	return nil, fmt.Errorf("unexpected Pod read")
}

func TestExecRingWindowAndDrain(t *testing.T) {
	for _, resume := range []bool{false, true} {
		t.Run(fmt.Sprint(resume), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				commands := make(chan []byte)
				written := make(chan struct{})
				c := queueExecCluster{executor: func(ctx context.Context, o remotecommand.StreamOptions) error {
					for {
						select {
						case data := <-commands:
							if data == nil {
								return nil
							}
							_, _ = o.Stdout.Write(data)
							written <- struct{}{}
						case <-ctx.Done():
							return ctx.Err()
						}
					}
				}}
				idx := index.New()
				idx.Apply([]index.Change{{Kind: index.Added, Type: "pods", Meta: index.Meta{Namespace: "ns", Name: "pod", UID: "uid"}}})
				r := execsession.NewRegistry(execsession.DefaultBuffer, execsession.DefaultUnattachedTimeout)
				defer func() {
					if err := r.Shutdown(context.Background()); err != nil {
						t.Error(err)
					}
				}()
				limits := defaultStreamLimits
				limits.drain = 10 * time.Second
				q := newStreamQueue(limits)
				a, err := r.Open(protocol.ExecParams{Cluster: "c", Namespace: "ns", Pod: "pod", UID: "uid", Container: "main", Session: "s", Window: "w", Start: true, Cols: 80, Rows: 24}, c, idx, q.signal, q.acknowledgeInput)
				if err != nil {
					t.Fatal(err)
				}
				q.attachment = a
				item, ready, _, _ := q.next()
				if !ready || item.msg.Type != protocol.StreamServerTypeEvent {
					t.Fatal("initial sync absent")
				}
				q.sent = 1 << 20 // The real acknowledged window is full.
				commands <- bytes.Repeat([]byte{'x'}, 2<<20)
				<-written
				if item, ready, _, _ := q.next(); ready || item.data != nil || len(q.items) != 0 || q.bytes != 0 {
					t.Fatal("full window pulled output from ring")
				}
				commands <- nil
				synctest.Wait()
				if _, ready, _, wait := q.next(); ready || wait != 10*time.Second {
					t.Fatalf("end did not drain: ready=%v wait=%v", ready, wait)
				}
				time.Sleep(9 * time.Second)
				if _, ready, _, _ := q.next(); ready {
					t.Fatal("end before drain elapsed")
				}
				if resume {
					if !q.acknowledge(1 << 20) {
						t.Fatal("ack refused")
					}
					item, ready, _, _ := q.next()
					sync, ok := item.msg.Event.(*protocol.ExecSync)
					if !ready || !ok || !sync.Reset || sync.Skipped != (2<<20)-execsession.DefaultBuffer {
						t.Fatalf("resumed sync=%+v", item)
					}
					for {
						item, ready, _, _ := q.next()
						if !ready {
							t.Fatal("ring failed to drain")
						}
						if item.msg.End != nil {
							break
						}
						if item.data == nil {
							t.Fatal("unexpected non-frame")
						}
						q.acknowledge(q.sent)
					}
				} else {
					time.Sleep(time.Second)
					item, ready, _, _ := q.next()
					if !ready || item.msg.End == nil || item.data != nil || item.msg.Gap != nil {
						t.Fatalf("drain end=%+v ready=%v", item, ready)
					}
				}
			})
		})
	}
}

func TestPodExecCancelledBeforeOpen(t *testing.T) {
	p := execPod(t)
	srv, _ := execServer(t, p)
	pending := execParams(p)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	q := newStreamQueue(defaultStreamLimits)
	q.attached = make(chan struct{})
	streams[protocol.StreamPodExec.Name](ctx, srv, params(pending), q)
	if q.attachment != nil {
		t.Fatal("cancelled handler opened a session")
	}
	pending.Start = false
	if a, err := srv.execs.Open(pending, nil, nil, func() {}, nil); err == nil {
		a.Detach()
		t.Fatal("cancelled handler retained a session")
	}
}
