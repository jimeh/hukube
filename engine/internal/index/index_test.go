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
