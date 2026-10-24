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

// fakeTable serves fixed Columns and cells, and counts the Resources whose
// cells were asked for.
type fakeTable struct {
	columns []protocol.Column
	cells   map[string][]any
	lookups int
}

func (f *fakeTable) Read(fn func([]protocol.Column, func(string) []any)) {
	fn(f.columns, func(key string) []any {
		f.lookups++
		return f.cells[key]
	})
}

// podTable describes five Pods, in name order: default/a, other/a, default/b,
// default/c, and default/d. The Table has no cells for default/d, and none in
// the Count column for other/a.
func podTable() (*index.Store, *fakeTable) {
	store := index.New()
	var changes []index.Change
	for _, key := range []string{"default/a", "other/a", "default/b", "default/c", "default/d"} {
		ns, name, _ := strings.Cut(key, "/")
		changes = append(changes, index.Change{Kind: index.Added, Type: "pods", Meta: index.Meta{Namespace: ns, Name: name}})
	}
	store.Apply(changes)
	return store, &fakeTable{
		columns: []protocol.Column{
			{Name: "Ready", Type: "string"},
			{Name: "Restarts", Type: "string"},
			{Name: "Count", Type: "integer"},
			{Name: "Seen", Type: "string"},
		},
		cells: map[string][]any{
			"default/a": {"1/1", "3", int64(10), "5m"},
			"other/a":   {"10/10", "0", nil, "<unknown>"},
			"default/b": {"0/1", "12 (3h ago)", int64(9), "90s"},
			"default/c": {"1/1", "0", int64(2), "2h"},
		},
	}
}

func keys(r protocol.QueryResult) []string {
	out := make([]string, len(r.Rows))
	for i, row := range r.Rows {
		out[i] = row.Namespace + "/" + row.Name
	}
	return out
}

func TestRunSortsByColumn(t *testing.T) {
	tests := []struct {
		name    string
		sort    protocol.Sort
		noTable bool
		want    []string
	}{
		{
			name: "numbers by value, rows without one last",
			sort: protocol.Sort{Field: protocol.SortFieldColumn, Column: "Count"},
			want: []string{"default/c", "default/b", "default/a", "other/a", "default/d"},
		},
		{
			name: "descending keeps rows without a value last",
			sort: protocol.Sort{Field: protocol.SortFieldColumn, Column: "Count", Desc: true},
			want: []string{"default/a", "default/b", "default/c", "default/d", "other/a"},
		},
		{
			name: "text in natural order, ties broken by name",
			sort: protocol.Sort{Field: protocol.SortFieldColumn, Column: "Restarts"},
			want: []string{"other/a", "default/c", "default/a", "default/b", "default/d"},
		},
		{
			name: "fractions by their numbers",
			sort: protocol.Sort{Field: protocol.SortFieldColumn, Column: "Ready"},
			want: []string{"default/b", "default/a", "default/c", "other/a", "default/d"},
		},
		{
			name: "ages by length, before other text",
			sort: protocol.Sort{Field: protocol.SortFieldColumn, Column: "Seen"},
			want: []string{"default/b", "default/a", "default/c", "other/a", "default/d"},
		},
		{
			name: "an unknown column leaves name order",
			sort: protocol.Sort{Field: protocol.SortFieldColumn, Column: "Nope"},
			want: []string{"default/a", "other/a", "default/b", "default/c", "default/d"},
		},
		{
			name:    "no Table leaves name order",
			sort:    protocol.Sort{Field: protocol.SortFieldColumn, Column: "Count"},
			noTable: true,
			want:    []string{"default/a", "other/a", "default/b", "default/c", "default/d"},
		},
	}
	q, _ := Compile(ptr(in(protocol.FieldType, "pods")))
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store, fake := podTable()
			var table Table
			if !tt.noTable {
				table = fake
			}
			if got := keys(Run(store, q, table, tt.sort, 0, 100)); !slices.Equal(got, tt.want) {
				t.Errorf("rows = %v, want %v", got, tt.want)
			}
		})
	}
}

