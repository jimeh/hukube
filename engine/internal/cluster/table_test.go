package cluster

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	corev1 "k8s.io/api/core/v1"
	apiextv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apiextclient "k8s.io/apiextensions-apiserver/pkg/client/clientset/clientset"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

// snapshot returns a Table's Columns and its cells encoded as JSON, which is
// the form clients receive them in.
func snapshot(t *testing.T, table *Table) ([]protocol.Column, map[string]string) {
	t.Helper()
	var columns []protocol.Column
	cells := make(map[string]string)
	table.Read(func(c []protocol.Column, _ func(string) []any) { columns = slices.Clone(c) })
	table.mu.RLock()
	defer table.mu.RUnlock()
	for key, row := range table.cells {
		raw, err := json.Marshal(row)
		if err != nil {
			t.Fatal(err)
		}
		cells[key] = string(raw)
	}
	return columns, cells
}

func tableRow(namespace, name, resourceVersion string, cells ...any) metav1.TableRow {
	raw, _ := json.Marshal(map[string]any{"metadata": map[string]any{
		"namespace": namespace, "name": name, "resourceVersion": resourceVersion,
	}})
	return metav1.TableRow{Cells: cells, Object: runtime.RawExtension{Raw: raw}}
}

// The name and Age columns are dropped wherever the Cluster puts them, and
// the cells that remain must still line up with their Columns.
func TestTableLayoutDropsNameAndAge(t *testing.T) {
	tests := []struct {
		name        string
		defs        []metav1.TableColumnDefinition
		cells       []any
		wantColumns []protocol.Column
		wantCells   string
	}{
		{
			name: "pods",
			defs: []metav1.TableColumnDefinition{
				{Name: "Name", Type: "string", Format: "name"},
				{Name: "Ready", Type: "string"},
				{Name: "Restarts", Type: "string"},
				{Name: "Age", Type: "string"},
				{Name: "Node", Type: "string", Priority: 1},
			},
			cells: []any{"web", "1/1", "0", "5m", "node-a"},
			wantColumns: []protocol.Column{
				{Name: "Ready", Type: "string"},
				{Name: "Restarts", Type: "string"},
				{Name: "Node", Type: "string", Priority: 1},
			},
			wantCells: `["1/1","0","node-a"]`,
		},
		{
			name: "events, whose name column is last and which have no Age",
			defs: []metav1.TableColumnDefinition{
				{Name: "Last Seen", Type: "string"},
				{Name: "Reason", Type: "string"},
				{Name: "Count", Type: "integer", Priority: 1},
				{Name: "Name", Type: "string", Format: "name", Priority: 1},
			},
			cells: []any{"2m", "Started", int64(3), "web.17f"},
			wantColumns: []protocol.Column{
				{Name: "Last Seen", Type: "string"},
				{Name: "Reason", Type: "string"},
				{Name: "Count", Type: "integer", Priority: 1},
			},
			wantCells: `["2m","Started",3]`,
		},
		{
			name: "a type with only a name and an age",
			defs: []metav1.TableColumnDefinition{
				{Name: "Name", Type: "string", Format: "name"},
				{Name: "Age", Type: "date"},
			},
			cells:     []any{"web", "5m"},
			wantCells: `[]`,
		},
		{
			name: "a row with fewer cells than columns",
			defs: []metav1.TableColumnDefinition{
				{Name: "Name", Type: "string", Format: "name"},
				{Name: "Ready", Type: "string"},
				{Name: "Status", Type: "string"},
			},
			cells: []any{"web", "1/1"},
			wantColumns: []protocol.Column{
				{Name: "Ready", Type: "string"},
				{Name: "Status", Type: "string"},
			},
			wantCells: `["1/1",null]`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			layout := newTableLayout(tt.defs)
			if !slices.Equal(layout.columns, tt.wantColumns) {
				t.Errorf("columns = %+v, want %+v", layout.columns, tt.wantColumns)
			}
			cells, resourceVersion, err := layout.rows([]metav1.TableRow{tableRow("default", "web", "7", tt.cells...)})
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(cells["default/web"])
			if string(raw) != tt.wantCells {
				t.Errorf("cells = %s, want %s", raw, tt.wantCells)
			}
			if resourceVersion != "7" {
				t.Errorf("resourceVersion = %q, want 7", resourceVersion)
			}
		})
	}

	// A row that does not say which Resource it describes cannot be stored.
	if _, _, err := newTableLayout(nil).rows([]metav1.TableRow{{Cells: []any{"web"}}}); err == nil {
		t.Error("rows accepted a row without metadata")
	}
}

