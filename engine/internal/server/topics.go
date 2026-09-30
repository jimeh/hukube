package server

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/jimeh/hukube/engine/internal/protocol"
	"github.com/jimeh/hukube/engine/internal/query"
)

// request answers a single request.
type request func(ctx context.Context, srv *Server, params json.RawMessage) (any, error)

// topic starts a subscription. compute returns the current value, or nil when
// there is nothing to send yet; notify must be called whenever it may have
// changed. stop releases everything the topic started.
type topic func(ctx context.Context, srv *Server, params json.RawMessage, notify func()) (*liveValue, error)

type liveValue struct {
	compute func() (any, error)
	stop    func()
}

var requests = map[protocol.Method]request{
	protocol.MethodClustersList: func(_ context.Context, srv *Server, _ json.RawMessage) (any, error) {
		return srv.cfg.Source.Clusters()
	},
	protocol.MethodSettingsPut: func(_ context.Context, srv *Server, raw json.RawMessage) (any, error) {
		p, err := decode[protocol.Setting](raw)
		if err != nil {
			return nil, err
		}
		return nil, srv.cfg.Settings.Put(p.Key, p.Value)
	},
}

var topics = map[protocol.Method]topic{
	protocol.MethodClusterStatus: func(ctx context.Context, srv *Server, raw json.RawMessage, notify func()) (*liveValue, error) {
		p, err := decode[protocol.ClusterParams](raw)
		if err != nil {
			return nil, err
		}
		c, err := srv.cfg.Clusters.Get(p.Cluster)
		if err != nil {
			return nil, err
		}
		return &liveValue{
			compute: func() (any, error) { return c.Status(), nil },
			stop:    forward(ctx, notify, c.StatusChanged),
		}, nil
	},

	protocol.MethodClusterTypes: func(ctx context.Context, srv *Server, raw json.RawMessage, notify func()) (*liveValue, error) {
		p, err := decode[protocol.ClusterParams](raw)
		if err != nil {
			return nil, err
		}
		c, err := srv.cfg.Clusters.Get(p.Cluster)
		if err != nil {
			return nil, err
		}
		return &liveValue{
			compute: func() (any, error) { return c.Types(), nil },
			stop:    forward(ctx, notify, c.TypesChanged, c.Index.Changed),
		}, nil
	},

	protocol.MethodResourcesQuery: func(ctx context.Context, srv *Server, raw json.RawMessage, notify func()) (*liveValue, error) {
		p, err := decode[protocol.QueryParams](raw)
		if err != nil {
			return nil, err
		}
		q, err := query.Compile(p.Where)
		if err != nil {
			return nil, badRequest(err)
		}
		c, err := srv.cfg.Clusters.Get(p.Cluster)
		if err != nil {
			return nil, err
		}
		return &liveValue{
			compute: func() (any, error) { return query.Run(c.Index, q, p.Sort, p.Offset, p.Limit), nil },
			stop:    forward(ctx, notify, c.Index.Changed),
		}, nil
	},

	protocol.MethodResourceGet: func(ctx context.Context, srv *Server, raw json.RawMessage, notify func()) (*liveValue, error) {
		p, err := decode[protocol.ResourceRef](raw)
		if err != nil {
			return nil, err
		}
		c, err := srv.cfg.Clusters.Get(p.Cluster)
		if err != nil {
			return nil, err
		}

		var (
			mu      sync.Mutex
			latest  *protocol.ResourceData
			lastErr error
		)
		wctx, cancel := context.WithCancel(ctx)
		err = c.WatchObject(wctx, p,
			func(d protocol.ResourceData) {
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
		if err != nil {
			cancel()
			return nil, err
		}
		return &liveValue{
			compute: func() (any, error) {
				mu.Lock()
				defer mu.Unlock()
				if lastErr != nil {
					return nil, lastErr
				}
				if latest == nil {
					return nil, nil
				}
				return latest, nil
			},
			stop: cancel,
		}, nil
	},

	protocol.MethodSettingsWatch: func(ctx context.Context, srv *Server, raw json.RawMessage, notify func()) (*liveValue, error) {
		p, err := decode[protocol.SettingKey](raw)
		if err != nil {
			return nil, err
		}
		return &liveValue{
			compute: func() (any, error) {
				v, err := srv.cfg.Settings.Get(p.Key)
				if err != nil {
					return nil, err
				}
				return protocol.Setting{Key: p.Key, Value: v}, nil
			},
			stop: forward(ctx, notify, func() (<-chan struct{}, func()) { return srv.cfg.Settings.Watch(p.Key) }),
		}, nil
	},
}

func decode[P any](raw json.RawMessage) (P, error) {
	var p P
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
