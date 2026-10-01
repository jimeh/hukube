// Package query evaluates Query expressions against a Cluster's index.
package query

import (
	"cmp"
	"fmt"
	"slices"
	"strings"

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

// scanTypes returns the types an expression can match when it constrains the
// type at the top level, so Run can skip every other type.
func scanTypes(e protocol.Expr) []protocol.TypeKey {
	switch {
	case e.Op == protocol.ExprOpIn && e.Field == protocol.FieldType:
		types := make([]protocol.TypeKey, len(e.Values))
		for i, v := range e.Values {
			types[i] = protocol.TypeKey(v)
		}
		return types
	case e.Op == protocol.ExprOpAnd:
		for _, arg := range e.Args {
			if types := scanTypes(arg); types != nil {
				return types
			}
		}
	}
	return nil
}

// Run evaluates a compiled query against a Store and returns one sorted
// window of the matching Resources.
func Run(store *index.Store, q *Compiled, sort protocol.Sort, offset, limit int) protocol.QueryResult {
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

	slices.SortFunc(rows, comparator(sort))

	total := len(rows)
	offset = min(max(offset, 0), total)
	end := min(offset+min(max(limit, 0), MaxLimit), total)
	return protocol.QueryResult{
		Total:  total,
		Offset: offset,
		Rows:   slices.Clip(rows[offset:end]),
	}
}

func comparator(s protocol.Sort) func(a, b protocol.Row) int {
	tiebreak := func(a, b protocol.Row) int {
		return cmp.Or(
			cmp.Compare(a.Name, b.Name),
			cmp.Compare(a.Namespace, b.Namespace),
			cmp.Compare(a.Type, b.Type),
		)
	}
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
		c := cmp.Or(primary(a, b), tiebreak(a, b))
		if s.Desc {
			return -c
		}
		return c
	}
}
