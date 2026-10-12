package cluster

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"slices"
	"sync"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/runtime/serializer"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/rest"

	"github.com/jimeh/hukube/engine/internal/index"
	"github.com/jimeh/hukube/engine/internal/notify"
	"github.com/jimeh/hukube/engine/internal/protocol"
)

const (
	// tableAccept asks the API server to answer with a Table, the form
	// `kubectl get` prints, instead of the Resources themselves.
	tableAccept = "application/json;as=Table;v=v1;g=meta.k8s.io"
	// tablePageSize is the number of rows asked for per list request. kubectl
	// uses the same size.
	tablePageSize = 500
)

// Table holds the Columns of one Resource Type and the cells of each of its
// Resources, as the Cluster renders them for `kubectl get`. The Cluster keeps
// it current only while a caller holds it (see Cluster.Table). It is safe for
// concurrent use.
type Table struct {
	changed notify.Signal

	mu     sync.RWMutex
	layout tableLayout
	// cells maps a Resource's namespace/name key, as index.Key builds it, to
	// one value per Column. A stored slice is never modified, so readers may
	// keep it.
	cells map[string][]any
}

// Read calls fn with the type's Columns and a function that returns the cells
// of the Resource with the given index key, or nil when the Table has none.
// Columns and cells match each other for the duration of the call. Both are
// empty until the Table has been fetched. fn must not modify what it is given
// or call back into the Table.
func (t *Table) Read(fn func(columns []protocol.Column, cells func(key string) []any)) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	fn(t.layout.columns, func(key string) []any { return t.cells[key] })
}

// Changed signals after the Columns or any cells change.
func (t *Table) Changed() (<-chan struct{}, func()) {
	return t.changed.Subscribe()
}

func (t *Table) len() int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return len(t.cells)
}

// replace swaps in a new set of Columns and cells.
func (t *Table) replace(layout tableLayout, cells map[string][]any) {
	t.mu.Lock()
	t.layout, t.cells = layout, cells
	t.mu.Unlock()
	t.changed.Notify()
}

// put stores the cells of some Resources, replacing what it held for them.
func (t *Table) put(cells map[string][]any) {
	if len(cells) == 0 {
		return
	}
	t.mu.Lock()
	if t.cells == nil {
		t.cells = make(map[string][]any, len(cells))
	}
	maps.Copy(t.cells, cells)
	t.mu.Unlock()
	t.changed.Notify()
}

// remove drops the cells of the Resources that cells holds.
func (t *Table) remove(cells map[string][]any) {
	t.mu.Lock()
	removed := false
	for key := range cells {
		if _, ok := t.cells[key]; ok {
			delete(t.cells, key)
			removed = true
		}
	}
	t.mu.Unlock()
	if removed {
		t.changed.Notify()
	}
}

// reset drops the Columns and every cell.
func (t *Table) reset() {
	t.mu.Lock()
	had := len(t.layout.columns) > 0 || len(t.cells) > 0
	t.layout, t.cells = tableLayout{}, nil
	t.mu.Unlock()
	if had {
		t.changed.Notify()
	}
}

// tableLayout maps the column definitions the API server sent to the Columns
// the Engine keeps.
type tableLayout struct {
	columns []protocol.Column
	// source[i] is the position of columns[i] in a row's cells.
	source []int
}

// newTableLayout leaves out the name and Age columns. A Query's rows already
// carry both from the index, where the age stays current: the API server
// renders an age as text such as "5m" when it sends a row, and does not send
// the row again as time passes.
func newTableLayout(defs []metav1.TableColumnDefinition) tableLayout {
	var l tableLayout
	for i, d := range defs {
		if d.Format == "name" || d.Name == "Age" {
			continue
		}
		l.columns = append(l.columns, protocol.Column{Name: d.Name, Type: d.Type, Priority: int(d.Priority)})
		l.source = append(l.source, i)
	}
	return l
}

func (l tableLayout) equal(other tableLayout) bool {
	return slices.Equal(l.columns, other.columns) && slices.Equal(l.source, other.source)
}

