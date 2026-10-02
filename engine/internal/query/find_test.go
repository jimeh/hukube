package query

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jimeh/hukube/engine/internal/index"
	"github.com/jimeh/hukube/engine/internal/protocol"
)

func findStore(resources ...[3]string) *index.Store {
	s := index.New()
	changes := make([]index.Change, len(resources))
	for i, r := range resources {
		changes[i] = index.Change{Kind: index.Added, Type: protocol.TypeKey(r[0]), Meta: index.Meta{
			UID: strings.Join(r[:], "/"), Namespace: r[1], Name: r[2],
		}}
	}
	s.Apply(changes)
	return s
}

func find(t *testing.T, store *index.Store, where *protocol.Expr, text string, limit int) protocol.FindResult {
	t.Helper()
	q, err := Compile(where)
	if err != nil {
		t.Fatal(err)
	}
	return NewFinder().Find(store, q, protocol.FindParams{Where: where, Text: text, Limit: limit})
}

// These tests assert relative order, not fzf's scores, so upgrading fzf only
// breaks them if its ranking changes in a way users would notice.
func TestFindRanksAndFilters(t *testing.T) {
	store := findStore(
		[3]string{"pods", "default", "nginx-7d4f9c-px2rd"},
		[3]string{"pods", "default", "nginx-prod"},
		[3]string{"pods", "default", "pr-od"},
		[3]string{"pods", "default", "Web-API"},
		[3]string{"pods", "default", "web"},
		[3]string{"pods", "default", "web-api"},
		[3]string{"pods", "default", "api-gateway"},
		[3]string{"services", "default", "web"},
		[3]string{"pods", "other", "web"},
	)
	tests := []struct {
		name string
		text string
		want []string
	}{
		{
			name: "a match on word boundaries outranks a scattered one",
			text: "ngxprd",
			want: []string{"default/nginx-prod", "default/nginx-7d4f9c-px2rd"},
		},
		{
			name: "a word starting with ' matches only an exact substring",
			text: "'prod",
			want: []string{"default/nginx-prod"},
		},
		{
			name: "every word must match",
			text: "web api",
			want: []string{"default/Web-API", "default/web-api"},
		},
		{
			name: "equal scores put shorter names first, then namespace and type",
			text: "'web",
			want: []string{"default/web", "default/web", "other/web", "default/Web-API", "default/web-api"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := find(t, store, nil, tt.text, 50)
			var names []string
			for _, r := range got.Rows {
				names = append(names, r.Namespace+"/"+r.Name)
			}
			if !slices.Equal(names, tt.want) {
				t.Errorf("rows = %v, want %v", names, tt.want)
			}
			if got.Total != len(tt.want) {
				t.Errorf("total = %d, want %d", got.Total, len(tt.want))
			}
		})
	}

	// The tie between the two default/web Resources is broken by type.
	got := find(t, store, nil, "'web", 2)
	if len(got.Rows) != 2 || got.Rows[0].Type != "pods" || got.Rows[1].Type != "services" {
		t.Errorf("rows = %+v, want pods then services", got.Rows)
	}
}

func TestFindScopesAndEchoesParams(t *testing.T) {
	store := findStore(
		[3]string{"pods", "default", "web"},
		[3]string{"services", "default", "web"},
	)
	where := ptr(in(protocol.FieldType, "services"))
	got := find(t, store, where, "web", 10)
	if len(got.Rows) != 1 || got.Rows[0].Type != "services" {
		t.Errorf("rows = %+v, want only the service", got.Rows)
	}
	if got.Text != "web" || got.Where != where {
		t.Errorf("echoed text %q and where %+v, want the params", got.Text, got.Where)
	}
}

func TestFindLimits(t *testing.T) {
	var resources [][3]string
	for i := range MaxFindLimit + 50 {
		resources = append(resources, [3]string{"pods", "default", fmt.Sprintf("web-%03d", i)})
	}
	resources = append(resources, [3]string{"pods", "default", "web"})
	store := findStore(resources...)
	total := MaxFindLimit + 51

	tests := []struct {
		limit, wantRows int
	}{
		{limit: 1, wantRows: 1},
		{limit: 0, wantRows: 0},
		{limit: -5, wantRows: 0},
		{limit: MaxFindLimit + 100, wantRows: MaxFindLimit},
	}
	for _, tt := range tests {
		t.Run(fmt.Sprintf("limit %d", tt.limit), func(t *testing.T) {
			got := find(t, store, nil, "web", tt.limit)
			if len(got.Rows) != tt.wantRows || got.Total != total {
				t.Fatalf("rows %d, total %d; want rows %d, total %d", len(got.Rows), got.Total, tt.wantRows, total)
			}
			if tt.wantRows > 0 && got.Rows[0].Name != "web" {
				t.Errorf("first row = %q, want the exact name", got.Rows[0].Name)
			}
		})
	}
}

