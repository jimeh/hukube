package relationship

import (
	"encoding/json"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/jimeh/hukube/engine/internal/index"
	"github.com/jimeh/hukube/engine/internal/notify"
	"github.com/jimeh/hukube/engine/internal/protocol"
)

type fakeTypes struct {
	types   map[protocol.TypeKey]protocol.ResourceType
	changed notify.Signal
}

func (f *fakeTypes) Type(key protocol.TypeKey) (protocol.ResourceType, bool) {
	t, ok := f.types[key]
	return t, ok
}
func (f *fakeTypes) TypeForKind(group, kind string) (protocol.ResourceType, bool) {
	var found protocol.ResourceType
	ok := false
	for key, t := range f.types {
		if t.Group == group && t.Kind == kind && (!ok || key < found.Key) {
			found = t
			ok = true
		}
	}
	return found, ok
}
func (f *fakeTypes) TypesChanged() (<-chan struct{}, func()) { return f.changed.Subscribe() }
func fixture() (*Graph, *fakeTypes) {
	f := &fakeTypes{types: map[protocol.TypeKey]protocol.ResourceType{}}
	for _, t := range []protocol.ResourceType{{Key: "deployments.apps", Kind: "Deployment", Group: "apps", Namespaced: true}, {Key: "replicasets.apps", Kind: "ReplicaSet", Group: "apps", Namespaced: true}, {Key: "pods", Kind: "Pod", Namespaced: true}, {Key: "nodes", Kind: "Node"}} {
		t.State = protocol.TypeStateReady
		f.types[t.Key] = t
	}
	return New(index.New(), f), f
}
func add(g *Graph, typ protocol.TypeKey, name string, owners ...Node) Node {
	m := index.Meta{UID: string(typ) + "-" + name, Name: name, Namespace: "ns", CreatedAt: time.Unix(100, 0)}
	typInfo, _ := g.types.Type(typ)
	if !typInfo.Namespaced {
		m.Namespace = ""
	}
	for _, owner := range owners {
		t, _ := g.types.Type(owner.Type)
		version := "v1"
		if t.Group != "" {
			version = t.Group + "/v1"
		}
		m.Owners = append(m.Owners, index.OwnerRef{APIVersion: version, Kind: t.Kind, Name: owner.Meta.Name, UID: owner.Meta.UID})
	}
	n := Node{typ, m}
	g.store.Apply([]index.Change{{Kind: index.Added, Type: typ, Meta: m}})
	return n
}

func TestResolve(t *testing.T) {
	cases := []struct {
		name                   string
		state                  protocol.TypeState
		ns, uid, version, kind string
		want                   protocol.RelatedStatus
	}{
		{"found", protocol.TypeStateReady, "ns", "uid", "apps/v1", "Deployment", protocol.RelatedStatusFound},
		{"version ignored", protocol.TypeStateReady, "ns", "uid", "apps/old", "Deployment", protocol.RelatedStatusFound},
		{"wrong UID", protocol.TypeStateReady, "ns", "old", "apps/v1", "Deployment", protocol.RelatedStatusMissing},
		{"another Namespace", protocol.TypeStateReady, "other", "uid", "apps/v1", "Deployment", protocol.RelatedStatusMissing},
		{"cluster scoped dependent", protocol.TypeStateReady, "", "uid", "apps/v1", "Deployment", protocol.RelatedStatusMissing},
		{"forbidden ignores stale index", protocol.TypeStateForbidden, "ns", "uid", "apps/v1", "Deployment", protocol.RelatedStatusForbidden},
		{"failed ignores stale index", protocol.TypeStateFailed, "ns", "uid", "apps/v1", "Deployment", protocol.RelatedStatusFailed},
		{"syncing absent", protocol.TypeStateSyncing, "ns", "old", "apps/v1", "Deployment", protocol.RelatedStatusSyncing},
		{"syncing found", protocol.TypeStateSyncing, "ns", "uid", "apps/v1", "Deployment", protocol.RelatedStatusFound},
		{"unserved", protocol.TypeStateReady, "ns", "uid", "legacy/v1", "Unknown", protocol.RelatedStatusUnserved},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g, f := fixture()
			typ := f.types["deployments.apps"]
			typ.State = tc.state
			f.types[typ.Key] = typ
			g.store.Apply([]index.Change{{Kind: index.Added, Type: typ.Key, Meta: index.Meta{Name: "owner", Namespace: "ns", UID: "uid"}}})
			owner := g.resolve(Node{Meta: index.Meta{Namespace: tc.ns}}, index.OwnerRef{APIVersion: tc.version, Kind: tc.kind, Name: "owner", UID: tc.uid})
			if owner.Status != tc.want {
				t.Fatalf("status = %s, want %s", owner.Status, tc.want)
			}
		})
	}
	t.Run("cluster scoped owner", func(t *testing.T) {
		g, _ := fixture()
		g.store.Apply([]index.Change{{Kind: index.Added, Type: "nodes", Meta: index.Meta{Name: "owner", UID: "uid"}}})
		o := g.resolve(Node{Meta: index.Meta{Namespace: "ns"}}, index.OwnerRef{APIVersion: "v1", Kind: "Node", Name: "owner", UID: "uid"})
		if o.Status != protocol.RelatedStatusFound || o.Node.Meta.Namespace != "" {
			t.Fatalf("owner = %+v", o)
		}
	})
}

