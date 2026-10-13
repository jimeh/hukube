package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/jimeh/hukube/engine/internal/cluster"
	"github.com/jimeh/hukube/engine/internal/index"
	"github.com/jimeh/hukube/engine/internal/protocol"
	"github.com/jimeh/hukube/engine/internal/query"
)

// request answers a single request.
type request func(ctx context.Context, srv *Server, params json.RawMessage) (any, error)

// topic starts a subscription. compute returns the current value, or nil when
// there is nothing to send yet; notify must be called whenever it may have
// changed. stop releases everything the topic started.
//
// compute must encode the same state to the same JSON every time, such as by
// sorting slices built from maps, because the session skips values identical
// to the last one it sent.
type topic func(ctx context.Context, srv *Server, params json.RawMessage, notify func()) (*liveValue, error)

type liveValue struct {
	compute func() (any, error)
	stop    func()
}

var requests = map[protocol.Method]request{}
var topics = map[protocol.Method]topic{}

// live is the typed value a topic computes before registration erases its type.
type live[D any] struct {
	compute func() (D, bool, error)
	stop    func()
}

// handleRequest registers a typed handler for a declared request.
func handleRequest[P, R any](method protocol.Request[P, R], handler func(context.Context, *Server, P) (R, error)) {
	if _, ok := requests[method.Name]; ok {
		panic("server: duplicate request handler " + method.Name)
	}
	requests[method.Name] = func(ctx context.Context, srv *Server, raw json.RawMessage) (any, error) {
		p, err := decode[P](raw)
		if err != nil {
			return nil, err
		}
		result, err := handler(ctx, srv, p)
		if _, ok := any(result).(protocol.None); ok {
			return nil, err
		}
		return result, err
	}
}

// handleTopic registers a typed handler for a declared subscription topic.
func handleTopic[P, D any](method protocol.Topic[P, D], handler func(context.Context, *Server, P, func()) (*live[D], error)) {
	if _, ok := topics[method.Name]; ok {
		panic("server: duplicate topic handler " + method.Name)
	}
	topics[method.Name] = func(ctx context.Context, srv *Server, raw json.RawMessage, notify func()) (*liveValue, error) {
		p, err := decode[P](raw)
		if err != nil {
			return nil, err
		}
		value, err := handler(ctx, srv, p, notify)
		if err != nil {
			return nil, err
		}
		return &liveValue{
			compute: func() (any, error) {
				data, ok, err := value.compute()
				if !ok {
					return nil, err
				}
				return data, err
			},
			stop: value.stop,
		}, nil
	}
}

func init() {
	handleRequest(protocol.RequestClustersList, func(_ context.Context, srv *Server, _ protocol.None) ([]protocol.Cluster, error) {
		return srv.cfg.Source.Clusters()
	})
	handleRequest(protocol.RequestSettingsPut, func(_ context.Context, srv *Server, p protocol.Setting) (protocol.None, error) {
		return protocol.None{}, srv.cfg.Settings.Put(p.Key, p.Value)
	})
	handleTopic(protocol.TopicClusterStatus, func(ctx context.Context, srv *Server, p protocol.ClusterParams, notify func()) (*live[protocol.ClusterStatus], error) {
		c, err := srv.cfg.Clusters.Get(p.Cluster)
		if err != nil {
			return nil, err
		}
		return &live[protocol.ClusterStatus]{
			compute: func() (protocol.ClusterStatus, bool, error) { return c.Status(), true, nil },
			stop:    forward(ctx, notify, c.StatusChanged),
		}, nil
	})

	handleTopic(protocol.TopicClusterTypes, func(ctx context.Context, srv *Server, p protocol.ClusterParams, notify func()) (*live[[]protocol.ResourceType], error) {
		c, err := srv.cfg.Clusters.Get(p.Cluster)
		if err != nil {
			return nil, err
		}
		return &live[[]protocol.ResourceType]{
			compute: func() ([]protocol.ResourceType, bool, error) { return c.Types(), true, nil },
			stop:    forward(ctx, notify, c.TypesChanged, allChanges(c)),
		}, nil
	})

	handleTopic(protocol.TopicResourcesQuery, func(ctx context.Context, srv *Server, p protocol.QueryParams, notify func()) (*live[protocol.QueryResult], error) {
		q, err := query.Compile(p.Where)
		if err != nil {
			return nil, badRequest(err)
		}
		if p.Columns && len(q.Types()) != 1 {
			return nil, badRequest(errors.New("columns need a Query that selects exactly one Resource Type"))
		}
		c, err := srv.cfg.Clusters.Get(p.Cluster)
		if err != nil {
			return nil, err
		}
		if !p.Columns {
			return &live[protocol.QueryResult]{
				compute: func() (protocol.QueryResult, bool, error) {
					return query.Run(c.Index, q, nil, p.Sort, p.Offset, p.Limit), true, nil
				},
				stop: forward(ctx, notify, queryChanges(c.Index, q)),
			}, nil
		}
		// The Cluster watches the type's Table for as long as a subscription
		// holds it, so cells also change without the index changing.
		table, release := c.Table(q.Types()[0])
		stop := forward(ctx, notify, queryChanges(c.Index, q), table.Changed)
		return &live[protocol.QueryResult]{
			compute: func() (protocol.QueryResult, bool, error) {
				return query.Run(c.Index, q, table, p.Sort, p.Offset, p.Limit), true, nil
			},
			stop: func() {
				stop()
				release()
			},
		}, nil
	})

	handleTopic(protocol.TopicResourcesFind, func(ctx context.Context, srv *Server, p protocol.FindParams, notify func()) (*live[protocol.FindResult], error) {
		q, err := query.Compile(p.Where)
		if err != nil {
			return nil, badRequest(err)
		}
		c, err := srv.cfg.Clusters.Get(p.Cluster)
		if err != nil {
			return nil, err
		}
		finder := finders.Get().(*query.Finder)
		stop := forward(ctx, notify, queryChanges(c.Index, q))
		return &live[protocol.FindResult]{
			compute: func() (protocol.FindResult, bool, error) { return finder.Find(c.Index, q, p), true, nil },
			stop: func() {
				stop()
				finders.Put(finder)
			},
		}, nil
	})

	handleTopic(protocol.TopicResourceGet, func(ctx context.Context, srv *Server, p protocol.ResourceRef, notify func()) (*live[protocol.ResourceData], error) {
		c, err := srv.cfg.Clusters.Get(p.Cluster)
		if err != nil {
			return nil, err
		}

		return watchValue(ctx, notify, func(ctx context.Context, emit func(protocol.ResourceData), onErr func(error)) {
			c.WatchObject(ctx, p, emit, onErr)
		}), nil
	})

	handleTopic(protocol.TopicResourceEvents, func(ctx context.Context, srv *Server, p protocol.ResourceEventsParams, notify func()) (*live[protocol.ResourceEvents], error) {
		c, err := srv.cfg.Clusters.Get(p.Cluster)
		if err != nil {
			return nil, err
		}

		return watchValue(ctx, notify, func(ctx context.Context, emit func(protocol.ResourceEvents), onErr func(error)) {
			c.WatchEvents(ctx, p, emit, onErr)
		}), nil
	})

	handleTopic(protocol.TopicSettingsWatch, func(ctx context.Context, srv *Server, p protocol.SettingKey, notify func()) (*live[protocol.Setting], error) {
		return &live[protocol.Setting]{
			compute: func() (protocol.Setting, bool, error) {
				v, err := srv.cfg.Settings.Get(p.Key)
				if err != nil {
					return protocol.Setting{}, false, err
				}
				return protocol.Setting{Key: p.Key, Value: v}, true, nil
			},
			stop: forward(ctx, notify, func() (<-chan struct{}, func()) { return srv.cfg.Settings.Watch(p.Key) }),
		}, nil
	})
}