// fakeTables serves one type's Table from memory and records the requests it
// receives.
type fakeTables struct {
	mu       sync.Mutex
	defs     []metav1.TableColumnDefinition
	rows     []metav1.TableRow
	version  string
	pageSize int
	listErr  error

	lists    []metav1.ListOptions
	listedAt []time.Time
	watches  []metav1.ListOptions
	watcher  *watch.FakeWatcher
}

var configMapDefs = []metav1.TableColumnDefinition{
	{Name: "Name", Type: "string", Format: "name"},
	{Name: "Data", Type: "integer"},
	{Name: "Age", Type: "string"},
}

func (f *fakeTables) List(_ context.Context, opts metav1.ListOptions) (*metav1.Table, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lists = append(f.lists, opts)
	f.listedAt = append(f.listedAt, time.Now())
	if f.listErr != nil {
		return nil, f.listErr
	}
	start := 0
	if opts.Continue != "" {
		start, _ = strconv.Atoi(opts.Continue)
	}
	end := min(start+f.pageSize, len(f.rows))
	table := &metav1.Table{ColumnDefinitions: f.defs, Rows: f.rows[start:end]}
	table.ResourceVersion = f.version
	if end < len(f.rows) {
		table.Continue = strconv.Itoa(end)
	}
	return table, nil
}

func (f *fakeTables) Watch(_ context.Context, opts metav1.ListOptions) (watch.Interface, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.watches = append(f.watches, opts)
	f.watcher = watch.NewFake()
	return f.watcher, nil
}

// calls returns the continue token of each list and the resourceVersion of
// each watch received so far, and the current watch.
func (f *fakeTables) calls() (lists, watches []string, watcher *watch.FakeWatcher) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, opts := range f.lists {
		lists = append(lists, opts.Continue)
	}
	for _, opts := range f.watches {
		watches = append(watches, opts.ResourceVersion)
	}
	return lists, watches, f.watcher
}

func (f *fakeTables) source(live context.Context) tableSource {
	return func(context.Context) (tableClient, context.Context, error) { return f, live, nil }
}

func event(defs []metav1.TableColumnDefinition, row metav1.TableRow) *metav1.Table {
	return &metav1.Table{ColumnDefinitions: defs, Rows: []metav1.TableRow{row}}
}

