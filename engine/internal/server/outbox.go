package server

import (
	"errors"
	"sync"

	"github.com/jimeh/hukube/engine/internal/cluster"
	"github.com/jimeh/hukube/engine/internal/kubeconfig"
	"github.com/jimeh/hukube/engine/internal/protocol"
)

// outbox buffers messages for the write loop. Responses and errors are sent
// in order; subscription data keeps only the latest value per subscription,
// so a slow client skips intermediate states instead of backing up.
type outbox struct {
	mu      sync.Mutex
	queue   []protocol.ServerMessage
	pending map[uint64]protocol.ServerMessage
	order   []uint64
	wake    chan struct{}
}

func newOutbox() *outbox {
	return &outbox{pending: make(map[uint64]protocol.ServerMessage), wake: make(chan struct{}, 1)}
}

func (o *outbox) push(msg protocol.ServerMessage) {
	o.mu.Lock()
	o.queue = append(o.queue, msg)
	o.mu.Unlock()
	o.signal()
}

func (o *outbox) latest(msg protocol.ServerMessage) {
	o.mu.Lock()
	if _, ok := o.pending[msg.ID]; !ok {
		o.order = append(o.order, msg.ID)
	}
	o.pending[msg.ID] = msg
	o.mu.Unlock()
	o.signal()
}

func (o *outbox) error(id uint64, err error) {
	o.push(protocol.ServerMessage{ID: id, Type: protocol.ServerTypeError, Error: toProtocolError(err)})
}

// drop discards pending data for a cancelled subscription.
func (o *outbox) drop(id uint64) {
	o.mu.Lock()
	delete(o.pending, id)
	o.mu.Unlock()
}

// take removes and returns every buffered message.
func (o *outbox) take() []protocol.ServerMessage {
	o.mu.Lock()
	defer o.mu.Unlock()
	msgs := o.queue
	o.queue = nil
	for _, id := range o.order {
		if msg, ok := o.pending[id]; ok {
			msgs = append(msgs, msg)
		}
	}
	clear(o.pending)
	o.order = o.order[:0]
	return msgs
}

func (o *outbox) signal() {
	select {
	case o.wake <- struct{}{}:
	default:
	}
}

func badRequest(err error) *protocol.ErrorDetail {
	return &protocol.ErrorDetail{Code: protocol.ErrorCodeBadRequest, Message: err.Error()}
}

func toProtocolError(err error) *protocol.ErrorDetail {
	var pe *protocol.ErrorDetail
	switch {
	case errors.As(err, &pe):
		return pe
	case errors.Is(err, kubeconfig.ErrUnknownCluster), errors.Is(err, cluster.ErrUnknownType):
		return &protocol.ErrorDetail{Code: protocol.ErrorCodeNotFound, Message: err.Error()}
	default:
		return &protocol.ErrorDetail{Code: protocol.ErrorCodeInternal, Message: err.Error()}
	}
}