// watchValue holds a watch's latest value or error until the subscription stops.
func watchValue[D any](ctx context.Context, notify func(), start func(context.Context, func(D), func(error))) *live[D] {
	var (
		mu      sync.Mutex
		latest  *D
		lastErr error
	)
	wctx, cancel := context.WithCancel(ctx)
	start(wctx,
		func(d D) {
			mu.Lock()
			latest, lastErr = &d, nil
			mu.Unlock()
			notify()
		},
		func(err error) {
			mu.Lock()
			lastErr = err
			mu.Unlock()
			notify()
		},
	)
	return &live[D]{
		compute: func() (D, bool, error) {
			mu.Lock()
			defer mu.Unlock()
			if lastErr != nil {
				var zero D
				return zero, false, lastErr
			}
			if latest == nil {
				var zero D
				return zero, false, nil
			}
			return *latest, true, nil
		},
		stop: cancel,
	}
}

// finders holds Finders between find subscriptions. Typing restarts a find
// with new params on every keystroke, and pooling lets each restart reuse the
// previous one's scratch space, which grows to the number of Resources it
// scans. A Finder is only used by the subscription that took it, because
// compute and stop run on that subscription's goroutine.
var finders = sync.Pool{New: func() any { return query.NewFinder() }}

// allChanges subscribes to changes of every type in a Cluster's index.
func allChanges(c *cluster.Cluster) func() (<-chan struct{}, func()) {
	return func() (<-chan struct{}, func()) { return c.Index.Changed() }
}

// queryChanges subscribes to changes of the types a Query can match. A Query
// that can match no type never changes.
func queryChanges(store *index.Store, q *query.Compiled) func() (<-chan struct{}, func()) {
	return func() (<-chan struct{}, func()) {
		types := q.Types()
		if types != nil && len(types) == 0 {
			return nil, func() {}
		}
		return store.Changed(types...)
	}
}

func decode[P any](raw json.RawMessage) (P, error) {
	var p P
	if _, ok := any(p).(protocol.None); ok {
		return p, nil
	}
	if len(raw) == 0 {
		return p, badRequest(fmt.Errorf("missing params"))
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, badRequest(fmt.Errorf("invalid params: %w", err))
	}
	return p, nil
}

// forward calls notify whenever any of the given signals fires, until the
// returned stop function is called or ctx ends.
func forward(ctx context.Context, notify func(), signals ...func() (<-chan struct{}, func())) func() {
	ctx, cancel := context.WithCancel(ctx)
	unsubs := make([]func(), 0, len(signals))
	for _, subscribe := range signals {
		ch, unsub := subscribe()
		unsubs = append(unsubs, unsub)
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case <-ch:
					notify()
				}
			}
		}()
	}
	return func() {
		cancel()
		for _, unsub := range unsubs {
			unsub()
		}
	}
}