func TestTableFollowsListsAndWatches(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		timing := testTiming()
		fake := &fakeTables{
			defs:     configMapDefs,
			version:  "10",
			pageSize: 2,
			rows: []metav1.TableRow{
				tableRow("default", "a", "1", "a", int64(1), "5m"),
				tableRow("default", "b", "2", "b", int64(2), "5m"),
				tableRow("other", "a", "3", "a", int64(3), "5m"),
			},
		}
		table := &Table{}
		go runTable(ctx, table, fake.source(context.Background()), timing, slog.New(slog.DiscardHandler))

		expect := func(step string, wantCells map[string]string, wantLists, wantWatches []string) {
			t.Helper()
			synctest.Wait()
			columns, cells := snapshot(t, table)
			if want := []protocol.Column{{Name: "Data", Type: "integer"}}; !slices.Equal(columns, want) {
				t.Errorf("%s: columns = %+v, want %+v", step, columns, want)
			}
			if fmt.Sprint(cells) != fmt.Sprint(wantCells) {
				t.Errorf("%s: cells = %v, want %v", step, cells, wantCells)
			}
			lists, watches, _ := fake.calls()
			if !slices.Equal(lists, wantLists) || !slices.Equal(watches, wantWatches) {
				t.Errorf("%s: lists %q watches %q, want lists %q watches %q", step, lists, watches, wantLists, wantWatches)
			}
		}

		expect("every page is listed, then watched from the list's version",
			map[string]string{"default/a": "[1]", "default/b": "[2]", "other/a": "[3]"},
			[]string{"", "2"}, []string{"10"})
		if limit := fake.lists[0].Limit; limit != tablePageSize {
			t.Errorf("list limit = %d, want %d", limit, tablePageSize)
		}

		_, _, w := fake.calls()
		w.Modify(event(configMapDefs, tableRow("default", "b", "11", "b", int64(5), "6m")))
		w.Add(event(nil, tableRow("default", "c", "12", "c", int64(0), "0s")))
		w.Delete(event(nil, tableRow("default", "a", "13", "a", int64(1), "7m")))
		expect("watch events are applied",
			map[string]string{"default/b": "[5]", "default/c": "[0]", "other/a": "[3]"},
			[]string{"", "2"}, []string{"10"})

		// A watch the API server ends is continued from the last row seen,
		// without listing again.
		time.Sleep(timing.ObjectRetry)
		w.Stop()
		expect("an ended watch resumes",
			map[string]string{"default/b": "[5]", "default/c": "[0]", "other/a": "[3]"},
			[]string{"", "2"}, []string{"10", "13"})

		// A watch that can no longer be resumed lists again, which drops the
		// Resources deleted in the meantime.
		fake.mu.Lock()
		fake.version = "20"
		fake.rows = []metav1.TableRow{tableRow("other", "a", "3", "a", int64(3), "9m")}
		fake.mu.Unlock()
		time.Sleep(timing.ObjectRetry)
		_, _, w = fake.calls()
		w.Error(&apierrors.NewResourceExpired("too old").ErrStatus)
		expect("an expired watch lists again",
			map[string]string{"other/a": "[3]"},
			[]string{"", "2", ""}, []string{"10", "13", "20"})

		// Columns that change under a watch need a list, because cells are
		// stored by position.
		wider := append(slices.Clone(configMapDefs), metav1.TableColumnDefinition{Name: "Extra", Type: "string"})
		fake.mu.Lock()
		fake.defs = wider
		fake.rows = []metav1.TableRow{tableRow("other", "a", "21", "a", int64(3), "9m", "x")}
		fake.mu.Unlock()
		time.Sleep(timing.ObjectRetry)
		_, _, w = fake.calls()
		w.Modify(event(wider, tableRow("other", "a", "21", "a", int64(3), "9m", "x")))
		synctest.Wait()
		columns, cells := snapshot(t, table)
		if len(columns) != 2 || cells["other/a"] != `[3,"x"]` {
			t.Errorf("after the columns changed: columns %+v cells %v, want Data and Extra with [3,\"x\"]", columns, cells)
		}
	})
}

// A type the Cluster cannot give a Table for is retried ever more slowly, and
// its Table fills as soon as a list succeeds.
func TestTableBacksOffWhileListsFail(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		timing := testTiming()
		timing.RetryMax = 300 * time.Millisecond
		fake := &fakeTables{
			defs: configMapDefs, version: "10", pageSize: 2,
			rows:    []metav1.TableRow{tableRow("default", "a", "1", "a", int64(1), "5m")},
			listErr: apierrors.NewGenericServerResponse(406, "GET", schema.GroupResource{}, "", "no table", 0, false),
		}
		table := &Table{}
		start := time.Now()
		go runTable(ctx, table, fake.source(context.Background()), timing, slog.New(slog.DiscardHandler))

		time.Sleep(time.Second)
		synctest.Wait()
		fake.mu.Lock()
		var offsets []time.Duration
		for _, at := range fake.listedAt {
			offsets = append(offsets, at.Sub(start))
		}
		fake.listErr = nil
		fake.mu.Unlock()
		want := []time.Duration{0, 100 * time.Millisecond, 300 * time.Millisecond, 600 * time.Millisecond, 900 * time.Millisecond}
		if !slices.Equal(offsets, want) {
			t.Errorf("lists at %v, want %v", offsets, want)
		}
		if columns, cells := snapshot(t, table); len(columns) != 0 || len(cells) != 0 {
			t.Errorf("failed lists left columns %+v and cells %v", columns, cells)
		}

		time.Sleep(timing.RetryMax)
		synctest.Wait()
		if _, cells := snapshot(t, table); cells["default/a"] != "[1]" {
			t.Errorf("cells after a list succeeded = %v, want default/a", cells)
		}
	})
}

