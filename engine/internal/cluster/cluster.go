// Package cluster connects to Clusters and keeps their index current.
package cluster

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/metadata"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/cache"

	"github.com/jimeh/hukube/engine/internal/index"
	"github.com/jimeh/hukube/engine/internal/kubeconfig"
	"github.com/jimeh/hukube/engine/internal/notify"
	"github.com/jimeh/hukube/engine/internal/protocol"
)

// Resource Types whose changes can add or remove other Resource Types.
const (
	crdType        protocol.TypeKey = "customresourcedefinitions.apiextensions.k8s.io"
	apiServiceType protocol.TypeKey = "apiservices.apiregistration.k8s.io"
)

// Timing controls a Cluster's retries, discovery refreshes, and health
// checks. Each Cluster copies it when created, so tests can shorten it without
// racing Clusters that are already running.
type Timing struct {
	RetryMin        time.Duration
	RetryMax        time.Duration
	DiscoveryDelay  time.Duration
	DiscoveryPeriod time.Duration
	HealthPeriod    time.Duration
	HealthTimeout   time.Duration
	ObjectRetry     time.Duration
}

// DefaultTiming is the Timing used by NewManager.
var DefaultTiming = Timing{
	RetryMin:        2 * time.Second,
	RetryMax:        time.Minute,
	DiscoveryDelay:  2 * time.Second,
	DiscoveryPeriod: 5 * time.Minute,
	HealthPeriod:    30 * time.Second,
	HealthTimeout:   10 * time.Second,
	ObjectRetry:     2 * time.Second,
}

// ErrUnknownType is returned for a TypeKey the Cluster does not serve.
var ErrUnknownType = errors.New("unknown resource type")

// Manager owns the Engine's connections to Clusters. Each Cluster is
// connected on first use and stays connected until the Manager's context ends.
type Manager struct {
	ctx    context.Context
	source kubeconfig.Source
	log    *slog.Logger
	timing Timing

	mu       sync.Mutex
	clusters map[string]*Cluster
}

// NewManager returns a Manager whose connections live as long as ctx.
func NewManager(ctx context.Context, source kubeconfig.Source, log *slog.Logger) *Manager {
	return NewManagerWithTiming(ctx, source, log, DefaultTiming)
}

// NewManagerWithTiming returns a Manager whose Clusters use the given Timing.
func NewManagerWithTiming(ctx context.Context, source kubeconfig.Source, log *slog.Logger, timing Timing) *Manager {
	return &Manager{ctx: ctx, source: source, log: log, timing: timing, clusters: make(map[string]*Cluster)}
}

// Get returns the Cluster with the given ID, connecting to it if needed.
func (m *Manager) Get(id string) (*Cluster, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.clusters[id]; ok {
		return c, nil
	}
	cfg, err := m.source.RESTConfig(id)
	if err != nil {
		return nil, err
	}
	c, err := newCluster(id, cfg, m.log.With("cluster", id), m.timing)
	if err != nil {
		return nil, err
	}
	m.clusters[id] = c
	go c.run(m.ctx)
	return c, nil
}

// Cluster is the Engine's live connection to one Cluster.
type Cluster struct {
	id     string
	log    *slog.Logger
	timing Timing
	disc   discovery.DiscoveryInterface
	// probe checks reachability with a short timeout; disc has none, because
	// the clients sharing its configuration hold long-lived watches.
	probe discovery.DiscoveryInterface
	meta  metadata.Interface
	dyn   dynamic.Interface

	// Index holds metadata for every Resource of every indexed type.
	Index *index.Store

	mu            sync.Mutex
	status        protocol.ClusterStatus
	types         map[protocol.TypeKey]*indexedType
	statusChanged notify.Signal
	typesChanged  notify.Signal
	rediscover    chan struct{}
}

// indexedType is one generation of indexing for a Resource Type. Discovery
// replaces the whole value when it restarts a type, so callbacks from an
// older generation can tell they are stale by pointer identity.
type indexedType struct {
	// key never changes, so it may be read without holding Cluster.mu.
	key    protocol.TypeKey
	info   protocol.ResourceType
	gvr    schema.GroupVersionResource
	cancel context.CancelFunc
}