// rows returns the kept cells of each row by index key, and the
// resourceVersion of the last row.
func (l tableLayout) rows(rows []metav1.TableRow) (cells map[string][]any, resourceVersion string, err error) {
	cells = make(map[string][]any, len(rows))
	for i := range rows {
		// Rows are requested with their metadata, which is the only thing that
		// says which Resource a row describes.
		var obj struct {
			Metadata struct {
				Namespace       string `json:"namespace"`
				Name            string `json:"name"`
				ResourceVersion string `json:"resourceVersion"`
			} `json:"metadata"`
		}
		if len(rows[i].Object.Raw) > 0 {
			if err := json.Unmarshal(rows[i].Object.Raw, &obj); err != nil {
				return nil, "", fmt.Errorf("table row metadata: %w", err)
			}
		}
		if obj.Metadata.Name == "" {
			return nil, "", errors.New("table row has no metadata")
		}
		kept := make([]any, len(l.source))
		for j, src := range l.source {
			if src < len(rows[i].Cells) {
				kept[j] = rows[i].Cells[src]
			}
		}
		cells[index.Key(obj.Metadata.Namespace, obj.Metadata.Name)] = kept
		resourceVersion = obj.Metadata.ResourceVersion
	}
	return cells, resourceVersion, nil
}

// tableClient lists and watches the Table of one Resource Type.
type tableClient interface {
	List(ctx context.Context, opts metav1.ListOptions) (*metav1.Table, error)
	// Watch returns a watch whose events hold a *metav1.Table.
	Watch(ctx context.Context, opts metav1.ListOptions) (watch.Interface, error)
}

// tableSource waits until a Resource Type can be listed and returns a client
// for it, and a context that ends when that client goes out of date. It
// returns an error only when ctx ends.
type tableSource func(ctx context.Context) (client tableClient, live context.Context, err error)

// errTableRelist ends a watch that cannot continue from where it is, so the
// Table is listed again.
var errTableRelist = errors.New("table must be listed again")

// runTable keeps t current with a type's Table until ctx ends. It asks source
// for a client on every attempt, so it follows a type that changes its
// preferred API version or is removed and added again, and it empties t when
// a client goes out of date, because what that client fetched may no longer
// describe the type. A failed attempt is
// logged and retried after Timing.ObjectRetry, doubling up to Timing.RetryMax
// while the type's Table cannot be listed at all, which is how a type that
// has no Table form shows up.
func runTable(ctx context.Context, t *Table, source tableSource, timing Timing, log *slog.Logger) {
	delay := timing.ObjectRetry
	for ctx.Err() == nil {
		client, live, err := source(ctx)
		if err != nil {
			return
		}
		attempt, cancel := context.WithCancel(ctx)
		stop := context.AfterFunc(live, cancel)
		started := time.Now()
		listed, err := followTable(attempt, client, t, timing.ObjectRetry)
		stop()
		cancel()

		switch {
		case ctx.Err() != nil:
			return
		case live.Err() != nil:
			// The source waits for the type to be listable again.
			t.reset()
			continue
		case listed:
			delay = timing.ObjectRetry
		}
		wait := delay
		switch {
		case err != nil:
			log.Warn("table watch failed", "err", err, "retry", wait)
			delay = min(delay*2, timing.RetryMax)
		case time.Since(started) >= timing.ObjectRetry:
			continue
		}
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
	}
}

// followTable lists a type's Table into t and then follows its watches until
// one fails or cannot continue. listed reports whether the list completed.
func followTable(ctx context.Context, client tableClient, t *Table, pause time.Duration) (listed bool, err error) {
	layout, resourceVersion, err := listTable(ctx, client, t)
	if err != nil {
		if expired(err) {
			return false, nil
		}
		return false, err
	}
	for {
		started := time.Now()
		resourceVersion, err = watchTable(ctx, client, t, layout, resourceVersion)
		switch {
		case ctx.Err() != nil:
			return true, ctx.Err()
		case errors.Is(err, errTableRelist):
			return true, nil
		case err != nil:
			return true, err
		}
		// The API server ends every watch after a while. Continue from the
		// last row seen, which is far cheaper than listing the type again, but
		// not in a tight loop if watches keep ending at once.
		if time.Since(started) < pause {
			select {
			case <-ctx.Done():
				return true, ctx.Err()
			case <-time.After(pause):
			}
		}
	}
}

