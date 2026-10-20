package server

import (
	"testing"

	"github.com/jimeh/hukube/engine/internal/index"
	"github.com/jimeh/hukube/engine/internal/protocol"
	"github.com/jimeh/hukube/engine/internal/query"
)

// Query and find subscriptions must wake for changes to the types their
// Query can match, and only for those when the Query constrains the type.
func TestQueryChangesFollowTheQuerysTypes(t *testing.T) {
	in := func(types ...string) *protocol.Expr {
		return &protocol.Expr{Op: protocol.ExprOpIn, Field: protocol.FieldType, Values: types}
	}
	tests := []struct {
		name  string
		where *protocol.Expr
		wake  map[protocol.TypeKey]bool
	}{
		{name: "constrained", where: in("pods", "services"), wake: map[protocol.TypeKey]bool{"pods": true, "services": true, "secrets": false}},
		{name: "unconstrained", where: nil, wake: map[protocol.TypeKey]bool{"pods": true, "secrets": true}},
		{name: "no type", where: in(), wake: map[protocol.TypeKey]bool{"pods": false, "secrets": false}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := index.New()
			q, err := query.Compile(tt.where)
			if err != nil {
				t.Fatal(err)
			}
			ch, stop := queryChanges(store, q)()
			defer stop()
			for typ, want := range tt.wake {
				// Signals are sent before Apply returns, so no waiting is needed.
				store.Apply([]index.Change{{Kind: index.Added, Type: typ, Meta: index.Meta{Name: "x"}}})
				got := false
				select {
				case <-ch:
					got = true
				default:
				}
				if got != want {
					t.Errorf("change to %s woke the subscription: %v, want %v", typ, got, want)
				}
			}
		})
	}
}

func TestMethodHandlersMatchDeclarations(t *testing.T) {
	declared := make(map[protocol.Method]protocol.MethodKind)
	for _, method := range protocol.Methods() {
		declared[method.Name] = method.Kind
		switch method.Kind {
		case protocol.MethodKindRequest:
			if requests[method.Name] == nil {
				t.Errorf("request %q has no handler", method.Name)
			}
		case protocol.MethodKindStream:
			if streams[method.Name] == nil {
				t.Errorf("stream %q has no handler", method.Name)
			}
		case protocol.MethodKindTopic:
			if topics[method.Name] == nil {
				t.Errorf("topic %q has no handler", method.Name)
			}
		}
	}
	for name := range requests {
		if declared[name] != protocol.MethodKindRequest {
			t.Errorf("request handler %q has no declaration", name)
		}
	}
	for name := range streams {
		if declared[name] != protocol.MethodKindStream {
			t.Errorf("stream handler %q has no declaration", name)
		}
	}
	for name := range topics {
		if declared[name] != protocol.MethodKindTopic {
			t.Errorf("topic handler %q has no declaration", name)
		}
	}
}
