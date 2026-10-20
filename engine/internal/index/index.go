// Package index holds the compact metadata the Engine keeps for every
// Resource of every indexed Resource Type in one Cluster.
package index

import (
	"maps"
	"slices"
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
	// Labels must not be modified; they may be shared with the informer.
	Labels map[string]string
	// Owners must not be modified after the Meta is stored.
	Owners []OwnerRef
}

// OwnerRef is one of a Resource's owner references.
type OwnerRef struct {
	APIVersion string
	Kind       string
	Name       string
	UID        string
	Controller bool
}

// Ref identifies one indexed Resource within its Resource Type.
type Ref struct {
	Type protocol.TypeKey
	Key  string
}

// Resource pairs stored metadata with its Resource Type.
type Resource struct {
	Type protocol.TypeKey
	Meta Meta
}

// Key returns the Resource's namespace/name key, unique within its type.
func (m Meta) Key() string { return Key(m.Namespace, m.Name) }

// Key returns the key of the Resource with the given Namespace and name.
// Namespace is empty for cluster-scoped Resources.
func Key(namespace, name string) string {
	if namespace == "" {
		return name
	}
	return namespace + "/" + name
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
	mu    sync.RWMutex
	types map[protocol.TypeKey]map[string]Meta
	// owned maps an owner UID to the Resources whose references name it.
	owned   map[string]map[Ref]struct{}
	changed notify.Keyed[protocol.TypeKey]
}

// New returns an empty Store.
func New() *Store {
	return &Store{types: make(map[protocol.TypeKey]map[string]Meta), owned: make(map[string]map[Ref]struct{})}
}

// Apply records a batch of Changes and notifies listeners once.
func (s *Store) Apply(changes []Change) {
	if len(changes) == 0 {
		return
	}
	touched := make(map[protocol.TypeKey]struct{})
	s.mu.Lock()
	for _, c := range changes {
		touched[c.Type] = struct{}{}
		metas := s.types[c.Type]
		if metas == nil {
			metas = make(map[string]Meta)
			s.types[c.Type] = metas
		}
		ref := Ref{Type: c.Type, Key: c.Meta.Key()}
		s.removeOwners(ref, metas[ref.Key])
		if c.Kind == Deleted {
			delete(metas, c.Meta.Key())
		} else {
			metas[c.Meta.Key()] = c.Meta
			for _, owner := range c.Meta.Owners {
				if owner.UID == "" {
					continue
				}
				if s.owned[owner.UID] == nil {
					s.owned[owner.UID] = make(map[Ref]struct{})
				}
				s.owned[owner.UID][ref] = struct{}{}
			}
		}
	}
	s.mu.Unlock()
	s.changed.Notify(slices.Collect(maps.Keys(touched))...)
}

// removeOwners must be called with s.mu held.
func (s *Store) removeOwners(ref Ref, m Meta) {
	for _, owner := range m.Owners {
		set := s.owned[owner.UID]
		delete(set, ref)
		if len(set) == 0 {
			delete(s.owned, owner.UID)
		}
	}
}

// OwnedBy returns the Resources whose references name uid, in no particular
// order. The metadata is copied under the read lock; its labels and owners
// must not be modified.
func (s *Store) OwnedBy(uid string) []Resource {
	s.mu.RLock()
	defer s.mu.RUnlock()
	resources := make([]Resource, 0, len(s.owned[uid]))
	for ref := range s.owned[uid] {
		resources = append(resources, Resource{Type: ref.Type, Meta: s.types[ref.Type][ref.Key]})
	}
	return resources
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
	for key, m := range s.types[t] {
		s.removeOwners(Ref{Type: t, Key: key}, m)
	}
	delete(s.types, t)
	s.mu.Unlock()
	if existed {
		s.changed.Notify(t)
	}
}

// Count returns the number of Resources stored for a type.
func (s *Store) Count(t protocol.TypeKey) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.types[t])
}

// Total returns the number of Resources stored for the given types, or for
// every type when types is nil.
func (s *Store) Total(types []protocol.TypeKey) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	total := 0
	if types == nil {
		for _, metas := range s.types {
			total += len(metas)
		}
		return total
	}
	for _, t := range types {
		total += len(s.types[t])
	}
	return total
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

// Changed returns a channel that receives a value after Resources of any of
// the given types change, or after any change when no types are given, with
// bursts coalesced, and a function that stops the subscription. The channel
// is signalled before the method that made the change returns.
func (s *Store) Changed(types ...protocol.TypeKey) (<-chan struct{}, func()) {
	return s.changed.Subscribe(types...)
}
