package query

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jimeh/hukube/engine/internal/index"
	"github.com/jimeh/hukube/engine/internal/protocol"
)

var base = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func testStore() *index.Store {
	s := index.New()
	add := func(t protocol.TypeKey, ns, name string, age time.Duration) index.Change {
		return index.Change{Kind: index.Added, Type: t, Meta: index.Meta{
			UID: string(t) + "/" + ns + "/" + name, Namespace: ns, Name: name, CreatedAt: base.Add(-age),
		}}
	}
	s.Apply([]index.Change{
		add("pods", "default", "web-1", 3*time.Hour),
		add("pods", "default", "Web-2", time.Hour),
		add("pods", "kube-system", "coredns", 48*time.Hour),
		add("configmaps", "default", "web-config", 2*time.Hour),
		add("namespaces", "", "default", 100*time.Hour),
	})
	return s
}

func in(f protocol.Field, values ...string) protocol.Expr {
	return protocol.Expr{Op: protocol.ExprOpIn, Field: f, Values: values}
}

func names(r protocol.QueryResult) []string {
	out := make([]string, len(r.Rows))
	for i, row := range r.Rows {
		out[i] = row.Name
	}
	return out
}

func TestRunFiltersAndSorts(t *testing.T) {
	store := testStore()
	tests := []struct {
		name  string
		where *protocol.Expr
		sort  protocol.Sort
		want  []string
	}{
		{
			name: "nil matches everything, sorted by name",
			want: []string{"Web-2", "coredns", "default", "web-1", "web-config"},
		},
		{
			name:  "type narrows the scan",
			where: &protocol.Expr{Op: protocol.ExprOpAnd, Args: []protocol.Expr{in(protocol.FieldType, "pods"), in(protocol.FieldNamespace, "default")}},
			want:  []string{"Web-2", "web-1"},
		},
		{
			name:  "a repeated type does not repeat rows",
			where: ptr(in(protocol.FieldType, "pods", "pods")),
			want:  []string{"Web-2", "coredns", "web-1"},
		},
		{
			name: "or of types scans each once",
			where: &protocol.Expr{Op: protocol.ExprOpOr, Args: []protocol.Expr{
				in(protocol.FieldType, "configmaps", "pods"),
				in(protocol.FieldType, "pods"),
			}},
			want: []string{"Web-2", "coredns", "web-1", "web-config"},
		},
		{
			name:  "contains is case-insensitive",
			where: &protocol.Expr{Op: protocol.ExprOpContains, Field: protocol.FieldName, Values: []string{"WEB"}},
			want:  []string{"Web-2", "web-1", "web-config"},
		},
		{
			name: "or and not",
			where: &protocol.Expr{Op: protocol.ExprOpOr, Args: []protocol.Expr{
				in(protocol.FieldType, "namespaces"),
				{Op: protocol.ExprOpNot, Args: []protocol.Expr{in(protocol.FieldNamespace, "default", "")}},
			}},
			want: []string{"coredns", "default"},
		},
		{
			name:  "ascending age puts the youngest first",
			where: ptr(in(protocol.FieldType, "pods")),
			sort:  protocol.Sort{Field: protocol.SortFieldAge},
			want:  []string{"Web-2", "web-1", "coredns"},
		},
		{
			name:  "descending namespace, ties broken by name",
			where: ptr(in(protocol.FieldType, "pods", "configmaps")),
			sort:  protocol.Sort{Field: protocol.SortFieldNamespace, Desc: true},
			want:  []string{"coredns", "web-config", "web-1", "Web-2"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			q, err := Compile(tt.where)
			if err != nil {
				t.Fatal(err)
			}
			got := Run(store, q, tt.sort, 0, 100)
			if !slices.Equal(names(got), tt.want) {
				t.Errorf("rows = %v, want %v", names(got), tt.want)
			}
			if got.Total != len(tt.want) {
				t.Errorf("total = %d, want %d", got.Total, len(tt.want))
			}
		})
	}
}