func newCluster(id string, cfg *rest.Config, log *slog.Logger, timing Timing) (*Cluster, error) {
	cfg = rest.CopyConfig(cfg)
	cfg.QPS = 100
	cfg.Burst = 200
	cfg.UserAgent = "hukube"
	cfg.WarningHandler = rest.NoWarnings{}

	disc, err := discovery.NewDiscoveryClientForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("discovery client: %w", err)
	}
	probeCfg := rest.CopyConfig(cfg)
	probeCfg.Timeout = timing.HealthTimeout
	probe, err := discovery.NewDiscoveryClientForConfig(probeCfg)
	if err != nil {
		return nil, fmt.Errorf("probe client: %w", err)
	}
	meta, err := metadata.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("metadata client: %w", err)
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("dynamic client: %w", err)
	}
	return &Cluster{
		id:         id,
		log:        log,
		timing:     timing,
		disc:       disc,
		probe:      probe,
		meta:       meta,
		dyn:        dyn,
		Index:      index.New(),
		status:     protocol.ClusterStatus{Phase: protocol.ClusterPhaseConnecting},
		types:      make(map[protocol.TypeKey]*indexedType),
		rediscover: make(chan struct{}, 1),
	}, nil
}

// Status returns the current connection status.
func (c *Cluster) Status() protocol.ClusterStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.status
}

// StatusChanged signals after Status changes.
func (c *Cluster) StatusChanged() (<-chan struct{}, func()) {
	return c.statusChanged.Subscribe()
}

// Types returns every indexed Resource Type, sorted by key, with current
// Resource counts.
func (c *Cluster) Types() []protocol.ResourceType {
	c.mu.Lock()
	types := make([]protocol.ResourceType, 0, len(c.types))
	for _, t := range c.types {
		types = append(types, t.info)
	}
	c.mu.Unlock()

	for i := range types {
		types[i].Count = c.Index.Count(types[i].Key)
	}
	slices.SortFunc(types, func(a, b protocol.ResourceType) int { return strings.Compare(string(a.Key), string(b.Key)) })
	return types
}

// TypesChanged signals after the set of types or their states change. Count
// changes are signalled by Index.Changed instead.
func (c *Cluster) TypesChanged() (<-chan struct{}, func()) {
	return c.typesChanged.Subscribe()
}

// resolve returns where a type is currently served. It copies the fields
// because discovery updates them under c.mu.
func (c *Cluster) resolve(key protocol.TypeKey) (gvr schema.GroupVersionResource, namespaced bool, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	t, ok := c.types[key]
	if !ok {
		return schema.GroupVersionResource{}, false, false
	}
	return t.gvr, t.info.Namespaced, true
}

func (c *Cluster) setStatus(s protocol.ClusterStatus) {
	c.mu.Lock()
	c.status = s
	c.mu.Unlock()
	c.statusChanged.Notify()
}

func (c *Cluster) run(ctx context.Context) {
	for delay := c.timing.RetryMin; ; delay = min(delay*2, c.timing.RetryMax) {
		err := c.connect(ctx)
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			return
		}
		c.log.Warn("connect failed", "err", err, "retry", delay)
		c.setStatus(protocol.ClusterStatus{Phase: protocol.ClusterPhaseFailed, Message: err.Error()})
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
	}

	// Probe health separately, so a slow discovery cannot delay noticing an
	// outage.
	go c.watchHealth(ctx)

	ticker := time.NewTicker(c.timing.DiscoveryPeriod)
	defer ticker.Stop()
	for {
		periodic := false
		select {
		case <-ctx.Done():
			return
		case <-c.rediscover:
			// Let a burst of CRD or APIService changes settle first.
			select {
			case <-ctx.Done():
				return
			case <-time.After(c.timing.DiscoveryDelay):
			}
			select {
			case <-c.rediscover:
			default:
			}
		case <-ticker.C:
			periodic = true
		}
		if err := c.discover(ctx, periodic); err != nil {
			c.log.Warn("discovery failed", "err", err)
		}
	}
}

func (c *Cluster) watchHealth(ctx context.Context) {
	ticker := time.NewTicker(c.timing.HealthPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.checkHealth()
		}
	}
}

// checkHealth reports losing and regaining the API server after the first
// connection, so clients do not show stale lists as healthy.
func (c *Cluster) checkHealth() {
	version, err := c.probe.ServerVersion()
	status := c.Status()
	switch {
	case err != nil && status.Phase == protocol.ClusterPhaseReady:
		c.log.Warn("lost connection", "err", err)
		c.setStatus(protocol.ClusterStatus{
			Phase:         protocol.ClusterPhaseFailed,
			Message:       "Lost connection: " + err.Error(),
			ServerVersion: status.ServerVersion,
		})
	case err == nil && status.Phase != protocol.ClusterPhaseReady:
		c.setStatus(protocol.ClusterStatus{Phase: protocol.ClusterPhaseReady, ServerVersion: version.GitVersion})
	}
}

