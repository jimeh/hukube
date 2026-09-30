// Package notify provides a coalescing broadcast signal: listeners learn that
// something changed, not what, and bursts of notifications collapse into one.
package notify

import "sync"

// Signal broadcasts change notifications to any number of listeners. The zero
// value is ready to use.
type Signal struct {
	mu        sync.Mutex
	listeners map[chan struct{}]struct{}
}

// Subscribe returns a channel that receives a value after each Notify, with
// bursts coalesced, and a function that stops the subscription.
func (s *Signal) Subscribe() (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	s.mu.Lock()
	if s.listeners == nil {
		s.listeners = make(map[chan struct{}]struct{})
	}
	s.listeners[ch] = struct{}{}
	s.mu.Unlock()

	return ch, func() {
		s.mu.Lock()
		delete(s.listeners, ch)
		s.mu.Unlock()
	}
}

// Notify wakes every listener without blocking.
func (s *Signal) Notify() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.listeners {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}