// The index map yields matches in any order, so the replacement of a worse
// kept match is tested with fixed orders here.
func TestOfferKeepsTheBestMatches(t *testing.T) {
	m := func(name string, score int) match {
		return match{score: score, row: protocol.Row{Type: "pods", Name: name}}
	}
	orders := map[string][]match{
		"best last":  {m("c", 1), m("b", 2), m("a", 3)},
		"best first": {m("a", 3), m("b", 2), m("c", 1)},
		"mixed":      {m("b", 2), m("c", 1), m("a", 3)},
	}
	for name, offers := range orders {
		t.Run(name, func(t *testing.T) {
			var best worstFirst
			for _, o := range offers {
				best.offer(o, 2)
			}
			slices.SortFunc(best, func(a, b match) int { return rank(&a, &b) })
			if len(best) != 2 || best[0].row.Name != "a" || best[1].row.Name != "b" {
				t.Errorf("kept %+v, want a then b", best)
			}
		})
	}
}

// Scoring is slow, so indexing must be able to proceed while a find scores.
func TestFindScoresWithoutHoldingTheIndex(t *testing.T) {
	store := findStore([3]string{"pods", "default", "web"})
	q, _ := Compile(nil)
	scoring := make(chan struct{})
	resume := make(chan struct{})
	f := NewFinder()
	f.beforeScore = func() {
		close(scoring)
		<-resume
	}
	done := make(chan protocol.FindResult)
	go func() { done <- f.Find(store, q, protocol.FindParams{Text: "web", Limit: 10}) }()
	<-scoring

	applied := make(chan struct{})
	go func() {
		store.Apply([]index.Change{{Kind: index.Added, Type: "secrets", Meta: index.Meta{Name: "s"}}})
		close(applied)
	}()
	select {
	case <-applied:
	case <-time.After(10 * time.Second):
		t.Fatal("Apply did not complete while a find was scoring")
	}

	close(resume)
	if got := <-done; len(got.Rows) != 1 || got.Rows[0].Name != "web" {
		t.Errorf("rows = %+v, want web", got.Rows)
	}
}

// A Finder reuses its scratch space, so a run must not see an earlier
// run's candidates.
func TestFinderReuseKeepsRunsIndependent(t *testing.T) {
	store := findStore(
		[3]string{"pods", "default", "web-app"},
		[3]string{"services", "default", "api"},
	)
	all, _ := Compile(nil)
	services, _ := Compile(ptr(in(protocol.FieldType, "services")))
	f := NewFinder()
	if got := f.Find(store, all, protocol.FindParams{Text: "a", Limit: 10}); got.Total != 2 {
		t.Fatalf("total = %d, want both Resources", got.Total)
	}
	// web-app also matches "a", so it would show up if the first run's
	// candidates leaked into this one.
	got := f.Find(store, services, protocol.FindParams{Text: "a", Limit: 10})
	if len(got.Rows) != 1 || got.Rows[0].Name != "api" || got.Total != 1 {
		t.Errorf("rows = %+v, total %d; want only api", got.Rows, got.Total)
	}
}

// Clients index into rows, so a find without results must encode them as []
// rather than null.
func TestFindWithoutResultsEncodesEmptyRows(t *testing.T) {
	store := findStore([3]string{"pods", "default", "web"})
	for _, text := range []string{"", "   ", "'", "' '", "zzz"} {
		got := find(t, store, nil, text, 10)
		raw, err := json.Marshal(got)
		if err != nil {
			t.Fatal(err)
		}
		if got.Total != 0 || !strings.Contains(string(raw), `"rows":[]`) {
			t.Errorf("find %q = %s, want no rows, encoded as []", text, raw)
		}
	}
}

func BenchmarkFind(b *testing.B) {
	const n = 200_000
	changes := make([]index.Change, n)
	for i := range n {
		app := fmt.Sprintf("service-%d", i/20)
		changes[i] = index.Change{Kind: index.Added, Type: "pods", Meta: index.Meta{
			UID:       fmt.Sprint(i),
			Namespace: fmt.Sprintf("team-%d", i/500),
			Name:      fmt.Sprintf("%s-%08x-%05x", app, (i/20)*2654435761, i),
		}}
	}
	store := index.New()
	store.Apply(changes)
	q, _ := Compile(nil)
	f := NewFinder()

	for _, text := range []string{"svc", "service-4217"} {
		b.Run(text, func(b *testing.B) {
			for b.Loop() {
				f.Find(store, q, protocol.FindParams{Text: text, Limit: 50})
			}
		})
	}
}