func (c *Cluster) connect(ctx context.Context) error {
	version, err := c.disc.ServerVersion()
	if err != nil {
		return fmt.Errorf("server version: %w", err)
	}
	if err := c.discover(ctx, false); err != nil {
		return err
	}
	c.setStatus(protocol.ClusterStatus{Phase: protocol.ClusterPhaseReady, ServerVersion: version.GitVersion})
	return nil
}

// discover reconciles the indexed types with the Cluster's API discovery,
// starting and stopping a watch per type. retryRefused also restarts types the
// Cluster refused to serve, in case permissions or the API changed since. Only
// the periodic refresh sets it, so bursts of CRD changes do not re-list every
// refused type each time.
func (c *Cluster) discover(ctx context.Context, retryRefused bool) error {
	lists, err := c.disc.ServerPreferredResources()
	var failedGroups map[schema.GroupVersion]error
	if err != nil {
		var groupErr *discovery.ErrGroupDiscoveryFailed
		if !errors.As(err, &groupErr) {
			return fmt.Errorf("discovery: %w", err)
		}
		// Keep indexing types from groups that failed discovery this time.
		failedGroups = groupErr.Groups
		c.log.Warn("partial discovery", "err", err)
	}

	desired := make(map[protocol.TypeKey]*indexedType)
	for _, list := range lists {
		gv, err := schema.ParseGroupVersion(list.GroupVersion)
		if err != nil {
			continue
		}
		for _, r := range list.APIResources {
			if strings.Contains(r.Name, "/") || !slices.Contains(r.Verbs, "list") || !slices.Contains(r.Verbs, "watch") {
				continue
			}
			key := protocol.TypeKey(r.Name)
			if gv.Group != "" {
				key = protocol.TypeKey(r.Name + "." + gv.Group)
			}
			desired[key] = &indexedType{
				key: key,
				gvr: gv.WithResource(r.Name),
				info: protocol.ResourceType{
					Key:        key,
					Group:      gv.Group,
					Version:    gv.Version,
					Resource:   r.Name,
					Kind:       r.Kind,
					Namespaced: r.Namespaced,
					Verbs:      r.Verbs,
					ShortNames: r.ShortNames,
					Categories: r.Categories,
					State:      protocol.TypeStateSyncing,
				},
			}
		}
	}

	c.mu.Lock()
	for key, current := range c.types {
		want, ok := desired[key]
		switch {
		case !ok && groupFailed(failedGroups, current.gvr):
			continue
		case !ok:
			current.cancel()
			delete(c.types, key)
			c.Index.RemoveType(key)
		case want.gvr != current.gvr,
			retryRefused && current.info.State == protocol.TypeStateForbidden,
			retryRefused && current.info.State == protocol.TypeStateFailed:
			// Re-watch when the preferred version changed, or retry a refused
			// type.
			current.cancel()
			c.Index.RemoveType(key)
			c.types[key] = want
			c.startType(ctx, want)
		default:
			current.info = withState(want.info, current.info.State)
		}
	}
	for key, want := range desired {
		if _, ok := c.types[key]; !ok {
			c.types[key] = want
			c.startType(ctx, want)
		}
	}
	c.mu.Unlock()
	c.typesChanged.Notify()
	return nil
}

func groupFailed(failed map[schema.GroupVersion]error, gvr schema.GroupVersionResource) bool {
	_, ok := failed[gvr.GroupVersion()]
	return ok
}

func withState(info protocol.ResourceType, state protocol.TypeState) protocol.ResourceType {
	info.State = state
	return info
}

// startType starts indexing one type. It must be called with c.mu held.
func (c *Cluster) startType(ctx context.Context, t *indexedType) {
	tctx, cancel := context.WithCancel(ctx)
	t.cancel = cancel
	client := c.meta.Resource(t.gvr)

	lw := &cache.ListWatch{
		ListWithContextFunc: func(ctx context.Context, opts metav1.ListOptions) (runtime.Object, error) {
			list, err := client.List(ctx, opts)
			c.checkTypeErr(t, err)
			return list, err
		},
		WatchFuncWithContext: func(ctx context.Context, opts metav1.ListOptions) (watch.Interface, error) {
			w, err := client.Watch(ctx, opts)
			c.checkTypeErr(t, err)
			return w, err
		},
	}
	store := &typeStore{cluster: c, t: t}
	reflector := cache.NewReflectorWithOptions(lw, &metav1.PartialObjectMetadata{}, store, cache.ReflectorOptions{
		Name: c.id + "/" + string(t.key),
	})
	go reflector.RunWithContext(tctx)
}