// listTable reads every page of a type's Table into t and returns its layout
// and the resourceVersion to watch from.
func listTable(ctx context.Context, client tableClient, t *Table) (tableLayout, string, error) {
	// An empty Table fills page by page, so a list of a large type shows cells
	// as they arrive. One that already has cells is replaced in one step
	// instead, which drops the Resources deleted since it was last current.
	incremental := t.len() == 0
	var (
		layout tableLayout
		all    = make(map[string][]any)
		opts   = metav1.ListOptions{Limit: tablePageSize}
	)
	for first := true; ; first = false {
		page, err := client.List(ctx, opts)
		if err != nil {
			return tableLayout{}, "", err
		}
		if first {
			// Every page of one list has the same column definitions.
			layout = newTableLayout(page.ColumnDefinitions)
			if incremental {
				t.replace(layout, nil)
			}
		}
		cells, _, err := layout.rows(page.Rows)
		if err != nil {
			return tableLayout{}, "", err
		}
		if incremental {
			t.put(cells)
		} else {
			maps.Copy(all, cells)
		}
		if page.Continue == "" {
			if !incremental {
				t.replace(layout, all)
			}
			return layout, page.ResourceVersion, nil
		}
		opts.Continue = page.Continue
	}
}

// watchTable applies one watch's events to t until the watch ends, and
// returns the resourceVersion the next watch should start from.
func watchTable(ctx context.Context, client tableClient, t *Table, layout tableLayout, resourceVersion string) (string, error) {
	w, err := client.Watch(ctx, metav1.ListOptions{ResourceVersion: resourceVersion})
	if err != nil {
		if expired(err) {
			return resourceVersion, errTableRelist
		}
		return resourceVersion, err
	}
	defer w.Stop()
	for {
		var ev watch.Event
		select {
		case <-ctx.Done():
			return resourceVersion, ctx.Err()
		case received, open := <-w.ResultChan():
			if !open {
				return resourceVersion, nil
			}
			ev = received
		}
		switch ev.Type {
		case watch.Added, watch.Modified, watch.Deleted:
			table, ok := ev.Object.(*metav1.Table)
			if !ok {
				return resourceVersion, fmt.Errorf("watch: unexpected object %T", ev.Object)
			}
			// Only a watch's first event carries column definitions. Cells are
			// stored by position, so different columns need a fresh list.
			if len(table.ColumnDefinitions) > 0 && !layout.equal(newTableLayout(table.ColumnDefinitions)) {
				return resourceVersion, errTableRelist
			}
			cells, last, err := layout.rows(table.Rows)
			if err != nil {
				return resourceVersion, err
			}
			if ev.Type == watch.Deleted {
				t.remove(cells)
			} else {
				t.put(cells)
			}
			if last != "" {
				resourceVersion = last
			}
		case watch.Error:
			err := apierrors.FromObject(ev.Object)
			if expired(err) {
				return resourceVersion, errTableRelist
			}
			return resourceVersion, fmt.Errorf("watch: %w", err)
		}
	}
}

// expired reports whether err says a resourceVersion or continue token is too
// old to use, which a fresh list fixes.
func expired(err error) bool {
	return apierrors.IsResourceExpired(err) || apierrors.IsGone(err)
}

// tables shares one watched Table per Resource Type among its callers.
type tables struct {
	ctx    context.Context
	linger time.Duration
	// run keeps a Table current until its context ends.
	run func(ctx context.Context, key protocol.TypeKey, t *Table)

	mu     sync.Mutex
	shared map[protocol.TypeKey]*sharedTable
}

type sharedTable struct {
	table  *Table
	cancel context.CancelFunc
	// holds counts the callers that have not released the Table.
	holds int
	// idle counts the times holds fell to zero, so a linger that was overtaken
	// by a later acquire and release can tell it is stale.
	idle int
}

// newTables returns a registry whose Table watches live no longer than ctx.
func newTables(ctx context.Context, linger time.Duration, run func(context.Context, protocol.TypeKey, *Table)) *tables {
	return &tables{ctx: ctx, linger: linger, run: run, shared: make(map[protocol.TypeKey]*sharedTable)}
}

// acquire returns a type's Table, starting its watch if no caller holds it,
// and a function that releases it. The watch stops once the last caller has
// released it and the linger has passed without another acquiring it.
func (ts *tables) acquire(key protocol.TypeKey) (*Table, func()) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	s := ts.shared[key]
	if s == nil {
		ctx, cancel := context.WithCancel(ts.ctx)
		s = &sharedTable{table: &Table{}, cancel: cancel}
		ts.shared[key] = s
		go ts.run(ctx, key, s.table)
	}
	s.holds++
	return s.table, sync.OnceFunc(func() { ts.release(key, s) })
}

