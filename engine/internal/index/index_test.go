package index

import (
	"slices"
	"testing"
	"time"
)

func TestDiff(t *testing.T) {
	s := New()
	s.Apply([]Change{
		{Kind: Added, Type: "pods", Meta: Meta{Namespace: "a", Name: "same", ResourceVersion: "1"}},
		{Kind: Added, Type: "pods", Meta: Meta{Namespace: "a", Name: "changed", ResourceVersion: "1"}},
		{Kind: Added, Type: "pods", Meta: Meta{Namespace: "a", Name: "gone", ResourceVersion: "1"}},
		{Kind: Added, Type: "services", Meta: Meta{Namespace: "a", Name: "other-type", ResourceVersion: "1"}},
	})

	changes := s.Diff("pods", []Meta{
		{Namespace: "a", Name: "same", ResourceVersion: "1"},
		{Namespace: "a", Name: "changed", ResourceVersion: "2"},
		{Namespace: "b", Name: "new", ResourceVersion: "1"},
	}, time.Now())

	got := make([]string, len(changes))
	for i, c := range changes {
		got[i] = map[ChangeKind]string{Added: "added", Modified: "modified", Deleted: "deleted"}[c.Kind] + " " + c.Meta.Key()
	}
	slices.Sort(got)
	want := []string{"added b/new", "deleted a/gone", "modified a/changed"}
	if !slices.Equal(got, want) {
		t.Errorf("changes = %v, want %v", got, want)
	}

	s.Apply(changes)
	if n := s.Count("pods"); n != 3 {
		t.Errorf("pods count after apply = %d, want 3", n)
	}
	if n := s.Count("services"); n != 1 {
		t.Errorf("services count = %d, want 1 (diff must not touch other types)", n)
	}
}

func TestChangedWakesOnlySubscribersOfChangedTypes(t *testing.T) {
	s := New()
	all, stopAll := s.Changed()
	defer stopAll()
	pods, stopPods := s.Changed("pods")
	defer stopPods()
	services, stopServices := s.Changed("services")
	defer stopServices()
	podsOrSecrets, stopPodsOrSecrets := s.Changed("pods", "secrets")

	// fired reports whether each channel was signalled, and drains it. Signals
	// are sent before Apply and RemoveType return, so no waiting is needed.
	fired := func() map[string]bool {
		got := map[string]bool{}
		for name, ch := range map[string]<-chan struct{}{"all": all, "pods": pods, "services": services, "podsOrSecrets": podsOrSecrets} {
			select {
			case <-ch:
				got[name] = true
			default:
			}
		}
		return got
	}
	check := func(step string, want ...string) {
		t.Helper()
		got := fired()
		for _, name := range want {
			if !got[name] {
				t.Errorf("%s: %s not signalled", step, name)
			}
			delete(got, name)
		}
		for name := range got {
			t.Errorf("%s: %s signalled, want not", step, name)
		}
	}

	s.Apply([]Change{{Kind: Added, Type: "pods", Meta: Meta{Name: "a"}}})
	check("add pod", "all", "pods", "podsOrSecrets")

	s.Apply([]Change{{Kind: Added, Type: "secrets", Meta: Meta{Name: "a"}}})
	check("add secret, a type first seen after subscribing", "all", "podsOrSecrets")

	s.RemoveType("pods")
	check("remove pods", "all", "pods", "podsOrSecrets")

	s.RemoveType("pods")
	check("remove pods again, which no longer exist")

	stopPodsOrSecrets()
	s.Apply([]Change{
		{Kind: Added, Type: "pods", Meta: Meta{Name: "b"}},
		{Kind: Added, Type: "secrets", Meta: Meta{Name: "b"}},
	})
	check("after stopping the multi-type subscription", "all", "pods")
}
