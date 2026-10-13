package index

import (
	"fmt"
	"runtime"
	"testing"
	"unique"
)

func TestOwnedByTracksChanges(t *testing.T) {
	s := New()
	child := Meta{UID: "child", Name: "child", Owners: []OwnerRef{{UID: "first"}, {UID: "first"}, {UID: ""}}}
	s.Apply([]Change{{Kind: Added, Type: "pods", Meta: child}})
	if got := s.OwnedBy("first"); len(got) != 1 || got[0].Type != "pods" || got[0].Meta.UID != "child" {
		t.Fatalf("after add: %+v", got)
	}
	if len(s.OwnedBy("")) != 0 {
		t.Fatal("empty UID indexed")
	}
	child.Owners = []OwnerRef{{UID: "second"}}
	s.Apply([]Change{{Kind: Modified, Type: "pods", Meta: child}})
	if len(s.OwnedBy("first")) != 0 || len(s.OwnedBy("second")) != 1 {
		t.Fatal("change of owner not reflected")
	}
	s.Apply([]Change{{Kind: Added, Type: "other", Meta: child}})
	s.RemoveType("pods")
	if got := s.OwnedBy("second"); len(got) != 1 || got[0].Type != "other" {
		t.Fatalf("RemoveType lost or retained wrong type: %+v", got)
	}
	s.Apply([]Change{{Kind: Deleted, Type: "other", Meta: Meta{Name: "child"}}})
	if len(s.OwnedBy("second")) != 0 || len(s.owned) != 0 {
		t.Fatalf("delete left Resources or empty sets: %+v", s.owned)
	}
}

func BenchmarkStoreOwners(b *testing.B) {
	for _, owners := range []bool{false, true} {
		b.Run(fmt.Sprintf("owners=%t", owners), func(b *testing.B) {
			const count = 100000
			var retained uint64
			for b.Loop() {
				b.StopTimer()
				runtime.GC()
				var before, after runtime.MemStats
				runtime.ReadMemStats(&before)
				b.StartTimer()
				s := New()
				for i := 0; i < count; i++ {
					m := Meta{UID: fmt.Sprintf("pod-uid-%d", i), Namespace: "default", Name: fmt.Sprintf("pod-%d", i), ResourceVersion: "1", Labels: map[string]string{"app": "web", "tier": "frontend", "environment": "production", "version": "v1", "team": "platform", "component": "server"}}
					if owners {
						m.Owners = []OwnerRef{{APIVersion: unique.Make("apps/v1").Value(), Kind: unique.Make("ReplicaSet").Value(), Name: fmt.Sprintf("rs-%d", i/5), UID: fmt.Sprintf("rs-uid-%d", i/5), Controller: true}}
					}
					s.Apply([]Change{{Kind: Added, Type: "pods", Meta: m}})
				}
				b.StopTimer()
				runtime.GC()
				runtime.ReadMemStats(&after)
				runtime.KeepAlive(s)
				retained = after.HeapAlloc - before.HeapAlloc
				b.StartTimer()
			}
			b.ReportMetric(float64(retained)/count, "heap-B/resource")
		})
	}
}
