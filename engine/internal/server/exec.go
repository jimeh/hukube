package server

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jimeh/hukube/engine/internal/cluster"
	"github.com/jimeh/hukube/engine/internal/execsession"
	"github.com/jimeh/hukube/engine/internal/protocol"
)

var newPodExecutor = (*cluster.Cluster).Exec

type execCluster struct{ *cluster.Cluster }

func (c execCluster) Exec(p protocol.ExecParams) (execsession.Executor, error) {
	return newPodExecutor(c.Cluster, p)
}

// handleMutationStream registers a stream that changes a Cluster and takes
// input. In read-only mode it ends with reason before decoding params.
func handleMutationStream[P, E any](method protocol.Stream[P, E], reason string, handler func(context.Context, *Server, P, *streamQueue) protocol.StreamEnd) {
	if _, exists := streams[method.Name]; exists {
		panic("server: duplicate stream handler " + method.Name)
	}
	streamInputs[method.Name] = true
	streams[method.Name] = func(ctx context.Context, s *Server, raw json.RawMessage, q *streamQueue) protocol.StreamEnd {
		if s.cfg.ReadOnly {
			return streamError(&protocol.ErrorDetail{Code: protocol.ErrorCodeForbidden, Message: reason})
		}
		p, err := decode[P](raw)
		if err != nil {
			return streamError(err)
		}
		return handler(ctx, s, p, q)
	}
}

func init() {
	handleMutationStream(protocol.StreamPodExec, execReadOnlyReason, func(ctx context.Context, s *Server, p protocol.ExecParams, q *streamQueue) protocol.StreamEnd {
		if p.Cluster == "" || p.Namespace == "" || p.Pod == "" || p.UID == "" || p.Container == "" || p.Session == "" || p.Window == "" || (p.Cols == 0) != (p.Rows == 0) {
			return streamError(badRequest(fmt.Errorf("cluster, namespace, pod, uid, container, session, window, and a complete size are required")))
		}
		c, err := s.cfg.Clusters.Get(p.Cluster)
		if err != nil {
			return streamError(err)
		}
		if ctx.Err() != nil {
			return protocol.StreamEnd{Reason: protocol.StreamEndReasonDetached}
		}
		a, err := s.execs.Open(p, execCluster{c}, c.Index, q.signal, q.acknowledgeInput)
		if err != nil {
			return streamError(err)
		}
		q.mu.Lock()
		q.attachment = a
		close(q.attached)
		q.mu.Unlock()
		q.signal()
		<-ctx.Done()
		a.Detach()
		return protocol.StreamEnd{Reason: protocol.StreamEndReasonDetached}
	})
	handleMutation(protocol.RequestExecEnd, func(_ context.Context, s *Server, p protocol.ExecEndParams) (protocol.None, error) {
		if p.Cluster == "" || p.Session == "" {
			return protocol.None{}, badRequest(fmt.Errorf("cluster and session are required"))
		}
		return protocol.None{}, s.execs.End(p)
	})
}

// Shutdown hangs up every Exec Session and waits within ctx's deadline. It
// then gives each session's socket until that deadline to deliver its end,
// so a client is told the Engine shut down instead of finding its socket gone.
func (s *Server) Shutdown(ctx context.Context) error {
	s.execMu.Lock()
	sockets := make([]chan struct{}, 0, len(s.execSockets))
	for socket := range s.execSockets {
		sockets = append(sockets, socket)
	}
	s.execMu.Unlock()
	if err := s.execs.Shutdown(ctx); err != nil {
		return err
	}
	for _, socket := range sockets {
		select {
		case <-socket:
		case <-ctx.Done():
			// A client that does not read is no reason to fail a shutdown.
			return nil
		}
	}
	return nil
}

// trackExecSocket records a session's socket until the returned function is
// called, which is when its stream has nothing left to send.
func (s *Server) trackExecSocket() func() {
	done := make(chan struct{})
	s.execMu.Lock()
	if s.execSockets == nil {
		s.execSockets = make(map[chan struct{}]struct{})
	}
	s.execSockets[done] = struct{}{}
	s.execMu.Unlock()
	return func() {
		s.execMu.Lock()
		delete(s.execSockets, done)
		s.execMu.Unlock()
		close(done)
	}
}