func TestOwnershipTypeIdentity(t *testing.T) {
	g, f := fixture()
	f.types["deployments.alias"] = protocol.ResourceType{Key: "deployments.alias", Group: "alias", Kind: "Deployment", Namespaced: true, State: protocol.TypeStateReady}
	owner := add(g, "deployments.apps", "owner")
	alias := owner
	alias.Type = "deployments.alias"
	g.store.Apply([]index.Change{{Kind: index.Added, Type: alias.Type, Meta: alias.Meta}})
	child := add(g, "pods", "child", owner)
	childAlias := child
	childAlias.Type = "pods.alias"
	f.types[childAlias.Type] = protocol.ResourceType{Key: childAlias.Type, Kind: "Pod", Namespaced: true, State: protocol.TypeStateReady}
	g.store.Apply([]index.Change{{Kind: index.Added, Type: childAlias.Type, Meta: childAlias.Meta}})
	if o := g.Owners(child); len(o) != 1 || o[0].Node.Type != owner.Type {
		t.Fatalf("owner = %+v", o)
	}
	if len(g.Owned(alias)) != 0 {
		t.Fatal("same UID under another type owns child")
	}
	if got := g.Owned(owner); len(got) != 1 || got[0].Type != "pods" {
		t.Fatalf("duplicate child = %+v", got)
	}
	g.store.RemoveType(alias.Type)
	if len(g.Owned(owner)) != 1 {
		t.Fatal("removing alias changed ownership")
	}
}

func TestRecreatedOwner(t *testing.T) {
	g, _ := fixture()
	owner := add(g, "deployments.apps", "owner")
	child := add(g, "pods", "child", owner)
	g.store.Apply([]index.Change{{Kind: index.Deleted, Type: owner.Type, Meta: owner.Meta}})
	owner.Meta.UID = "new"
	g.store.Apply([]index.Change{{Kind: index.Added, Type: owner.Type, Meta: owner.Meta}})
	if len(g.Owned(owner)) != 0 || g.Owners(child)[0].Status != protocol.RelatedStatusMissing {
		t.Fatal("recreated owner inherited old child")
	}
}

