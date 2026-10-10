// Package query evaluates Query expressions against a Cluster's index.
package query

import (
	"cmp"
	"fmt"
	"slices"
	"strings"

	"k8s.io/apimachinery/pkg/labels"

	"github.com/jimeh/hukube/engine/internal/index"
	"github.com/jimeh/hukube/engine/internal/protocol"
)

// MaxLimit caps the number of Rows in one query window.
const MaxLimit = 1000

type predicate func(protocol.TypeKey, index.Meta) bool

// Compiled is a validated Query ready to run.
type Compiled struct {
	// types narrows the scan to these types; nil scans every type.
	types []protocol.TypeKey
	match predicate
}

// Compile validates an expression. A nil expression matches everything.
func Compile(e *protocol.Expr) (*Compiled, error) {
	if e == nil {
		return &Compiled{match: func(protocol.TypeKey, index.Meta) bool { return true }}, nil
	}
	match, err := compile(*e)
	if err != nil {
		return nil, err
	}
	return &Compiled{types: scanTypes(*e), match: match}, nil
}

func compile(e protocol.Expr) (predicate, error) {
	switch e.Op {
	case protocol.ExprOpAnd, protocol.ExprOpOr:
		if len(e.Args) == 0 {
			return nil, fmt.Errorf("%q needs at least one argument", e.Op)
		}
		preds := make([]predicate, len(e.Args))
		for i, arg := range e.Args {
			p, err := compile(arg)
			if err != nil {
				return nil, err
			}
			preds[i] = p
		}
		if e.Op == protocol.ExprOpAnd {
			return func(t protocol.TypeKey, m index.Meta) bool {
				for _, p := range preds {
					if !p(t, m) {
						return false
					}
				}
				return true
			}, nil
		}
		return func(t protocol.TypeKey, m index.Meta) bool {
			for _, p := range preds {
				if p(t, m) {
					return true
				}
			}
			return false
		}, nil

	case protocol.ExprOpNot:
		if len(e.Args) != 1 {
			return nil, fmt.Errorf("%q needs exactly one argument", e.Op)
		}
		p, err := compile(e.Args[0])
		if err != nil {
			return nil, err
		}
		return func(t protocol.TypeKey, m index.Meta) bool { return !p(t, m) }, nil

	case protocol.ExprOpIn:
		get, err := fieldGetter(e.Field)
		if err != nil {
			return nil, err
		}
		values := make(map[string]struct{}, len(e.Values))
		for _, v := range e.Values {
			values[v] = struct{}{}
		}
		return func(t protocol.TypeKey, m index.Meta) bool {
			_, ok := values[get(t, m)]
			return ok
		}, nil

	case protocol.ExprOpContains:
		get, err := fieldGetter(e.Field)
		if err != nil {
			return nil, err
		}
		if len(e.Values) != 1 {
			return nil, fmt.Errorf("%q needs exactly one value", e.Op)
		}
		needle := strings.ToLower(e.Values[0])
		return func(t protocol.TypeKey, m index.Meta) bool {
			return strings.Contains(strings.ToLower(get(t, m)), needle)
		}, nil

	case protocol.ExprOpSelector:
		if len(e.Values) != 1 {
			return nil, fmt.Errorf("%q needs exactly one value", e.Op)
		}
		selector, err := labels.Parse(e.Values[0])
		if err != nil {
			return nil, fmt.Errorf("invalid label selector: %w", err)
		}
		return func(_ protocol.TypeKey, m index.Meta) bool {
			return selector.Matches(labels.Set(m.Labels))
		}, nil

	default:
		return nil, fmt.Errorf("unknown operator %q", e.Op)
	}
}

func fieldGetter(f protocol.Field) (func(protocol.TypeKey, index.Meta) string, error) {
	switch f {
	case protocol.FieldType:
		return func(t protocol.TypeKey, _ index.Meta) string { return string(t) }, nil
	case protocol.FieldNamespace:
		return func(_ protocol.TypeKey, m index.Meta) string { return m.Namespace }, nil
	case protocol.FieldName:
		return func(_ protocol.TypeKey, m index.Meta) string { return m.Name }, nil
	default:
		return nil, fmt.Errorf("unknown field %q", f)
	}
}

// Types returns the Resource Types the query can match, or nil when it can
// match any type. It is empty but not nil when the query can match no type,
// such as "type in []".
func (q *Compiled) Types() []protocol.TypeKey { return slices.Clone(q.types) }

// scanTypes returns the types an expression can match when it constrains the
// type, so Run can skip every other type. It returns nil when the expression
// can match any type, and never repeats a type.
func scanTypes(e protocol.Expr) []protocol.TypeKey {
	switch {
	case e.Op == protocol.ExprOpIn && e.Field == protocol.FieldType:
		types := make([]protocol.TypeKey, len(e.Values))
		for i, v := range e.Values {
			types[i] = protocol.TypeKey(v)
		}
		slices.Sort(types)
		return slices.Compact(types)
	case e.Op == protocol.ExprOpAnd:
		for _, arg := range e.Args {
			if types := scanTypes(arg); types != nil {
				return types
			}
		}
	case e.Op == protocol.ExprOpOr:
		union := []protocol.TypeKey{}
		for _, arg := range e.Args {
			types := scanTypes(arg)
			if types == nil {
				return nil
			}
			union = append(union, types...)
		}
		slices.Sort(union)
		return slices.Compact(union)
	}
	return nil
}