// When discovery restarts a type, the Table watch must ask for a client
// again instead of following the version it started with.
func TestTableWatchRestartsWithItsType(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		fake := &fakeTables{defs: configMapDefs, version: "10", pageSize: 2}
		live, restart := context.WithCancel(context.Background())
		var asked atomic.Int32
		source := func(context.Context) (tableClient, context.Context, error) {
			if asked.Add(1) == 1 {
				return fake, live, nil
			}
			return fake, context.Background(), nil
		}
		go runTable(ctx, &Table{}, source, testTiming(), slog.New(slog.DiscardHandler))

		synctest.Wait()
		restart()
		synctest.Wait()
		lists, watches, _ := fake.calls()
		if asked.Load() != 2 || len(lists) != 2 || len(watches) != 2 {
			t.Errorf("after the type restarted: asked %d times, %d lists, %d watches; want 2 of each",
				asked.Load(), len(lists), len(watches))
		}
	})
}

// Lists of one type share a watch, which must outlive a release that is
// followed by another acquire, as every scroll of a list is, and must stop
// once nothing has held it for the linger.
func TestTablesShareAWatchAndLinger(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		const linger = 30 * time.Second
		var starts, stops atomic.Int32
		ts := newTables(ctx, linger, func(ctx context.Context, _ protocol.TypeKey, _ *Table) {
			starts.Add(1)
			<-ctx.Done()
			stops.Add(1)
		})
		expect := func(step string, wantStarts, wantStops int32) {
			t.Helper()
			synctest.Wait()
			if starts.Load() != wantStarts || stops.Load() != wantStops {
				t.Errorf("%s: %d watches started and %d stopped, want %d and %d",
					step, starts.Load(), stops.Load(), wantStarts, wantStops)
			}
		}

		first, releaseFirst := ts.acquire("pods")
		second, releaseSecond := ts.acquire("pods")
		if first != second {
			t.Error("two holders of one type got different Tables")
		}
		if other, release := ts.acquire("configmaps"); other == first {
			t.Error("two types share a Table")
		} else {
			defer release()
		}
		expect("one watch per type", 2, 0)

		releaseFirst()
		releaseFirst()
		time.Sleep(2 * linger)
		expect("a held Table keeps its watch, however often one holder releases it", 2, 0)

		// Scrolling releases and acquires in quick succession, so a linger can
		// run out after its Table was taken and released again. Only the linger
		// of the last release may stop the watch.
		releaseSecond()
		time.Sleep(10 * time.Second)
		third, releaseThird := ts.acquire("pods")
		if third != first {
			t.Error("acquiring within the linger started a new Table")
		}
		time.Sleep(10 * time.Second)
		releaseThird()
		time.Sleep(linger - time.Second)
		expect("the watch outlives its last release by the linger", 2, 0)
		time.Sleep(2 * time.Second)
		expect("the watch stops after the linger", 2, 1)

		fourth, releaseFourth := ts.acquire("pods")
		defer releaseFourth()
		if fourth == first {
			t.Error("acquiring after the linger reused the stopped Table")
		}
		expect("acquiring after the linger starts a new watch", 3, 1)
	})
}

