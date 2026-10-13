package server

import (
	"cmp"
	"context"
	"fmt"
	"slices"

	"github.com/jimeh/hukube/engine/internal/cluster"
	"github.com/jimeh/hukube/engine/internal/index"
	"github.com/jimeh/hukube/engine/internal/protocol"
	"github.com/jimeh/hukube/engine/internal/relationship"
)

func init() {
	handleTopic(protocol.TopicResourceRelated, func(ctx context.Context, srv *Server, p protocol.RelatedParams, notify func()) (*live[protocol.Related], error) {
		c, err := srv.cfg.Clusters.Get(p.Cluster)
		if err != nil {
			return nil, err
		}
		tables := &relatedTables{ctx: ctx, notify: notify, held: make(map[protocol.TypeKey]relatedTable), acquire: func(key protocol.TypeKey) (relatedWatch, func()) { return c.Table(key) }}
		stop := forward(ctx, notify, c.Graph.Changed, c.StatusChanged)
		return &live[protocol.Related]{
			compute: func() (protocol.Related, bool, error) {
				value, ok, err := relatedValue(c, p)
				if err != nil || !ok || !p.Cells {
					tables.stop()
					return value, ok, err
				}
				tables.attach(&value)
				return value, true, nil
			},
			stop: func() { stop(); tables.stop() },
		}, nil
	})
}

type relatedTable struct {
	table relatedWatch
	stop  func()
}

// relatedTables is used only by its subscription's compute and stop goroutine.
type relatedTables struct {
	ctx     context.Context
	notify  func()
	acquire func(protocol.TypeKey) (relatedWatch, func())
	held    map[protocol.TypeKey]relatedTable
}

type relatedWatch interface {
	relatedCells
	Changed() (<-chan struct{}, func())
}

func (ts *relatedTables) stop() {
	for key, t := range ts.held {
		t.stop()
		delete(ts.held, key)
	}
}

func (ts *relatedTables) attach(value *protocol.Related) {
	selected := relatedTableTypes(value.Sections)
	for key, t := range ts.held {
		if !slices.Contains(selected, key) {
			t.stop()
			delete(ts.held, key)
		}
	}
	for _, key := range selected {
		if _, ok := ts.held[key]; !ok {
			table, release := ts.acquire(key)
			stopChanges := forward(ts.ctx, ts.notify, table.Changed)
			ts.held[key] = relatedTable{table: table, stop: func() { stopChanges(); release() }}
		}
		attachRelatedCells(value, key, ts.held[key].table)
	}
}

type relatedCluster interface {
	Type(protocol.TypeKey) (protocol.ResourceType, bool)
	Status() protocol.ClusterStatus
}

func relatedState(c relatedCluster, p protocol.RelatedParams, found bool) (bool, error) {
	typ, ok := c.Type(p.Type)
	if !ok {
		if c.Status().Phase != protocol.ClusterPhaseReady {
			return false, nil
		}
		return false, fmt.Errorf("%w: %s", cluster.ErrUnknownType, p.Type)
	}
	switch typ.State {
	case protocol.TypeStateForbidden:
		return false, &protocol.ErrorDetail{Code: protocol.ErrorCodeForbidden, Message: fmt.Sprintf("Your credentials cannot list %s", p.Type)}
	case protocol.TypeStateFailed:
		return false, fmt.Errorf("cannot index Resource Type %s", p.Type)
	case protocol.TypeStateSyncing:
		return found, nil
	default:
		return true, nil
	}
}

func relatedValue(c *cluster.Cluster, p protocol.RelatedParams) (protocol.Related, bool, error) {
	value := protocol.Related{Sections: []protocol.RelatedSection{}, Types: []protocol.RelatedType{}}
	node, found := c.Graph.Node(p.Type, p.Namespace, p.Name)
	ok, err := relatedState(c, p, found)
	if err != nil || !ok {
		return value, ok, err
	}
	value.Found = found
	if found {
		value.Sections = c.Graph.Related(node, relationship.DefaultLimits())
		for _, s := range value.Sections {
			value.Total += s.Total
		}
	}
	return value, true, nil
}

const maxRelatedTables = 6

// relatedTableTypes favors the types whose cells will fill the most rows.
func relatedTableTypes(sections []protocol.RelatedSection) []protocol.TypeKey {
	counts := make(map[protocol.TypeKey]int)
	for _, s := range sections {
		for _, row := range s.Rows {
			if row.Status == protocol.RelatedStatusFound || row.Status == protocol.RelatedStatusSelf {
				counts[row.Type]++
			}
		}
	}
	types := make([]protocol.TypeKey, 0, len(counts))
	for key := range counts {
		types = append(types, key)
	}
	slices.SortFunc(types, func(a, b protocol.TypeKey) int { return cmp.Or(cmp.Compare(counts[b], counts[a]), cmp.Compare(a, b)) })
	types = types[:min(len(types), maxRelatedTables)]
	// Ranking picks the held Tables; key order makes the wire answer stable.
	slices.Sort(types)
	return types
}

type relatedCells interface {
	Read(func([]protocol.Column, func(string) []any))
}

func attachRelatedCells(value *protocol.Related, key protocol.TypeKey, table relatedCells) {
	table.Read(func(columns []protocol.Column, cells func(string) []any) {
		typ := protocol.RelatedType{Type: key, Columns: []protocol.Column{}}
		positions := []int{}
		for i, column := range columns {
			if column.Priority == 0 {
				typ.Columns = append(typ.Columns, column)
				positions = append(positions, i)
			}
		}
		value.Types = append(value.Types, typ)
		for si := range value.Sections {
			for ri := range value.Sections[si].Rows {
				row := &value.Sections[si].Rows[ri]
				if row.Type != key || (row.Status != protocol.RelatedStatusFound && row.Status != protocol.RelatedStatusSelf) {
					continue
				}
				raw := cells(index.Key(row.Namespace, row.Name))
				if raw == nil {
					continue
				}
				row.Cells = make([]any, len(positions))
				for i, pos := range positions {
					if pos < len(raw) {
						row.Cells[i] = raw[pos]
					}
				}
			}
		}
	})
}