// Table gives Run the Columns of the one Resource Type a Query selects, and
// the cells of its Resources.
type Table interface {
	// Read calls fn with the type's Columns and a function that returns the
	// cells of the Resource with the given index key, one per Column, or nil
	// when there are none. Run keeps the slices it is given, so they must not
	// change afterwards.
	Read(fn func(columns []protocol.Column, cells func(key string) []any))
}

// Run evaluates a compiled query against a Store and returns one sorted
// window of the matching Resources. With a Table it adds the Table's Columns
// and each Row's cells, and can sort by a Column. Every Row must then be of
// the Table's type.
func Run(store *index.Store, q *Compiled, table Table, sort protocol.Sort, offset, limit int) protocol.QueryResult {
	// Non-nil so an empty window encodes as [] rather than null.
	rows := []protocol.Row{}
	store.Each(q.types, func(t protocol.TypeKey, m index.Meta) {
		if q.match(t, m) {
			rows = append(rows, protocol.Row{
				UID:       m.UID,
				Type:      t,
				Namespace: m.Namespace,
				Name:      m.Name,
				CreatedAt: m.CreatedAt,
			})
		}
	})

	total := len(rows)
	offset = min(max(offset, 0), total)
	end := min(offset+min(max(limit, 0), MaxLimit), total)
	result := protocol.QueryResult{Total: total, Offset: offset}
	attach := func(rows []protocol.Row) func([]protocol.Column, func(string) []any) {
		return func(columns []protocol.Column, cells func(string) []any) {
			result.Columns = columns
			for i := range rows {
				rows[i].Cells = cells(index.Key(rows[i].Namespace, rows[i].Name))
			}
		}
	}

	// Sorting by a Column needs the cells of every match. Any other order
	// only needs those of the window, which is read after it is cut.
	column := -1
	if table != nil && sort.Field == protocol.SortFieldColumn {
		table.Read(func(columns []protocol.Column, cells func(string) []any) {
			column = slices.IndexFunc(columns, func(c protocol.Column) bool { return c.Name == sort.Column })
			if column >= 0 {
				attach(rows)(columns, cells)
			}
		})
	}
	if column >= 0 {
		result.Rows = columnWindow(rows, column, sort.Desc, offset, end)
		return result
	}
	slices.SortFunc(rows, comparator(sort))
	result.Rows = slices.Clip(rows[offset:end])
	if table != nil {
		table.Read(attach(result.Rows))
	}
	return result
}

// columnWindow returns rows[offset:end] of rows ordered by one of their
// cells. Rows without a value in that cell come last, whichever way the rest
// are sorted.
func columnWindow(rows []protocol.Row, column int, desc bool, offset, end int) []protocol.Row {
	// A cell's key is worked out once instead of in every comparison, and the
	// Rows are ordered through their positions, which are cheaper to move.
	keys := make([]sortKey, len(rows))
	order := make([]int32, len(rows))
	for i := range rows {
		if column < len(rows[i].Cells) {
			keys[i] = cellKey(rows[i].Cells[column])
		}
		order[i] = int32(i)
	}
	slices.SortFunc(order, func(a, b int32) int {
		switch aAbsent, bAbsent := keys[a].kind == kindAbsent, keys[b].kind == kindAbsent; {
		case aAbsent && !bAbsent:
			return 1
		case bAbsent && !aAbsent:
			return -1
		}
		c := cmp.Or(compareKeys(keys[a], keys[b]), compareIdentity(rows[a], rows[b]))
		if desc {
			return -c
		}
		return c
	})
	window := make([]protocol.Row, 0, end-offset)
	for _, i := range order[offset:end] {
		window = append(window, rows[i])
	}
	return window
}

// compareIdentity orders Rows by what identifies them, so that Rows that are
// otherwise equal always come out in the same order.
func compareIdentity(a, b protocol.Row) int {
	return cmp.Or(
		cmp.Compare(a.Name, b.Name),
		cmp.Compare(a.Namespace, b.Namespace),
		cmp.Compare(a.Type, b.Type),
	)
}

func comparator(s protocol.Sort) func(a, b protocol.Row) int {
	var primary func(a, b protocol.Row) int
	switch s.Field {
	case protocol.SortFieldNamespace:
		primary = func(a, b protocol.Row) int { return cmp.Compare(a.Namespace, b.Namespace) }
	case protocol.SortFieldAge:
		// Ascending age puts the youngest, most recently created, first.
		primary = func(a, b protocol.Row) int { return b.CreatedAt.Compare(a.CreatedAt) }
	default:
		primary = func(protocol.Row, protocol.Row) int { return 0 }
	}
	return func(a, b protocol.Row) int {
		c := cmp.Or(primary(a, b), compareIdentity(a, b))
		if s.Desc {
			return -c
		}
		return c
	}
}
