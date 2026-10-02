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
		wake(ch)
	}
}

// Keyed broadcasts change notifications for keys. A listener subscribes to
// some keys, or to every key, and is woken without blocking, before Notify
// returns, when a notification names one of them. Bursts are coalesced as for
// Signal. The zero value is ready to use.
type Keyed[K comparable] struct {
	mu    sync.Mutex
	all   map[chan struct{}]struct{}
	byKey map[K]map[chan struct{}]struct{}
}

// Subscribe returns a channel that receives a value after each Notify naming
// any of keys, or after every Notify when keys is empty, and a function that
// stops the subscription.
func (s *Keyed[K]) Subscribe(keys ...K) (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	s.mu.Lock()
	if len(keys) == 0 {
		if s.all == nil {
			s.all = make(map[chan struct{}]struct{})
		}
		s.all[ch] = struct{}{}
	} else {
		if s.byKey == nil {
			s.byKey = make(map[K]map[chan struct{}]struct{})
		}
		for _, k := range keys {
			listeners := s.byKey[k]
			if listeners == nil {
				listeners = make(map[chan struct{}]struct{})
				s.byKey[k] = listeners
			}
			listeners[ch] = struct{}{}
		}
	}
	s.mu.Unlock()

	return ch, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		delete(s.all, ch)
		for _, k := range keys {
			listeners := s.byKey[k]
			delete(listeners, ch)
			// Drop empty sets, so keys that come and go do not accumulate.
			if len(listeners) == 0 {
				delete(s.byKey, k)
			}
		}
	}
}

// Notify wakes every listener of any of keys, and every listener of all keys.
func (s *Keyed[K]) Notify(keys ...K) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.all {
		wake(ch)
	}
	for _, k := range keys {
		for ch := range s.byKey[k] {
			wake(ch)
		}
	}
}

func wake(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}