func TestOwnershipOddShapes(t *testing.T) {
	g, _ := fixture()
	a := add(g, "deployments.apps", "a")
	b := add(g, "deployments.apps", "b")
	child := add(g, "pods", "child", a, b)
	child.Meta.Owners = slices.Clone(child.Meta.Owners)
	child.Meta.Owners[1].Controller = true
	g.store.Apply([]index.Change{{Kind: index.Modified, Type: child.Type, Meta: child.Meta}})
	if owners := g.Owners(child); owners[0].Node.Meta.Name != "b" || owners[1].Node.Meta.Name != "a" {
		t.Fatalf("controller and non-controller owners = %+v", owners)
	}
	if len(g.Owned(a)) != 1 || len(g.Owned(b)) != 1 {
		t.Fatal("child must appear under both owners")
	}
	if got := g.Related(add(g, "pods", "alone"), DefaultLimits()); len(got) != 0 {
		t.Fatalf("unrelated = %+v", got)
	}
	// The same descendant is displayed under both branches, but counted once.
	root := add(g, "nodes", "root")
	a = add(g, "deployments.apps", "a", root)
	b = add(g, "deployments.apps", "b", root)
	child = add(g, "pods", "child", a, b)
	sections := g.Related(root, DefaultLimits())
	if len(sections) != 1 || sections[0].Total != 3 || len(sections[0].Rows) != 4 {
		t.Fatalf("two branches = %+v", sections)
	}
	g, _ = fixture()
	top := add(g, "deployments.apps", "top")
	left := add(g, "replicasets.apps", "left", top)
	right := add(g, "replicasets.apps", "right", top)
	leaf := add(g, "pods", "leaf", left, right)
	merged := g.Related(leaf, DefaultLimits())[0]
	if merged.Total != 3 || len(merged.Rows) != 5 || merged.Rows[0].Name != "top" || merged.Rows[1].Depth != 1 || merged.Rows[3].Depth != 1 {
		t.Fatalf("shared owner paths = %+v", merged)
	}
	// names lists a section's rows as name and status, in display order.
	names := func(section protocol.RelatedSection) string {
		out := []string{}
		for _, row := range section.Rows {
			out = append(out, fmt.Sprintf("%d:%s:%s", row.Depth, row.Name, row.Status))
		}
		return fmt.Sprint(out)
	}
	t.Run("itself and another owner", func(t *testing.T) {
		g, _ := fixture()
		owner := add(g, "deployments.apps", "owner")
		self := add(g, "pods", "self")
		self = add(g, "pods", "self", owner, self)
		got := []string{}
		for _, section := range g.Related(self, DefaultLimits()) {
			got = append(got, names(section))
		}
		if want := []string{"[0:owner:found 1:self:self]"}; !slices.Equal(got, want) {
			t.Fatalf("sections = %v, want %v", got, want)
		}
	})
	for size, want := range map[int][]string{
		// A Resource that names only itself has no owner and owns nothing.
		1: {},
		2: {"[0:1:found 1:0:self]", "[0:1:found]"},
		3: {"[0:2:found 1:1:found 2:0:self]", "[0:2:found 1:1:found]"},
	} {
		t.Run(fmt.Sprintf("loop of %d", size), func(t *testing.T) {
			g, _ := fixture()
			nodes := []Node{}
			for i := 0; i < size; i++ {
				nodes = append(nodes, add(g, "pods", fmt.Sprint(i)))
			}
			for i := range nodes {
				nodes[i] = add(g, "pods", fmt.Sprint(i), nodes[(i+1)%size])
			}
			if len(g.AllOwned(nodes[0])) != size-1 {
				t.Fatal("loop repeated root or a descendant")
			}
			got := []string{}
			for _, section := range g.Related(nodes[0], DefaultLimits()) {
				got = append(got, names(section))
			}
			if !slices.Equal(got, want) {
				t.Fatalf("sections = %v, want %v", got, want)
			}
		})
	}
}

