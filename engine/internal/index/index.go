// Package index holds the compact metadata the Engine keeps for every
// Resource of every indexed Resource Type in one Cluster.
package index

import (
	"sync"
	"time"

	"github.com/jimeh/hukube/engine/internal/notify"
	"github.com/jimeh/hukube/engine/internal/protocol"
)

// Meta is the metadata kept for one indexed Resource.
type Meta struct {
	UID             string
	Namespace       string
	Name            string
	CreatedAt       time.Time
	ResourceVersion string
}

// Key returns the Resource's namespace/name key, unique within its type.
func (m Meta) Key() string {
	if m.Namespace == "" {
		return m.Name
	}
	return m.Namespace + "/" + m.Name
}

// ChangeKind is the kind of an observed Change.
type ChangeKind int

const (
	Added ChangeKind = iota + 1
	Modified
	Deleted
)

// Change is one observed addition, modification, or deletion of a Resource.
// For deletions, Meta is the last known metadata.
type Change struct {
	Kind ChangeKind
	Type protocol.TypeKey
	Meta Meta
	Time time.Time
}

// Store indexes Resource metadata by Resource Type. It is safe for concurrent
// use.
type Store struct {
	mu      sync.RWMutex
	types   map[protocol.TypeKey]map[string]Meta
	changed notify.Signal
}

// New returns an empty Store.
func New() *Store {
	return &Store{types: make(map[protocol.TypeKey]map[string]Meta)}
}

// Apply records a batch of Changes and notifies listeners once.
func (s *Store) Apply(changes []Change) {
	if len(changes) == 0 {
		return
	}
	s.mu.Lock()
	for _, c := range changes {
		metas := s.types[c.Type]
		if metas == nil {
			metas = make(map[string]Meta)
			s.types[c.Type] = metas
		}
		if c.Kind == Deleted {
			delete(metas, c.Meta.Key())
		} else {
			metas[c.Meta.Key()] = c.Meta
		}
	}
	s.mu.Unlock()
	s.changed.Notify()
}

// Diff returns the Changes that turn the stored Resources of a type into
// metas, stamped with now. Resources whose ResourceVersion is unchanged
// produce no Change.
func (s *Store) Diff(t protocol.TypeKey, metas []Meta, now time.Time) []Change {
	s.mu.RLock()
	defer s.mu.RUnlock()

	current := s.types[t]
	seen := make(map[string]struct{}, len(metas))
	var changes []Change
	for _, m := range metas {
		key := m.Key()
		seen[key] = struct{}{}
		old, ok := current[key]
		switch {
		case !ok:
			changes = append(changes, Change{Kind: Added, Type: t, Meta: m, Time: now})
		case old.ResourceVersion != m.ResourceVersion:
			changes = append(changes, Change{Kind: Modified, Type: t, Meta: m, Time: now})
		}
	}
	for key, old := range current {
		if _, ok := seen[key]; !ok {
			changes = append(changes, Change{Kind: Deleted, Type: t, Meta: old, Time: now})
		}
	}
	return changes
}

// Get returns the stored metadata for one Resource.
func (s *Store) Get(t protocol.TypeKey, key string) (Meta, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, ok := s.types[t][key]
	return m, ok
}

// RemoveType drops every Resource of a type, such as when a CRD is deleted.
func (s *Store) RemoveType(t protocol.TypeKey) {
	s.mu.Lock()
	_, existed := s.types[t]
	delete(s.types, t)
	s.mu.Unlock()
	if existed {
		s.changed.Notify()
	}
}

// Count returns the number of Resources stored for a type.
func (s *Store) Count(t protocol.TypeKey) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.types[t])
}

// Each calls fn for every stored Resource of the given types, or of every
// type when types is nil, while holding a read lock. fn must not call back
// into the Store.
func (s *Store) Each(types []protocol.TypeKey, fn func(protocol.TypeKey, Meta)) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if types == nil {
		for t, metas := range s.types {
			for _, m := range metas {
				fn(t, m)
			}
		}
		return
	}
	for _, t := range types {
		for _, m := range s.types[t] {
			fn(t, m)
		}
	}
}

// Changed returns a channel that receives a value after the Store changes,
// with bursts coalesced, and a function that stops the subscription.
func (s *Store) Changed() (<-chan struct{}, func()) {
	return s.changed.Subscribe()
}
