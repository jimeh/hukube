// Package relationship resolves ownership Relationships from indexed metadata.
package relationship

import (
	"cmp"
	"slices"
	"strings"
	"sync"

	"github.com/jimeh/hukube/engine/internal/index"
	"github.com/jimeh/hukube/engine/internal/protocol"
)

// Types supplies discovered Resource Types and their current indexing states.
type Types interface {
	Type(protocol.TypeKey) (protocol.ResourceType, bool)
	TypeForKind(group, kind string) (protocol.ResourceType, bool)
	TypesChanged() (<-chan struct{}, func())
}

// Node is one incarnation of an indexed Resource.
type Node struct {
	Type protocol.TypeKey
	Meta index.Meta
}

type identity struct {
	typ      protocol.TypeKey
	key, uid string
}

func (n Node) identity() identity { return identity{n.Type, n.Meta.Key(), n.Meta.UID} }

// Owner is a reference together with the Resource and status it resolves to.
// Node.Type is set when the kind is served, and Node.Meta only when found.
type Owner struct {
	Ref    index.OwnerRef
	Node   Node
	Status protocol.RelatedStatus
}

// Graph reads the index and discovered types without making Cluster requests.
type Graph struct {
	store *index.Store
	types Types
}

// New returns a graph backed by store and types.
func New(store *index.Store, types Types) *Graph { return &Graph{store, types} }

// Node returns the indexed incarnation at the given address.
func (g *Graph) Node(typ protocol.TypeKey, namespace, name string) (Node, bool) {
	m, ok := g.store.Get(typ, index.Key(namespace, name))
	return Node{typ, m}, ok
}

func (g *Graph) resolve(dependent Node, ref index.OwnerRef) Owner {
	owner := Owner{Ref: ref, Status: protocol.RelatedStatusUnserved}
	group, _, hasGroup := strings.Cut(ref.APIVersion, "/")
	if !hasGroup {
		group = ""
	}
	typ, ok := g.types.TypeForKind(group, ref.Kind)
	if !ok {
		return owner
	}
	owner.Node.Type = typ.Key
	switch typ.State {
	case protocol.TypeStateForbidden:
		owner.Status = protocol.RelatedStatusForbidden
		return owner
	case protocol.TypeStateFailed:
		owner.Status = protocol.RelatedStatusFailed
		return owner
	}
	namespace := ""
	if typ.Namespaced {
		namespace = dependent.Meta.Namespace
	}
	node, found := g.Node(typ.Key, namespace, ref.Name)
	switch {
	case found && node.Meta.UID == ref.UID:
		owner.Node, owner.Status = node, protocol.RelatedStatusFound
	case typ.State == protocol.TypeStateSyncing:
		owner.Status = protocol.RelatedStatusSyncing
	default:
		owner.Status = protocol.RelatedStatusMissing
	}
	return owner
}

// Owners resolves every owner reference, controller first, then by kind, name,
// and UID.
func (g *Graph) Owners(node Node) []Owner {
	owners := make([]Owner, 0, len(node.Meta.Owners))
	for _, ref := range node.Meta.Owners {
		owners = append(owners, g.resolve(node, ref))
	}
	slices.SortFunc(owners, func(a, b Owner) int {
		if a.Ref.Controller != b.Ref.Controller {
			if a.Ref.Controller {
				return -1
			}
			return 1
		}
		return cmp.Or(
			cmp.Compare(a.Ref.Kind, b.Ref.Kind),
			cmp.Compare(a.Ref.Name, b.Ref.Name),
			cmp.Compare(a.Ref.UID, b.Ref.UID),
			cmp.Compare(a.Ref.APIVersion, b.Ref.APIVersion),
		)
	})
	return owners
}

// Owned returns direct owned Resources whose references resolve to node. A
// Resource served under several types appears once, under the smallest key.
func (g *Graph) Owned(node Node) []Node {
	candidates, types := g.ownedCandidates(node)
	if len(candidates) == 0 {
		return nil
	}
	owned := make([]Node, 0, len(candidates))
	for _, resource := range candidates {
		owned = append(owned, Node{resource.Type, resource.Meta})
	}
	slices.SortFunc(owned, func(a, b Node) int {
		return cmp.Or(
			cmp.Compare(types[a.Type].Kind, types[b.Type].Kind),
			cmp.Compare(a.Type, b.Type),
			b.Meta.CreatedAt.Compare(a.Meta.CreatedAt),
			cmp.Compare(a.Meta.Name, b.Meta.Name),
			cmp.Compare(a.Meta.Namespace, b.Meta.Namespace),
			cmp.Compare(a.Meta.UID, b.Meta.UID),
		)
	})
	return owned
}