func (ts *tables) release(key protocol.TypeKey, s *sharedTable) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	s.holds--
	if s.holds > 0 {
		return
	}
	s.idle++
	idle := s.idle
	time.AfterFunc(ts.linger, func() {
		ts.mu.Lock()
		defer ts.mu.Unlock()
		if s.holds == 0 && s.idle == idle {
			s.cancel()
			delete(ts.shared, key)
		}
	})
}

// Table returns the Table of a Resource Type and a function the caller must
// call once it no longer needs it. A type's Table is fetched and watched only
// while a caller holds it, and for Timing.TableLinger afterwards, so a caller
// that releases it and takes it again at once, as a scrolling list does, does
// not make the Cluster list the type again.
//
// The Table is empty until it has been fetched, and stays empty for a type
// the Cluster does not serve or has no Table form for.
func (c *Cluster) Table(key protocol.TypeKey) (*Table, func()) {
	return c.tables.acquire(key)
}

// tableSource returns the source for one type's Table. It waits while the
// type is not being indexed, because the index decides which Resources a
// Query returns.
func (c *Cluster) tableSource(key protocol.TypeKey) tableSource {
	return func(ctx context.Context) (tableClient, context.Context, error) {
		// Subscribe before checking, so no change is missed in between.
		typesChanged, stop := c.typesChanged.Subscribe()
		defer stop()
		for {
			c.mu.Lock()
			it, ok := c.types[key]
			c.mu.Unlock()
			// it.gvr and it.ctx never change once the type has started.
			if ok && it.ctx.Err() == nil {
				return &restTableClient{client: c.table, gvr: it.gvr}, it.ctx, nil
			}
			select {
			case <-ctx.Done():
				return nil, nil, ctx.Err()
			case <-typesChanged:
			}
		}
	}
}

var (
	tableVersion = schema.GroupVersion{Version: "v1"}
	tableScheme  = runtime.NewScheme()
	// tableParams encodes list options into query parameters.
	tableParams = runtime.NewParameterCodec(tableScheme)
)

func init() {
	metav1.AddToGroupVersion(tableScheme, tableVersion)
	utilruntime.Must(metav1.AddMetaToScheme(tableScheme))
}

// newTableClient returns a REST client that decodes Tables. It is built the
// way client-go builds its metadata client, which has no Table equivalent.
func newTableClient(cfg *rest.Config) (rest.Interface, error) {
	cfg = rest.CopyConfig(cfg)
	cfg.AcceptContentTypes = tableAccept
	cfg.ContentType = runtime.ContentTypeJSON
	cfg.NegotiatedSerializer = serializer.NewCodecFactory(tableScheme).WithoutConversion()
	// Requests set their whole path, so these only satisfy the client.
	cfg.GroupVersion = &schema.GroupVersion{}
	cfg.APIPath = "/this-value-should-never-be-sent"
	return rest.RESTClientFor(cfg)
}

// restTableClient asks the API server for the Table of one type, across all
// Namespaces.
type restTableClient struct {
	client rest.Interface
	gvr    schema.GroupVersionResource
}

func (c *restTableClient) request(opts *metav1.ListOptions) *rest.Request {
	segments := []string{"apis", c.gvr.Group, c.gvr.Version, c.gvr.Resource}
	if c.gvr.Group == "" {
		segments = []string{"api", c.gvr.Version, c.gvr.Resource}
	}
	return c.client.Get().
		AbsPath(segments...).
		SetHeader("Accept", tableAccept).
		SpecificallyVersionedParams(opts, tableParams, tableVersion).
		Param("includeObject", string(metav1.IncludeMetadata))
}

func (c *restTableClient) List(ctx context.Context, opts metav1.ListOptions) (*metav1.Table, error) {
	var table metav1.Table
	if err := c.request(&opts).Do(ctx).Into(&table); err != nil {
		return nil, err
	}
	return &table, nil
}

func (c *restTableClient) Watch(ctx context.Context, opts metav1.ListOptions) (watch.Interface, error) {
	opts.Watch = true
	return c.request(&opts).Watch(ctx)
}
