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

type execOutput struct {
	queue *streamQueue
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

func (o execOutput) WriteContext(ctx context.Context, data []byte) (int, error) {
	return o.queue.write(ctx, data)
}

func init() {
	handleMutationStream(protocol.StreamPodExec, execReadOnlyReason, func(ctx context.Context, s *Server, p protocol.ExecParams, q *streamQueue) protocol.StreamEnd {
		if p.Cluster == "" || p.Namespace == "" || p.Pod == "" || p.UID == "" || p.Container == "" || p.Cols == 0 || p.Rows == 0 {
			return streamError(badRequest(fmt.Errorf("cluster, namespace, pod, uid, container, cols, and rows are required")))
		}
		c, err := s.cfg.Clusters.Get(p.Cluster)
		if err != nil {
			return streamError(err)
		}
		ctx, cancel := context.WithCancel(ctx)
		defer cancel()
		running := &runningExec{cancel: cancel, done: make(chan struct{})}
		s.execMu.Lock()
		if s.shuttingDown {
			s.execMu.Unlock()
			return streamError(fmt.Errorf("the Engine is shutting down"))
		}
		if s.execs == nil {
			s.execs = make(map[*runningExec]struct{})
		}
		s.execs[running] = struct{}{}
		s.execMu.Unlock()
		defer func() { s.execMu.Lock(); delete(s.execs, running); close(running.done); s.execMu.Unlock() }()
		end := execsession.Run(ctx, execCluster{c}, c.Index, p, q.input, q.sizes, execOutput{q}, execsession.DefaultTiming)
		s.execMu.Lock()
		stopping := s.shuttingDown
		s.execMu.Unlock()
		if stopping {
			// The hang-up made the shell exit, which is not why the session ended.
			return streamError(&protocol.ErrorDetail{Code: protocol.ErrorCodeUnavailable, Reason: protocol.ExecReasonEngineStopped, Message: "The Engine shut down."})
		}
		return end
	})
}

type runningExec struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// Shutdown hangs up every Exec Session and waits within ctx's deadline. It
// then gives each session's socket until that deadline to deliver its end,
// so a client is told the Engine shut down instead of finding its socket gone.
func (s *Server) Shutdown(ctx context.Context) error {
	s.execMu.Lock()
	s.shuttingDown = true
	running := make([]*runningExec, 0, len(s.execs))
	for session := range s.execs {
		running = append(running, session)
		session.cancel()
	}
	sockets := make([]chan struct{}, 0, len(s.execSockets))
	for socket := range s.execSockets {
		sockets = append(sockets, socket)
	}
	s.execMu.Unlock()
	for _, session := range running {
		select {
		case <-session.done:
		case <-ctx.Done():
			return ctx.Err()
		}
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