func TestRunWindow(t *testing.T) {
	q, _ := Compile(nil)
	store := testStore()
	tests := []struct {
		offset, limit int
		wantOffset    int
		want          []string
	}{
		{offset: 1, limit: 2, wantOffset: 1, want: []string{"coredns", "default"}},
		{offset: 4, limit: 10, wantOffset: 4, want: []string{"web-config"}},
		{offset: 9, limit: 10, wantOffset: 5, want: []string{}},
		{offset: -3, limit: 1, wantOffset: 0, want: []string{"Web-2"}},
		{offset: 0, limit: 0, wantOffset: 0, want: []string{}},
	}
	for _, tt := range tests {
		got := Run(store, q, protocol.Sort{}, tt.offset, tt.limit)
		if got.Total != 5 || got.Offset != tt.wantOffset || !slices.Equal(names(got), tt.want) {
			t.Errorf("window(%d, %d) = total %d offset %d %v, want total 5 offset %d %v",
				tt.offset, tt.limit, got.Total, got.Offset, names(got), tt.wantOffset, tt.want)
		}
	}
}

// Types decides which index changes wake a Query subscription, so it must
// cover every type the Query can match and, where it can, nothing more.
func TestCompiledTypes(t *testing.T) {
	name := protocol.Expr{Op: protocol.ExprOpContains, Field: protocol.FieldName, Values: []string{"web"}}
	tests := []struct {
		name  string
		where *protocol.Expr
		want  []protocol.TypeKey
	}{
		{name: "no expression matches any type", want: nil},
		{name: "one type", where: ptr(in(protocol.FieldType, "pods")), want: []protocol.TypeKey{"pods"}},
		{
			name:  "several types, repeated",
			where: ptr(in(protocol.FieldType, "pods", "configmaps", "pods")),
			want:  []protocol.TypeKey{"configmaps", "pods"},
		},
		{
			name:  "and takes its constrained argument",
			where: &protocol.Expr{Op: protocol.ExprOpAnd, Args: []protocol.Expr{name, in(protocol.FieldType, "pods")}},
			want:  []protocol.TypeKey{"pods"},
		},
		{
			name: "or of constrained branches takes their union",
			where: &protocol.Expr{Op: protocol.ExprOpOr, Args: []protocol.Expr{
				in(protocol.FieldType, "pods"),
				{Op: protocol.ExprOpAnd, Args: []protocol.Expr{in(protocol.FieldType, "secrets", "pods"), name}},
			}},
			want: []protocol.TypeKey{"pods", "secrets"},
		},
		{
			name:  "or with an unconstrained branch matches any type",
			where: &protocol.Expr{Op: protocol.ExprOpOr, Args: []protocol.Expr{in(protocol.FieldType, "pods"), name}},
			want:  nil,
		},
		{
			name:  "not matches any type",
			where: &protocol.Expr{Op: protocol.ExprOpNot, Args: []protocol.Expr{in(protocol.FieldType, "pods")}},
			want:  nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			q, err := Compile(tt.where)
			if err != nil {
				t.Fatal(err)
			}
			got := q.Types()
			if (got == nil) != (tt.want == nil) || !slices.Equal(got, tt.want) {
				t.Errorf("Types() = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestCompileRejectsInvalidExpressions(t *testing.T) {
	tests := map[string]protocol.Expr{
		"unknown operator":        {Op: "near"},
		"unknown field":           {Op: protocol.ExprOpIn, Field: "color", Values: []string{"red"}},
		"empty and":               {Op: protocol.ExprOpAnd},
		"not with two arguments":  {Op: protocol.ExprOpNot, Args: []protocol.Expr{in(protocol.FieldName, "a"), in(protocol.FieldName, "b")}},
		"contains without value":  {Op: protocol.ExprOpContains, Field: protocol.FieldName},
		"invalid nested argument": {Op: protocol.ExprOpAnd, Args: []protocol.Expr{{Op: "near"}}},
	}
	for name, expr := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := Compile(&expr); err == nil {
				t.Error("Compile succeeded, want error")
			}
		})
	}
}

func ptr[T any](v T) *T { return &v }

// Clients index into rows, so an empty window must encode as [] rather than
// null.
func TestRunEncodesEmptyRowsAsArray(t *testing.T) {
	q, _ := Compile(ptr(in(protocol.FieldName, "no-such-resource")))
	raw, err := json.Marshal(Run(testStore(), q, protocol.Sort{}, 0, 10))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"rows":[]`) {
		t.Errorf("encoded result = %s, want rows as an empty array", raw)
	}
}