// A time the Engine read from each Resource sorts like the age since it:
// ascending puts the newest first. Rows without one stay last both ways.
func TestRunSortsTimesNewestFirst(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	store := index.New()
	var changes []index.Change
	for _, name := range []string{"a", "b", "c", "d", "e"} {
		changes = append(changes, index.Change{Kind: index.Added, Type: "events", Meta: index.Meta{Namespace: "default", Name: name}})
	}
	store.Apply(changes)
	table := &fakeTable{
		columns: []protocol.Column{{Name: "Last Seen", Type: protocol.ColumnTypeTimestamp}},
		cells: map[string][]any{
			"default/a": {now.Add(-3 * time.Hour)},
			"default/b": {now.Add(-time.Hour)},
			"default/c": {nil},
			"default/e": {now.Add(-2*time.Hour - time.Microsecond)},
		},
	}
	q, _ := Compile(ptr(in(protocol.FieldType, "events")))
	for _, tt := range []struct {
		desc bool
		want []string
	}{
		{desc: false, want: []string{"default/b", "default/e", "default/a", "default/c", "default/d"}},
		{desc: true, want: []string{"default/a", "default/e", "default/b", "default/d", "default/c"}},
	} {
		sort := protocol.Sort{Field: protocol.SortFieldColumn, Column: "Last Seen", Desc: tt.desc}
		if got := keys(Run(store, q, table, sort, 0, 100)); !slices.Equal(got, tt.want) {
			t.Errorf("desc %v: rows = %v, want %v", tt.desc, got, tt.want)
		}
	}
}

// Each Row gets the cells of its own Resource, including where two
// Namespaces hold the same name, and a result that is not sorted by a Column
// only reads the cells of its window.
func TestRunAttachesCellsToItsWindow(t *testing.T) {
	store, table := podTable()
	q, _ := Compile(ptr(in(protocol.FieldType, "pods")))

	got := Run(store, q, table, protocol.Sort{}, 1, 2)
	if !slices.Equal(got.Columns, table.columns) {
		t.Errorf("columns = %+v, want %+v", got.Columns, table.columns)
	}
	var cells []string
	for _, row := range got.Rows {
		cells = append(cells, fmt.Sprintf("%s/%s=%v", row.Namespace, row.Name, row.Cells))
	}
	want := []string{"other/a=[10/10 0 <nil> <unknown>]", "default/b=[0/1 12 (3h ago) 9 90s]"}
	if !slices.Equal(cells, want) {
		t.Errorf("rows = %q, want %q", cells, want)
	}
	if table.lookups != 2 {
		t.Errorf("read the cells of %d Resources for a window of 2", table.lookups)
	}

	// A Resource the Table has no cells for is sent without any.
	raw, _ := json.Marshal(Run(store, q, table, protocol.Sort{}, 4, 1).Rows)
	if !strings.Contains(string(raw), `"name":"d"`) || strings.Contains(string(raw), "cells") {
		t.Errorf("rows = %s, want default/d without cells", raw)
	}
}

// Cells of different kinds must still have one consistent order, or a sorted
// list would change order between two runs over the same Resources.
func TestCellKeysOrderEveryKind(t *testing.T) {
	newest := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	ordered := []any{
		int64(-1), 2.5, int64(10),
		false, true,
		"45s", "2m30s", "3h", "5d", "2y45d",
		newest, newest.Add(-time.Microsecond), newest.Add(-time.Hour),
		"", "0", "9/10", "10/10", "<none>", "Running", "a2", "a10",
	}
	for i, a := range ordered {
		for j, b := range ordered {
			want := 0
			if i < j {
				want = -1
			} else if i > j {
				want = 1
			}
			if got := compareKeys(cellKey(a), cellKey(b)); got != want {
				t.Errorf("comparing %#v with %#v = %d, want %d", a, b, got, want)
			}
		}
	}
}