func TestTableFollowsResourceChanges(t *testing.T) {
	c := connect(t)
	cs := kubernetes.NewForConfigOrDie(cfg)
	ns := createNamespace(t, cs)
	ctx := context.Background()

	table, release := c.Table("configmaps")
	defer release()
	hasCells := func(want string) func() (bool, string) {
		return func() (bool, string) {
			columns, cells := snapshot(t, table)
			got, ok := cells[ns+"/tabled"]
			if !ok {
				got = "none"
			}
			// The API server declares this column as a string, though its cells
			// are numbers.
			return got == want && slices.Equal(columns, []protocol.Column{{Name: "Data", Type: "string"}}),
				fmt.Sprintf("columns %+v, cells %s", columns, got)
		}
	}

	cm := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "tabled"}, Data: map[string]string{"a": "1"}}
	cm, err := cs.CoreV1().ConfigMaps(ns).Create(ctx, cm, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, hasCells("[1]"))

	cm.Data["b"] = "2"
	if _, err := cs.CoreV1().ConfigMaps(ns).Update(ctx, cm, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	eventually(t, hasCells("[2]"))

	if err := cs.CoreV1().ConfigMaps(ns).Delete(ctx, "tabled", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	eventually(t, hasCells("none"))
}

// A CRD's printer columns arrive with their declared types and priorities,
// and its cells keep their JSON types. The Table of a type that is not served
// yet fills once it is, and empties when the type goes away.
func TestTableServesCustomResourceColumns(t *testing.T) {
	c := connect(t)
	ctx := context.Background()
	ext := apiextclient.NewForConfigOrDie(cfg)
	const key = protocol.TypeKey("gadgets.example.hukube.dev")

	table, release := c.Table(key)
	defer release()

	crd := &apiextv1.CustomResourceDefinition{
		ObjectMeta: metav1.ObjectMeta{Name: string(key)},
		Spec: apiextv1.CustomResourceDefinitionSpec{
			Group: "example.hukube.dev",
			Names: apiextv1.CustomResourceDefinitionNames{Plural: "gadgets", Singular: "gadget", Kind: "Gadget", ListKind: "GadgetList"},
			Scope: apiextv1.ClusterScoped,
			Versions: []apiextv1.CustomResourceDefinitionVersion{{
				Name: "v1", Served: true, Storage: true,
				Schema: &apiextv1.CustomResourceValidation{OpenAPIV3Schema: &apiextv1.JSONSchemaProps{
					Type: "object", XPreserveUnknownFields: ptr(true),
				}},
				AdditionalPrinterColumns: []apiextv1.CustomResourceColumnDefinition{
					{Name: "Size", Type: "integer", JSONPath: ".spec.size"},
					{Name: "Enabled", Type: "boolean", JSONPath: ".spec.enabled"},
					{Name: "Owner", Type: "string", JSONPath: ".spec.owner", Priority: 1},
					{Name: "Age", Type: "date", JSONPath: ".metadata.creationTimestamp"},
				},
			}},
		},
	}
	if _, err := ext.ApiextensionsV1().CustomResourceDefinitions().Create(ctx, crd, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = ext.ApiextensionsV1().CustomResourceDefinitions().Delete(context.Background(), string(key), metav1.DeleteOptions{})
	})
	eventually(t, func() (bool, string) {
		rt, ok := typeState(c, key)
		return ok && rt.State == protocol.TypeStateReady, fmt.Sprintf("%+v (found: %v)", rt, ok)
	})

	gvr := schema.GroupVersionResource{Group: "example.hukube.dev", Version: "v1", Resource: "gadgets"}
	gadget := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "example.hukube.dev/v1", "kind": "Gadget", "metadata": map[string]any{"name": "sprocket"},
		"spec": map[string]any{"size": int64(3), "enabled": true, "owner": "ops"},
	}}
	if _, err := dynamic.NewForConfigOrDie(cfg).Resource(gvr).Create(ctx, gadget, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	wantColumns := []protocol.Column{
		{Name: "Size", Type: "integer"},
		{Name: "Enabled", Type: "boolean"},
		{Name: "Owner", Type: "string", Priority: 1},
	}
	eventually(t, func() (bool, string) {
		columns, cells := snapshot(t, table)
		return slices.Equal(columns, wantColumns) && cells["sprocket"] == `[3,true,"ops"]`,
			fmt.Sprintf("columns %+v, cells %v", columns, cells)
	})

	if err := ext.ApiextensionsV1().CustomResourceDefinitions().Delete(ctx, string(key), metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() (bool, string) {
		columns, cells := snapshot(t, table)
		return len(columns) == 0 && len(cells) == 0, fmt.Sprintf("columns %+v, cells %v", columns, cells)
	})
}
