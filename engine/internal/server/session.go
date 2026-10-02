package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

const (
	readLimit    = 4 << 20
	writeTimeout = 10 * time.Second
)

// minEmitInterval bounds how often one subscription sends data. Changes that
// arrive faster are coalesced so the client only receives the latest state
// (see ADR-0004). A variable so tests can shorten it.
var minEmitInterval = 100 * time.Millisecond

// session serves one client's control socket.
type session struct {
	srv  *Server
	conn *websocket.Conn

	out *outbox

	// subs is only accessed by the read loop.
	subs map[uint64]*subscription
}

type subscription struct {
	cancel context.CancelFunc
	// params holds the latest unprocessed params; older ones are dropped.
	params chan json.RawMessage
}

func newSession(srv *Server, conn *websocket.Conn) *session {
	conn.SetReadLimit(readLimit)
	return &session{srv: srv, conn: conn, out: newOutbox(), subs: make(map[uint64]*subscription)}
}

func (s *session) run(ctx context.Context) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go s.writeLoop(ctx, cancel)

	defer func() {
		for _, sub := range s.subs {
			sub.cancel()
		}
	}()
	for {
		var msg protocol.ClientMessage
		if err := wsjson.Read(ctx, s.conn, &msg); err != nil {
			var syntaxErr *json.SyntaxError
			if errors.As(err, &syntaxErr) {
				s.conn.Close(websocket.StatusUnsupportedData, "invalid JSON")
			}
			return
		}
		s.handle(ctx, msg)
	}
}

func (s *session) handle(ctx context.Context, msg protocol.ClientMessage) {
	switch msg.Type {
	case protocol.ClientTypeRequest:
		handler, ok := requests[msg.Method]
		if !ok {
			s.out.error(msg.ID, badRequest(fmt.Errorf("unknown request %q", msg.Method)))
			return
		}
		go func() {
			result, err := handler(ctx, s.srv, msg.Params)
			if err != nil {
				s.out.error(msg.ID, err)
				return
			}
			s.out.push(protocol.ServerMessage{ID: msg.ID, Type: protocol.ServerTypeResult, Data: result})
		}()

	case protocol.ClientTypeSubscribe:
		t, ok := topics[msg.Method]
		if !ok {
			s.out.error(msg.ID, badRequest(fmt.Errorf("unknown topic %q", msg.Method)))
			return
		}
		if _, exists := s.subs[msg.ID]; exists {
			s.out.error(msg.ID, badRequest(fmt.Errorf("subscription %d already exists", msg.ID)))
			return
		}
		subCtx, cancel := context.WithCancel(ctx)
		sub := &subscription{cancel: cancel, params: make(chan json.RawMessage, 1)}
		sub.params <- msg.Params
		s.subs[msg.ID] = sub
		go s.runSubscription(subCtx, msg.ID, t, sub)

	case protocol.ClientTypeUpdate:
		sub, ok := s.subs[msg.ID]
		if !ok {
			return
		}
		select {
		case <-sub.params:
		default:
		}
		sub.params <- msg.Params

	case protocol.ClientTypeUnsubscribe:
		if sub, ok := s.subs[msg.ID]; ok {
			sub.cancel()
			delete(s.subs, msg.ID)
			s.out.drop(msg.ID)
		}

	default:
		s.out.error(msg.ID, badRequest(fmt.Errorf("unknown message type %q", msg.Type)))
	}
}

// runSubscription (re)starts the topic whenever params change and emits the
// latest value whenever the topic signals, at most once per minEmitInterval.
// A value identical to the last one sent is skipped, except the first value
// after a restart and the first after an error, which the client needs to
// learn the result of an update or to clear its error.
func (s *session) runSubscription(ctx context.Context, id uint64, t topic, sub *subscription) {
	wake := make(chan struct{}, 1)
	notify := func() {
		select {
		case wake <- struct{}{}:
		default:
		}
	}

	var live *liveValue
	defer func() {
		if live != nil {
			live.stop()
		}
	}()

	var (
		lastEmit time.Time
		lastSent json.RawMessage
	)
	fail := func(err error) {
		s.out.error(id, err)
		lastSent = nil
	}
	send := func(v any, err error) {
		switch {
		case err != nil:
			fail(err)
			return
		case v == nil:
			return
		}
		data, err := json.Marshal(v)
		if err != nil {
			fail(fmt.Errorf("encode data: %w", err))
			return
		}
		if bytes.Equal(data, lastSent) {
			return
		}
		lastSent = data
		s.out.latest(protocol.ServerMessage{ID: id, Type: protocol.ServerTypeData, Data: json.RawMessage(data)})
	}
	emit := func() {
		send(live.compute())
		lastEmit = time.Now()
	}

	for {
		select {
		case <-ctx.Done():
			return

		case params := <-sub.params:
			if live != nil {
				live.stop()
				live = nil
			}
			lastSent = nil
			lv, err := t(ctx, s.srv, params, notify)
			if err != nil {
				fail(err)
				continue
			}
			live = lv
			emit()

		case <-wake:
			if live == nil {
				continue
			}
			if wait := minEmitInterval - time.Since(lastEmit); wait > 0 {
				select {
				case <-ctx.Done():
					return
				case <-time.After(wait):
				}
			}
			if len(sub.params) > 0 {
				// New params supersede this value; handle them first.
				continue
			}
			emit()
		}
	}
}

func (s *session) writeLoop(ctx context.Context, cancel context.CancelFunc) {
	defer cancel()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.out.wake:
		}
		for _, msg := range s.out.take() {
			wctx, wcancel := context.WithTimeout(ctx, writeTimeout)
			err := wsjson.Write(wctx, s.conn, msg)
			wcancel()
			if err != nil {
				s.srv.cfg.Log.Debug("write control socket", "err", err)
				return
			}
		}
	}
}
