package execsession

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

const DefaultBuffer = 256 << 10
const DefaultUnattachedTimeout = 10 * time.Minute
const MaxSessions = 64
const OutputFrame = 32 << 10

const endedTimeout = time.Minute
const maxEnded = 256

type endedSession struct {
	id string
	at time.Time
}

// Registry owns Exec Sessions independently of their attached sockets.
type Registry struct {
	mu        sync.Mutex
	sessions  map[string]*Session
	hangingUp map[*Session]struct{}
	ended     []endedSession
	buffer    int
	timeout   time.Duration
	stopped   bool
}

func NewRegistry(buffer int, timeout time.Duration) *Registry {
	return &Registry{sessions: make(map[string]*Session), hangingUp: make(map[*Session]struct{}), buffer: buffer, timeout: timeout}
}

func (r *Registry) Open(p protocol.ExecParams, c Cluster, idx Index, wake func(), ack func(uint64)) (*Attachment, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped {
		return nil, &protocol.ErrorDetail{Code: protocol.ErrorCodeUnavailable, Reason: protocol.ExecReasonEngineStopped, Message: "The Engine shut down."}
	}
	if p.Start && (p.Cols == 0 || p.Rows == 0) {
		return nil, &protocol.ErrorDetail{Code: protocol.ErrorCodeBadRequest, Message: "Starting a session requires cols and rows."}
	}
	r.pruneEnded()
	if p.Start {
		for i, ended := range r.ended {
			if ended.id == p.Session {
				r.ended = append(r.ended[:i], r.ended[i+1:]...)
				return nil, &protocol.ErrorDetail{Code: protocol.ErrorCodeNotFound, Reason: protocol.ExecReasonSessionGone, Message: "This Exec Session is gone."}
			}
		}
	}
	s := r.sessions[p.Session]
	if s != nil && (s.params.Cluster != p.Cluster || s.params.Namespace != p.Namespace || s.params.Pod != p.Pod || s.params.UID != p.UID || s.params.Container != p.Container) {
		return nil, &protocol.ErrorDetail{Code: protocol.ErrorCodeBadRequest, Message: "The session belongs to another container."}
	}
	if s != nil {
		s.mu.Lock()
		over := s.end != nil
		s.mu.Unlock()
		if over && p.Start {
			r.removeLocked(s)
			s = nil
		}
	}
	if s == nil {
		if !p.Start {
			return nil, &protocol.ErrorDetail{Code: protocol.ErrorCodeNotFound, Reason: protocol.ExecReasonSessionGone, Message: "This Exec Session is gone."}
		}
		if len(r.sessions)+len(r.hangingUp) >= MaxSessions {
			return nil, &protocol.ErrorDetail{Code: protocol.ErrorCodeUnavailable, Reason: protocol.ExecReasonTooManySessions, Message: "The Engine runs at most 64 Exec Sessions."}
		}
		ctx, cancel := context.WithCancel(context.Background())
		s = &Session{params: p, ring: newRing(r.buffer), input: NewInput(nil), sizes: NewSizes(), cols: p.Cols, rows: p.Rows, cancel: cancel, done: make(chan struct{}), registry: r}
		s.ring.tracker.rows = int(p.Rows)
		r.sessions[p.Session] = s
		go s.run(ctx, c, idx)
	}
	return s.attach(p, wake, ack), nil
}

func (r *Registry) removeLocked(s *Session) {
	if r.sessions[s.params.Session] != s {
		return
	}
	delete(r.sessions, s.params.Session)
	s.mu.Lock()
	s.removed = true
	if s.end == nil {
		r.hangingUp[s] = struct{}{}
	}
	if s.timer != nil {
		s.timer.Stop()
	}
	s.cancel()
	s.mu.Unlock()
}
func (r *Registry) expire(s *Session) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s.mu.Lock()
	expired := s.attachment == nil && time.Since(s.detachedAt) >= r.timeout
	s.mu.Unlock()
	if expired {
		r.removeLocked(s)
	}
}
func (r *Registry) End(p protocol.ExecEndParams) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s := r.sessions[p.Session]; s != nil {
		if s.params.Cluster != p.Cluster {
			return &protocol.ErrorDetail{Code: protocol.ErrorCodeBadRequest, Message: "The session belongs to another Cluster."}
		}
		r.removeLocked(s)
	} else {
		r.pruneEnded()
		for i, ended := range r.ended {
			if ended.id == p.Session {
				r.ended = append(r.ended[:i], r.ended[i+1:]...)
				break
			}
		}
		if len(r.ended) == maxEnded {
			r.ended = r.ended[1:]
		}
		r.ended = append(r.ended, endedSession{id: p.Session, at: time.Now()})
	}
	return nil
}
func (r *Registry) pruneEnded() {
	for len(r.ended) > 0 && time.Since(r.ended[0].at) >= endedTimeout {
		r.ended = r.ended[1:]
	}
}
func (r *Registry) Shutdown(ctx context.Context) error {
	r.mu.Lock()
	r.stopped = true
	sessions := make([]*Session, 0, len(r.sessions)+len(r.hangingUp))
	for s := range r.hangingUp {
		sessions = append(sessions, s)
	}
	for _, s := range r.sessions {
		s.mu.Lock()
		s.stopping = true
		s.mu.Unlock()
		r.removeLocked(s)
		sessions = append(sessions, s)
	}
	r.mu.Unlock()
	for _, s := range sessions {
		select {
		case <-s.done:
		case <-ctx.Done():
			return fmt.Errorf("hang up Exec Sessions: %w", ctx.Err())
		}
	}
	return nil
}
