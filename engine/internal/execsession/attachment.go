package execsession

import (
	"context"
	"sync"
	"time"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

// Session owns the process, retained output, and its sole attachment.
type Session struct {
	mu         sync.Mutex
	params     protocol.ExecParams
	ring       *ring
	input      *Input
	sizes      *Sizes
	cols, rows uint16
	attachment *Attachment
	end        *protocol.StreamEnd
	removed    bool
	stopping   bool
	cancel     context.CancelFunc
	done       chan struct{}
	registry   *Registry
	timer      *time.Timer
	detachedAt time.Time
}

func (s *Session) run(ctx context.Context, c Cluster, idx Index) {
	end := Run(ctx, c, idx, s.params, s.input, s.sizes, s, DefaultTiming)
	s.mu.Lock()
	if s.stopping {
		end = failure(&protocol.ErrorDetail{Code: protocol.ErrorCodeUnavailable, Reason: protocol.ExecReasonEngineStopped, Message: "The Engine shut down."})
	}
	s.end = &end
	if s.attachment != nil {
		s.attachment.wake()
	}
	close(s.done)
	s.mu.Unlock()
}
func (s *Session) WriteContext(_ context.Context, data []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ring.append(data)
	if s.attachment != nil {
		s.attachment.wake()
	}
	return len(data), nil
}

// Attachment keeps a window's position and input accounting apart from the
// session. A replaced attachment may finish closing without affecting its successor.
type Attachment struct {
	session             *Session
	window              string
	position, replayEnd uint64
	sync                bool
	detached            bool
	wake                func()
}

func (s *Session) attach(p protocol.ExecParams, wake func(), ack func(uint64)) *Attachment {
	s.mu.Lock()
	defer s.mu.Unlock()
	a := &Attachment{session: s, window: p.Window, sync: true, wake: wake}
	if p.Resume != nil {
		a.position = *p.Resume
	}
	if old := s.attachment; old != nil {
		if old.window != p.Window && !p.Takeover {
			a.detached = true
			return a
		}
		old.detached = true
		old.wake()
	}
	if s.timer != nil {
		s.timer.Stop()
	}
	s.attachment = a
	s.input.Attach(ack)
	if p.Cols != 0 {
		s.resize(p.Cols, p.Rows)
	}
	return a
}
func (a *Attachment) Detach() {
	s := a.session
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.attachment != a {
		return
	}
	a.detached = true
	s.attachment = nil
	s.input.Attach(nil)
	if s.removed {
		return
	}
	s.detachedAt = time.Now()
	s.timer = time.AfterFunc(s.registry.timeout, func() { s.registry.expire(s) })
}
func (a *Attachment) Write(data []byte) bool {
	s := a.session
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.attachment != a {
		return true
	}
	return s.input.Write(data)
}
func (s *Session) resize(cols, rows uint16) {
	if s.cols == cols && s.rows == rows {
		return
	}
	s.cols, s.rows = cols, rows
	s.sizes.Resize(cols, rows)
}
func (a *Attachment) Resize(cols, rows uint16) {
	s := a.session
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.attachment == a {
		s.resize(cols, rows)
	}
}

// Next pulls at most one frame. The socket calls it only when it can send
// output, except to observe an end or a detach without consuming output.
func (a *Attachment) Next(room, drained bool) (*protocol.ExecSync, []byte, *protocol.StreamEnd, bool) {
	s := a.session
	s.mu.Lock()
	defer s.mu.Unlock()
	if a.detached {
		return nil, nil, &protocol.StreamEnd{Reason: protocol.StreamEndReasonDetached}, true
	}
	over := s.end != nil
	if over && (drained || (!a.sync && a.position == s.ring.total)) {
		return nil, nil, s.end, true
	}
	if !room {
		return nil, nil, nil, over
	}
	if a.sync || a.position < s.ring.start {
		// A replay ends between characters too. An unfinished character at
		// the ring's end is live output, sent when the rest of it arrives.
		replayEnd := s.ring.total
		if !over {
			tail := s.ring.bytes(max(s.ring.start, s.ring.total-min(s.ring.total, 4)), 4)
			replayEnd -= uint64(len(tail) - characterEnd(tail))
		}
		r := a.position
		sync := &protocol.ExecSync{Offset: r, Cols: s.cols, Rows: s.rows}
		if r < s.ring.start || r > s.ring.total {
			cut, tracker, safe := s.ring.cut()
			if !safe {
				return nil, nil, nil, over
			}
			sync.Offset, sync.Reset, sync.Restore = cut, true, tracker.restore()
			sync.Skipped = cut
			if r <= s.ring.total {
				sync.Skipped -= r
			}
			if tracker.alt && s.rows > 1 {
				s.sizes.Nudge(s.cols, s.rows)
			}
		}
		a.position, a.replayEnd, a.sync = sync.Offset, max(sync.Offset, replayEnd), false
		sync.Replay = a.replayEnd - a.position
		return sync, nil, nil, over
	}
	end := s.ring.total
	if a.position < a.replayEnd {
		end = min(end, a.replayEnd)
	}
	data := s.ring.bytes(a.position, min(OutputFrame-1, int(end-a.position)))
	if !over || a.position+uint64(len(data)) < end {
		data = data[:characterEnd(data)]
	}
	if len(data) == 0 {
		return nil, nil, nil, over
	}
	a.position += uint64(len(data))
	return nil, append([]byte{protocol.StreamChannelStdout}, data...), nil, over
}

// ReceivedEnd removes an over session only after the socket's closing handshake.
func (a *Attachment) ReceivedEnd() {
	r, s := a.session.registry, a.session
	r.mu.Lock()
	defer r.mu.Unlock()
	s.mu.Lock()
	received := s.attachment == a && s.end != nil && !a.detached
	s.mu.Unlock()
	if received {
		r.removeLocked(s)
	}
}