func TestRelatedLimits(t *testing.T) {
	g, _ := fixture()
	root := add(g, "deployments.apps", "root")
	for i := 0; i < 101; i++ {
		add(g, "pods", fmt.Sprintf("p%03d", i), root)
	}
	s := g.Related(root, DefaultLimits())[0]
	if s.Total != 101 || len(s.Rows) != 101 || s.Rows[100].Status != protocol.RelatedStatusMore || s.Rows[100].More != 1 {
		t.Fatalf("101 children = %+v", s)
	}
	g, _ = fixture()
	root = add(g, "deployments.apps", "root")
	for i := 0; i < 10; i++ {
		rs := add(g, "replicasets.apps", fmt.Sprint(i), root)
		for j := 0; j < 100; j++ {
			add(g, "pods", fmt.Sprintf("%d-%03d", i, j), rs)
		}
	}
	s = g.Related(root, DefaultLimits())[0]
	first, shown, more := 0, 0, 0
	for _, row := range s.Rows {
		if row.Status == protocol.RelatedStatusMore {
			more += row.More
		} else {
			shown++
			if row.Depth == 0 {
				first++
			}
		}
	}
	if s.Total != 1010 || first != 10 || shown != 500 || more != 510 {
		t.Fatalf("wide tree: total %d first %d shown %d more %d", s.Total, first, shown, more)
	}
	g, _ = fixture()
	owners := []Node{}
	for i := 0; i < 51; i++ {
		owners = append(owners, add(g, "deployments.apps", fmt.Sprintf("o%02d", i)))
	}
	s = g.Related(add(g, "pods", "child", owners...), DefaultLimits())[0]
	if !s.Truncated || s.Total != 50 || len(s.Rows) != 100 {
		t.Fatalf("owner paths = %+v", s)
	}
}

func TestRelatedDeterministicJSON(t *testing.T) {
	build := func(reverse bool) []byte {
		g, _ := fixture()
		root := add(g, "deployments.apps", "root")
		order := []string{"z", "a", "c"}
		if reverse {
			slices.Reverse(order)
		}
		for _, name := range order {
			rs := add(g, "replicasets.apps", name, root)
			add(g, "pods", name, rs)
		}
		pod, _ := g.Node("pods", "ns", "a")
		data, err := json.Marshal([]any{g.Related(root, DefaultLimits()), g.Related(pod, DefaultLimits())})
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	if a, b := build(false), build(true); string(a) != string(b) {
		t.Fatalf("insertion order changed JSON:\n%s\n%s", a, b)
	}
}

func TestAllOwnedAndChanged(t *testing.T) {
	g, f := fixture()
	root := add(g, "deployments.apps", "root")
	rs := Node{Type: "replicasets.apps", Meta: index.Meta{Namespace: "ns", Name: "late", UID: "replicasets.apps-late"}}
	ch, stop := g.Changed()
	defer stop()
	wait := func() {
		t.Helper()
		select {
		case <-ch:
		case <-time.After(time.Second):
			t.Fatal("graph did not signal")
		}
	}
	pod := add(g, "pods", "pod", rs)
	wait()
	if len(g.AllOwned(root)) != 0 {
		t.Fatal("unresolved ReplicaSet owns Pod")
	}
	rs = add(g, "replicasets.apps", "late", root)
	wait()
	got := g.AllOwned(root)
	if len(got) != 2 || got[0].Meta.UID != rs.Meta.UID || got[1].Meta.UID != pod.Meta.UID {
		t.Fatalf("breadth first descendants = %+v", got)
	}
	typ := f.types["pods"]
	typ.State = protocol.TypeStateForbidden
	f.types[typ.Key] = typ
	f.changed.Notify()
	wait()
	if len(g.AllOwned(root)) != 1 {
		t.Fatal("forbidden child remains")
	}
	typ.State = protocol.TypeStateFailed
	f.types[typ.Key] = typ
	f.changed.Notify()
	wait()
	if len(g.AllOwned(root)) != 1 {
		t.Fatal("failed child remains")
	}
}

func BenchmarkRelatedLargeOwner(b *testing.B) {
	g, _ := fixture()
	root := add(g, "deployments.apps", "root")
	for i := 0; i < 10000; i++ {
		add(g, "pods", fmt.Sprint(i), root)
	}
	b.ResetTimer()
	b.ReportAllocs()
	for b.Loop() {
		g.Related(root, DefaultLimits())
	}
}
