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
		return execsession.Run(ctx, execCluster{c}, c.Index, p, q.input, q.sizes, execOutput{q}, execsession.DefaultTiming)
	})
}

type runningExec struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// Shutdown hangs up every Exec Session and waits within ctx's deadline.
func (s *Server) Shutdown(ctx context.Context) error {
	s.execMu.Lock()
	s.shuttingDown = true
	running := make([]*runningExec, 0, len(s.execs))
	for session := range s.execs {
		running = append(running, session)
		session.cancel()
	}
	s.execMu.Unlock()
	for _, session := range running {
		select {
		case <-session.done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}