// ownedCandidates filters in place without sorting. Only candidates spanning
// several types need UID deduplication: one type cannot serve a UID twice.
func (g *Graph) ownedCandidates(node Node) ([]index.Resource, map[protocol.TypeKey]protocol.ResourceType) {
	candidates := g.store.OwnedBy(node.Meta.UID)
	if len(candidates) == 0 {
		return nil, nil
	}
	types := make(map[protocol.TypeKey]protocol.ResourceType)
	for _, resource := range candidates {
		if _, ok := types[resource.Type]; !ok {
			typ, ok := g.types.Type(resource.Type)
			if !ok {
				typ.State = protocol.TypeStateFailed
			}
			types[resource.Type] = typ
		}
	}
	var byUID map[string]index.Resource
	if len(types) > 1 {
		byUID = make(map[string]index.Resource)
	}
	owned := candidates[:0]
	for _, resource := range candidates {
		typ := types[resource.Type]
		if typ.State == protocol.TypeStateForbidden || typ.State == protocol.TypeStateFailed {
			continue
		}
		child := Node{resource.Type, resource.Meta}
		for _, ref := range child.Meta.Owners {
			owner := g.resolve(child, ref)
			if owner.Status != protocol.RelatedStatusFound || owner.Node.identity() != node.identity() {
				continue
			}
			if byUID == nil {
				owned = append(owned, resource)
			} else if old, ok := byUID[child.Meta.UID]; !ok || child.Type < old.Type {
				byUID[child.Meta.UID] = resource
			}
			break
		}
	}
	for _, resource := range byUID {
		owned = append(owned, resource)
	}
	return owned, types
}

// countOwned visits each descendant once without sorting or retaining its Meta.
func (g *Graph) countOwned(node Node) int {
	seen := map[identity]bool{node.identity(): true}
	var walk func(Node)
	walk = func(current Node) {
		candidates, _ := g.ownedCandidates(current)
		for _, resource := range candidates {
			child := Node{resource.Type, resource.Meta}
			id := child.identity()
			if seen[id] {
				continue
			}
			seen[id] = true
			walk(child)
		}
	}
	walk(node)
	return len(seen) - 1
}

// AllOwned returns every descendant once, breadth first, excluding node.
func (g *Graph) AllOwned(node Node) []Node {
	seen := map[identity]bool{node.identity(): true}
	result := []Node{}
	queue := []Node{node}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		for _, child := range g.Owned(current) {
			id := child.identity()
			if seen[id] {
				continue
			}
			seen[id] = true
			result = append(result, child)
			queue = append(queue, child)
		}
	}
	return result
}

// Changed signals after any index, type-set, or type-state change. Stop must
// be called when the subscriber no longer needs the graph.
func (g *Graph) Changed() (<-chan struct{}, func()) {
	indexChanged, stopIndex := g.store.Changed()
	typesChanged, stopTypes := g.types.TypesChanged()
	changed, done := make(chan struct{}, 1), make(chan struct{})
	go func() {
		for {
			select {
			case <-done:
				return
			case <-indexChanged:
			case <-typesChanged:
			}
			select {
			case changed <- struct{}{}:
			default:
			}
		}
	}()
	return changed, sync.OnceFunc(func() { close(done); stopIndex(); stopTypes() })
}

// The Facet bounds displayed rows independently of the complete graph.
const (
	MaxPerType    = 100
	MaxOwned      = 500
	MaxOwnerPaths = 50
)

// Limits bounds the Resources per type and owner, owned rows, and owner paths.
type Limits struct{ PerType, Owned, OwnerPaths int }

// DefaultLimits returns the limits of the Related Facet.
func DefaultLimits() Limits { return Limits{MaxPerType, MaxOwned, MaxOwnerPaths} }

// Related builds the owners and owned sections in display order.
func (g *Graph) Related(node Node, limits Limits) []protocol.RelatedSection {
	sections := []protocol.RelatedSection{}
	if len(node.Meta.Owners) > 0 {
		// A Resource that only names itself has no owner to show.
		if owners := g.ownerSection(node, limits.OwnerPaths); owners.Total > 0 {
			sections = append(sections, owners)
		}
	}
	if total := g.countOwned(node); total > 0 {
		sections = append(sections, g.ownedSection(node, limits, total))
	}
	return sections
}

func (g *Graph) row(node Node, status protocol.RelatedStatus) protocol.RelatedRow {
	typ, _ := g.types.Type(node.Type)
	created := node.Meta.CreatedAt
	return protocol.RelatedRow{
		Status:    status,
		Kind:      typ.Kind,
		Type:      node.Type,
		Namespace: node.Meta.Namespace,
		Name:      node.Meta.Name,
		UID:       node.Meta.UID,
		CreatedAt: &created,
	}
}

func (g *Graph) ownerRow(owner Owner) protocol.RelatedRow {
	if owner.Status == protocol.RelatedStatusFound {
		return g.row(owner.Node, owner.Status)
	}
	return protocol.RelatedRow{
		Status:     owner.Status,
		Kind:       owner.Ref.Kind,
		APIVersion: owner.Ref.APIVersion,
		Type:       owner.Node.Type,
		Name:       owner.Ref.Name,
		UID:        owner.Ref.UID,
	}
}