// checkTypeErr stops indexing a type when the Cluster will keep refusing to
// serve it, instead of letting the reflector retry forever. Discovery retries
// it later.
func (c *Cluster) checkTypeErr(t *indexedType, err error) {
	var state protocol.TypeState
	switch {
	case err == nil:
		return
	case apierrors.IsForbidden(err) || apierrors.IsUnauthorized(err):
		state = protocol.TypeStateForbidden
	case apierrors.IsNotFound(err) || apierrors.IsMethodNotSupported(err):
		state = protocol.TypeStateFailed
	default:
		return
	}
	t.cancel()
	c.setTypeState(t, state)
}

func (c *Cluster) setTypeState(t *indexedType, state protocol.TypeState) {
	c.mu.Lock()
	changed := c.types[t.key] == t && t.info.State != state
	if changed {
		t.info.State = state
	}
	c.mu.Unlock()
	if changed {
		c.typesChanged.Notify()
	}
}

// record passes observed Changes from one generation of a type through the
// Engine's single Change pipeline. Changes from a generation that discovery
// has since replaced or removed are dropped, so a stopping reflector cannot
// repopulate the index. Changes to CRDs or APIServices request rediscovery
// when mayRediscover is set. It reports whether the changes were applied.
func (c *Cluster) record(t *indexedType, mayRediscover bool, changes func() []index.Change) bool {
	c.mu.Lock()
	if c.types[t.key] != t {
		c.mu.Unlock()
		return false
	}
	applied := changes()
	c.Index.Apply(applied)
	c.mu.Unlock()

	if mayRediscover && len(applied) > 0 && (t.key == crdType || t.key == apiServiceType) {
		select {
		case c.rediscover <- struct{}{}:
		default:
		}
	}
	return true
}

// typeStore receives one generation of a type's metadata from its reflector.
// The reflector calls it from a single goroutine.
type typeStore struct {
	cluster *Cluster
	t       *indexedType
	// synced is set after the first relist, whose additions describe the
	// Cluster's existing state rather than changes to it.
	synced bool
}

func (s *typeStore) Add(obj any) error    { return s.change(index.Added, obj) }
func (s *typeStore) Update(obj any) error { return s.change(index.Modified, obj) }
func (s *typeStore) Delete(obj any) error {
	if d, ok := obj.(cache.DeletedFinalStateUnknown); ok {
		obj = d.Obj
	}
	return s.change(index.Deleted, obj)
}

func (s *typeStore) change(kind index.ChangeKind, obj any) error {
	m, err := toMeta(obj)
	if err != nil {
		return err
	}
	s.cluster.record(s.t, true, func() []index.Change {
		return []index.Change{{Kind: kind, Type: s.t.key, Meta: m, Time: time.Now()}}
	})
	return nil
}

func (s *typeStore) Replace(objs []any, _ string) error {
	metas := make([]index.Meta, 0, len(objs))
	for _, obj := range objs {
		m, err := toMeta(obj)
		if err != nil {
			return err
		}
		metas = append(metas, m)
	}
	// Later relists also recover changes missed while the watch was down, so
	// they may change the set of Resource Types. The first only loads what
	// already exists.
	applied := s.cluster.record(s.t, s.synced, func() []index.Change {
		return s.cluster.Index.Diff(s.t.key, metas, time.Now())
	})
	s.synced = true
	if applied {
		s.cluster.setTypeState(s.t, protocol.TypeStateReady)
	}
	return nil
}

func (s *typeStore) Resync() error { return nil }

func toMeta(obj any) (index.Meta, error) {
	o, ok := obj.(*metav1.PartialObjectMetadata)
	if !ok {
		return index.Meta{}, fmt.Errorf("unexpected object type %T", obj)
	}
	return index.Meta{
		UID:             string(o.UID),
		Namespace:       o.Namespace,
		Name:            o.Name,
		CreatedAt:       o.CreationTimestamp.Time,
		ResourceVersion: o.ResourceVersion,
	}, nil
}