type branch struct {
	row      protocol.RelatedRow
	children []*branch
}

func flatten(branches []*branch, depth int, rows *[]protocol.RelatedRow) {
	for _, b := range branches {
		row := b.row
		row.Depth = depth
		*rows = append(*rows, row)
		flatten(b.children, depth+1, rows)
	}
}

func sameRow(a, b protocol.RelatedRow) bool {
	return a.Type == b.Type && a.Namespace == b.Namespace && a.Name == b.Name && a.UID == b.UID &&
		a.Kind == b.Kind && a.APIVersion == b.APIVersion && a.Status == b.Status
}

func (g *Graph) ownerSection(node Node, limit int) protocol.RelatedSection {
	section := protocol.RelatedSection{
		Relationship: protocol.RelationshipKindOwns,
		Direction:    protocol.RelatedDirectionIn,
		Rows:         []protocol.RelatedRow{},
	}
	paths := [][]protocol.RelatedRow{}
	var walk func(Node, []protocol.RelatedRow, map[identity]bool)
	finish := func(path []protocol.RelatedRow) {
		if len(paths) >= limit {
			section.Truncated = true
			return
		}
		reversed := slices.Clone(path)
		slices.Reverse(reversed)
		reversed = append(reversed, g.row(node, protocol.RelatedStatusSelf))
		paths = append(paths, reversed)
	}
	walk = func(current Node, path []protocol.RelatedRow, seen map[identity]bool) {
		if section.Truncated {
			return
		}
		owners := g.Owners(current)
		if len(owners) == 0 {
			finish(path)
			return
		}
		for _, owner := range owners {
			if section.Truncated {
				return
			}
			if owner.Status == protocol.RelatedStatusFound && seen[owner.Node.identity()] {
				finish(path)
				continue
			}
			next := append(slices.Clone(path), g.ownerRow(owner))
			if owner.Status != protocol.RelatedStatusFound {
				finish(next)
				continue
			}
			id := owner.Node.identity()
			seen[id] = true
			walk(owner.Node, next, seen)
			delete(seen, id)
		}
	}
	walk(node, nil, map[identity]bool{node.identity(): true})
	roots := []*branch{}
	uniqueRows := []protocol.RelatedRow{}
	for _, path := range paths {
		children := &roots
		for _, row := range path {
			if row.Status != protocol.RelatedStatusSelf && !slices.ContainsFunc(uniqueRows, func(r protocol.RelatedRow) bool {
				return sameRow(r, row)
			}) {
				uniqueRows = append(uniqueRows, row)
			}
			var found *branch
			for _, b := range *children {
				if sameRow(b.row, row) {
					found = b
					break
				}
			}
			if found == nil {
				found = &branch{row: row}
				*children = append(*children, found)
			}
			children = &found.children
		}
	}
	section.Total = len(uniqueRows)
	flatten(roots, 0, &section.Rows)
	return section
}

func (g *Graph) ownedSection(node Node, limits Limits, total int) protocol.RelatedSection {
	section := protocol.RelatedSection{
		Relationship: protocol.RelationshipKindOwns,
		Direction:    protocol.RelatedDirectionOut,
		Rows:         []protocol.RelatedRow{},
		Total:        total,
	}
	root := &branch{}
	type pending struct {
		node   Node
		parent *branch
		path   map[identity]bool
	}
	queue := []pending{{node, root, map[identity]bool{node.identity(): true}}}
	shown := 0
	for len(queue) > 0 {
		p := queue[0]
		queue = queue[1:]
		children := g.Owned(p.node)
		for start := 0; start < len(children); {
			end := start + 1
			for end < len(children) && children[end].Type == children[start].Type {
				end++
			}
			count, more := 0, 0
			for _, child := range children[start:end] {
				if p.path[child.identity()] {
					continue
				}
				if count >= limits.PerType || shown >= limits.Owned {
					more++
					continue
				}
				b := &branch{row: g.row(child, protocol.RelatedStatusFound)}
				p.parent.children = append(p.parent.children, b)
				next := make(map[identity]bool, len(p.path)+1)
				for id := range p.path {
					next[id] = true
				}
				next[child.identity()] = true
				queue = append(queue, pending{child, b, next})
				shown++
				count++
			}
			if more > 0 {
				typ, _ := g.types.Type(children[start].Type)
				p.parent.children = append(p.parent.children, &branch{row: protocol.RelatedRow{
					Status: protocol.RelatedStatusMore,
					Type:   typ.Key,
					Kind:   typ.Kind,
					More:   more,
				}})
				section.Truncated = true
			}
			start = end
		}
	}
	flatten(root.children, 0, &section.Rows)
	return section
}
