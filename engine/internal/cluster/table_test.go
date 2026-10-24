package cluster

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	corev1 "k8s.io/api/core/v1"
	eventsv1 "k8s.io/api/events/v1"
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
			layout := newTableLayout(tt.defs, false)
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
	if _, _, err := newTableLayout(nil, false).rows([]metav1.TableRow{{Cells: []any{"web"}}}); err == nil {
		t.Error("rows accepted a row without metadata")
	}
}

// objectRow is a Table row whose object is the whole Resource, as the API
// server sends an Event's row.
func objectRow(object map[string]any, cells ...any) metav1.TableRow {
	raw, _ := json.Marshal(object)
	return metav1.TableRow{Cells: cells, Object: runtime.RawExtension{Raw: raw}}
}

// eventDefs are some of the column definitions the API server sends for both
// Event types: the two whose cells the Engine replaces, one it keeps, and the
// name, which it drops.
var eventDefs = []metav1.TableColumnDefinition{
	{Name: "Last Seen", Type: "string"},
	{Name: "Reason", Type: "string"},
	{Name: "First Seen", Type: "string", Priority: 1},
	{Name: "Name", Type: "string", Format: "name", Priority: 1},
}

// An Event's Last Seen and First Seen hold the times they count from, read
// from the Event in either API group's fields, in UTC. Other columns, and
// other types, keep the cells the API server rendered.
func TestTableReadsEventTimes(t *testing.T) {
	const (
		created   = "2026-10-24T02:00:00+02:00"
		first     = "2026-10-24T02:01:00+02:00"
		eventTime = "2026-10-24T02:02:00.000001+02:00"
		last      = "2026-10-24T02:03:00+02:00"
		series    = "2026-10-24T02:04:00.000002+02:00"
	)
	utc := map[string]string{
		created: "2026-10-24T00:00:00Z", first: "2026-10-24T00:01:00Z",
		eventTime: "2026-10-24T00:02:00.000001Z", last: "2026-10-24T00:03:00Z",
		series: "2026-10-24T00:04:00.000002Z",
	}
	core := func(fields map[string]any) map[string]any {
		object := map[string]any{
			"apiVersion": "v1", "kind": "Event",
			"metadata": map[string]any{"namespace": "default", "name": "web.17f", "resourceVersion": "7", "creationTimestamp": created},
		}
		maps.Copy(object, fields)
		return object
	}
	modern := func(fields map[string]any) map[string]any {
		object := core(fields)
		object["apiVersion"] = "events.k8s.io/v1"
		return object
	}
	tests := []struct {
		name            string
		object          map[string]any
		lastSeen, first string
	}{
		{
			name: "core series",
			object: core(map[string]any{
				"series":        map[string]any{"count": 3, "lastObservedTime": series},
				"lastTimestamp": last, "eventTime": eventTime, "firstTimestamp": first,
			}),
			lastSeen: series, first: first,
		},
		{
			name:     "core last timestamp",
			object:   core(map[string]any{"lastTimestamp": last, "eventTime": eventTime, "firstTimestamp": first}),
			lastSeen: last, first: first,
		},
		{name: "core event time only", object: core(map[string]any{"eventTime": eventTime}), lastSeen: eventTime, first: eventTime},
		{name: "core first timestamp only", object: core(map[string]any{"firstTimestamp": first}), lastSeen: first, first: first},
		{name: "core creation time only", object: core(nil), lastSeen: created, first: created},
		{
			name: "events.k8s.io series",
			object: modern(map[string]any{
				"series":                  map[string]any{"count": 3, "lastObservedTime": series},
				"deprecatedLastTimestamp": last, "eventTime": eventTime, "deprecatedFirstTimestamp": first,
			}),
			lastSeen: series, first: first,
		},
		{
			name: "events.k8s.io last timestamp",
			object: modern(map[string]any{
				"deprecatedLastTimestamp": last, "eventTime": eventTime, "deprecatedFirstTimestamp": first,
			}),
			lastSeen: last, first: first,
		},
		{name: "events.k8s.io event time only", object: modern(map[string]any{"eventTime": eventTime}), lastSeen: eventTime, first: eventTime},
		{
			name:     "events.k8s.io first timestamp only",
			object:   modern(map[string]any{"deprecatedFirstTimestamp": first}),
			lastSeen: first, first: first,
		},
		{name: "events.k8s.io creation time only", object: modern(nil), lastSeen: created, first: created},
	}
	layout := newTableLayout(eventDefs, true)
	wantColumns := []protocol.Column{
		{Name: "Last Seen", Type: protocol.ColumnTypeTimestamp},
		{Name: "Reason", Type: "string"},
		{Name: "First Seen", Type: protocol.ColumnTypeTimestamp, Priority: 1},
	}
	if !slices.Equal(layout.columns, wantColumns) {
		t.Errorf("columns = %+v, want %+v", layout.columns, wantColumns)
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cells, resourceVersion, err := layout.rows([]metav1.TableRow{
				objectRow(tt.object, "0s", "Started", "5m", "web.17f"),
			})
			if err != nil {
				t.Fatal(err)
			}
			row := cells["default/web.17f"]
			for _, cell := range []any{row[0], row[2]} {
				if at, ok := cell.(time.Time); !ok || at.Location() != time.UTC {
					t.Errorf("cell %#v is not a time in UTC", cell)
				}
			}
			raw, _ := json.Marshal(row)
			if want := fmt.Sprintf(`[%q,"Started",%q]`, utc[tt.lastSeen], utc[tt.first]); string(raw) != want {
				t.Errorf("cells = %s, want %s", raw, want)
			}
			if resourceVersion != "7" {
				t.Errorf("resourceVersion = %q, want 7", resourceVersion)
			}
		})
	}

	t.Run("an Event without any time", func(t *testing.T) {
		object := map[string]any{"metadata": map[string]any{"namespace": "default", "name": "web.17f"}}
		cells, _, err := layout.rows([]metav1.TableRow{objectRow(object, "<unknown>", "Started", "<unknown>", "web.17f")})
		if err != nil {
			t.Fatal(err)
		}
		if raw, _ := json.Marshal(cells["default/web.17f"]); string(raw) != `[null,"Started",null]` {
			t.Errorf("cells = %s, want no times", raw)
		}
	})

	// Only the Engine may mark a column as holding times, so a type that
	// declares one keeps it as a string of rendered cells, as does a column
	// of the same name in a type that is not an Event.
	for _, events := range []bool{false, true} {
		t.Run(fmt.Sprintf("declared timestamp, events %v", events), func(t *testing.T) {
			defs := []metav1.TableColumnDefinition{
				{Name: "Name", Type: "string", Format: "name"},
				{Name: "Last Seen", Type: "string"},
				{Name: "Expires", Type: protocol.ColumnTypeTimestamp},
			}
			layout := newTableLayout(defs, events)
			wantType := "string"
			if events {
				wantType = protocol.ColumnTypeTimestamp
			}
			want := []protocol.Column{{Name: "Last Seen", Type: wantType}, {Name: "Expires", Type: "string"}}
			if !slices.Equal(layout.columns, want) {
				t.Errorf("columns = %+v, want %+v", layout.columns, want)
			}
			if events {
				return
			}
			cells, _, err := layout.rows([]metav1.TableRow{tableRow("default", "web", "7", "web", "5m", "2026-10-24")})
			if err != nil {
				t.Fatal(err)
			}
			if raw, _ := json.Marshal(cells["default/web"]); string(raw) != `["5m","2026-10-24"]` {
				t.Errorf("cells = %s, want the rendered cells", raw)
			}
		})
	}

	t.Run("an Event Table without the time columns", func(t *testing.T) {
		defs := []metav1.TableColumnDefinition{{Name: "Reason", Type: "string"}, {Name: "Name", Type: "string", Format: "name"}}
		layout := newTableLayout(defs, true)
		if want := []protocol.Column{{Name: "Reason", Type: "string"}}; !slices.Equal(layout.columns, want) {
			t.Errorf("columns = %+v, want %+v", layout.columns, want)
		}
		cells, _, err := layout.rows([]metav1.TableRow{objectRow(core(nil), "Started", "web.17f")})
		if err != nil {
			t.Fatal(err)
		}
		if raw, _ := json.Marshal(cells["default/web.17f"]); string(raw) != `["Started"]` {
			t.Errorf("cells = %s, want the rendered cells", raw)
		}
	})
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
	// eventRows makes the fake an Event type's client, whose rows hold Events.
	eventRows bool

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

func (f *fakeTables) events() bool { return f.eventRows }

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

// Every watch of an Event Table starts with column definitions, which must
// lay out as the list's did, or each watch would list the type again.
func TestTableEventWatchKeepsItsList(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		eventObject := func(resourceVersion, lastTimestamp string) map[string]any {
			return map[string]any{
				"metadata": map[string]any{
					"namespace": "default", "name": "web.17f", "resourceVersion": resourceVersion,
					"creationTimestamp": "2026-10-24T00:00:00Z",
				},
				"lastTimestamp": lastTimestamp,
			}
		}
		fake := &fakeTables{
			defs: eventDefs, version: "10", pageSize: 2, eventRows: true,
			rows: []metav1.TableRow{objectRow(eventObject("1", "2026-10-24T00:01:00Z"), "5m", "Started", "6m", "web.17f")},
		}
		table := &Table{}
		timing := testTiming()
		go runTable(ctx, table, fake.source(context.Background()), timing, slog.New(slog.DiscardHandler))

		synctest.Wait()
		_, _, w := fake.calls()
		w.Modify(event(eventDefs, objectRow(eventObject("11", "2026-10-24T00:02:00Z"), "0s", "Started", "6m", "web.17f")))
		synctest.Wait()
		_, cells := snapshot(t, table)
		if want := `["2026-10-24T00:02:00Z","Started","2026-10-24T00:00:00Z"]`; cells["default/web.17f"] != want {
			t.Errorf("cells after the watch = %v, want %s", cells, want)
		}
		// A relist would wait for the retry delay first.
		time.Sleep(2 * timing.ObjectRetry)
		synctest.Wait()
		if lists, watches, _ := fake.calls(); len(lists) != 1 || !slices.Equal(watches, []string{"10"}) {
			t.Errorf("lists %q watches %q, want one list and its watch", lists, watches)
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

// failWatch ends a fake watch with an error that listing again does not fix.
func failWatch(w *watch.FakeWatcher) {
	w.Error(&apierrors.NewInternalError(errors.New("watch failed")).ErrStatus)
}

// When discovery replaces a type, the Table watch must stop following the
// client it started with and ask for another. What the old client fetched
// must not outlive it, even when the new one cannot list the type's Table,
// and whether the type is replaced during a watch or between two attempts.
func TestTableWatchRestartsWithItsType(t *testing.T) {
	for _, tc := range []struct {
		name string
		// betweenAttempts replaces the type while the Table waits to retry
		// after a failed watch, instead of while a watch runs.
		betweenAttempts bool
	}{
		{name: "replaced during a watch"},
		{name: "replaced between attempts", betweenAttempts: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				timing := testTiming()
				rows := []metav1.TableRow{tableRow("default", "a", "1", "a", int64(1), "5m")}
				before := &fakeTables{defs: configMapDefs, version: "10", pageSize: 2, rows: rows}
				after := &fakeTables{
					defs: configMapDefs, version: "20", pageSize: 2, rows: rows,
					listErr: apierrors.NewGenericServerResponse(406, "GET", schema.GroupResource{}, "", "no table", 0, false),
				}
				live, end := context.WithCancel(context.Background())
				var replaced atomic.Bool
				source := func(context.Context) (tableClient, context.Context, error) {
					if replaced.Load() {
						return after, context.Background(), nil
					}
					return before, live, nil
				}
				table := &Table{}
				go runTable(ctx, table, source, timing, slog.New(slog.DiscardHandler))

				synctest.Wait()
				_, _, watcher := before.calls()
				if tc.betweenAttempts {
					failWatch(watcher)
					synctest.Wait()
				}
				if _, cells := snapshot(t, table); cells["default/a"] != "[1]" {
					t.Fatalf("cells before the type was replaced = %v, want default/a", cells)
				}

				replaced.Store(true)
				end()
				synctest.Wait()
				// A failed watch has stopped already, so this only says something
				// about one that was running.
				if !tc.betweenAttempts && !watcher.IsStopped() {
					t.Error("the watch of the type's old client was not stopped")
				}
				if lists, _, _ := after.calls(); len(lists) != 1 {
					t.Errorf("the new client was asked for %d lists at once, want 1", len(lists))
				}
				if columns, cells := snapshot(t, table); len(columns) != 0 || len(cells) != 0 {
					t.Errorf("the old client's columns %+v and cells %v outlived it", columns, cells)
				}

				after.mu.Lock()
				after.listErr = nil
				after.mu.Unlock()
				time.Sleep(timing.RetryMax)
				synctest.Wait()
				if _, cells := snapshot(t, table); cells["default/a"] != "[1]" {
					t.Errorf("cells once the new client could list = %v, want default/a", cells)
				}
			})
		})
	}
}

// While the type stays as it is, failed attempts must leave the Table alone,
// so a list keeps its cells while the Cluster is briefly out of reach.
func TestTableKeepsItsCellsWhileRetrying(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		timing := testTiming()
		fake := &fakeTables{
			defs: configMapDefs, version: "10", pageSize: 2,
			rows: []metav1.TableRow{tableRow("default", "a", "1", "a", int64(1), "5m")},
		}
		table := &Table{}
		go runTable(ctx, table, fake.source(context.Background()), timing, slog.New(slog.DiscardHandler))

		synctest.Wait()
		_, _, watcher := fake.calls()
		fake.mu.Lock()
		fake.listErr = apierrors.NewServiceUnavailable("out of reach")
		fake.mu.Unlock()
		failWatch(watcher)
		time.Sleep(timing.RetryMax)
		synctest.Wait()
		if lists, _, _ := fake.calls(); len(lists) < 2 {
			t.Fatalf("%d lists, want the first and at least one failed retry", len(lists))
		}
		if columns, cells := snapshot(t, table); len(columns) != 1 || cells["default/a"] != "[1]" {
			t.Errorf("after failed retries: columns %+v and cells %v, want them kept", columns, cells)
		}
	})
}

// A type the Cluster stops indexing, because it was removed or refused, has
// no Resources in the index, so its Table must empty and wait, even when
// indexing stops between two attempts. It must fill again once the type is
// indexed again.
func TestTableEmptiesWhileItsTypeIsNotIndexed(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		const key = protocol.TypeKey("configmaps")
		indexed, stopIndexing := context.WithCancel(context.Background())
		c := &Cluster{types: map[protocol.TypeKey]*indexedType{
			key: {key: key, ctx: indexed, cancel: stopIndexing},
		}}
		fake := &fakeTables{
			defs: configMapDefs, version: "10", pageSize: 2,
			rows: []metav1.TableRow{tableRow("default", "a", "1", "a", int64(1), "5m")},
		}
		table := &Table{}
		// The Cluster decides when the type can be listed, and the fake serves it.
		fromCluster := c.tableSource(key, table)
		source := func(ctx context.Context) (tableClient, context.Context, error) {
			_, live, err := fromCluster(ctx)
			return fake, live, err
		}
		go runTable(ctx, table, source, testTiming(), slog.New(slog.DiscardHandler))

		synctest.Wait()
		_, _, watcher := fake.calls()
		failWatch(watcher)
		synctest.Wait()
		if _, cells := snapshot(t, table); cells["default/a"] != "[1]" {
			t.Fatalf("cells while the type is indexed = %v, want default/a", cells)
		}

		// As when the Cluster refuses the type: it stays known but is not indexed.
		stopIndexing()
		c.typesChanged.Notify()
		synctest.Wait()
		if columns, cells := snapshot(t, table); len(columns) != 0 || len(cells) != 0 {
			t.Errorf("columns %+v and cells %v outlived the type's indexing", columns, cells)
		}
		if lists, _, _ := fake.calls(); len(lists) != 1 {
			t.Errorf("%d lists while the type is not indexed, want only the first", len(lists))
		}

		c.mu.Lock()
		c.types[key] = &indexedType{key: key, ctx: context.Background(), cancel: func() {}}
		c.mu.Unlock()
		c.typesChanged.Notify()
		synctest.Wait()
		if _, cells := snapshot(t, table); cells["default/a"] != "[1]" {
			t.Errorf("cells once the type is indexed again = %v, want default/a", cells)
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

// The API server sends the whole Event in each Event type's rows, under that
// API group's field names, and a new last time reaches both Tables.
func TestTableReadsEventTimesFromTheCluster(t *testing.T) {
	c := connect(t)
	cs := kubernetes.NewForConfigOrDie(cfg)
	ns := createNamespace(t, cs)
	ctx := context.Background()

	core, releaseCore := c.Table("events")
	defer releaseCore()
	modern, releaseModern := c.Table("events.events.k8s.io")
	defer releaseModern()
	// lastSeen returns the JSON of an Event's Last Seen cell in a Table.
	lastSeen := func(table *Table, name string) string {
		got := "no cells"
		table.Read(func(columns []protocol.Column, cells func(string) []any) {
			i := slices.IndexFunc(columns, func(c protocol.Column) bool { return c.Name == "Last Seen" })
			if i < 0 || columns[i].Type != protocol.ColumnTypeTimestamp {
				got = fmt.Sprintf("columns %+v", columns)
				return
			}
			if row := cells(ns + "/" + name); row != nil {
				raw, _ := json.Marshal(row[i])
				got = string(raw)
			}
		})
		return got
	}
	expect := func(want map[string]string) {
		t.Helper()
		eventually(t, func() (bool, string) {
			state := ""
			ok := true
			for _, table := range []struct {
				name  string
				table *Table
			}{{"events", core}, {"events.events.k8s.io", modern}} {
				for event, cell := range want {
					got := lastSeen(table.table, event)
					ok = ok && got == cell
					state += fmt.Sprintf("%s %s: %s; ", table.name, event, got)
				}
			}
			return ok, state
		})
	}

	first := time.Date(2026, 10, 24, 0, 1, 0, 0, time.UTC)
	legacy, err := cs.CoreV1().Events(ns).Create(ctx, &corev1.Event{
		ObjectMeta:     metav1.ObjectMeta{Name: "legacy"},
		InvolvedObject: corev1.ObjectReference{APIVersion: "v1", Kind: "ConfigMap", Name: "web", Namespace: ns},
		Reason:         "Legacy",
		Type:           "Normal",
		Count:          2,
		FirstTimestamp: metav1.NewTime(first),
		LastTimestamp:  metav1.NewTime(first.Add(time.Minute)),
	}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	observed := time.Date(2026, 10, 24, 0, 3, 0, 123456000, time.UTC)
	if _, err := cs.EventsV1().Events(ns).Create(ctx, &eventsv1.Event{
		ObjectMeta:          metav1.ObjectMeta{Name: "modern"},
		Regarding:           corev1.ObjectReference{APIVersion: "v1", Kind: "ConfigMap", Name: "web", Namespace: ns},
		EventTime:           metav1.NewMicroTime(first),
		Series:              &eventsv1.EventSeries{Count: 2, LastObservedTime: metav1.NewMicroTime(observed)},
		ReportingController: "test",
		ReportingInstance:   "test-1",
		Action:              "Test",
		Reason:              "Modern",
		Type:                "Normal",
	}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	expect(map[string]string{"legacy": `"2026-10-24T00:02:00Z"`, "modern": `"2026-10-24T00:03:00.123456Z"`})

	legacy.LastTimestamp = metav1.NewTime(first.Add(5 * time.Minute))
	if _, err := cs.CoreV1().Events(ns).Update(ctx, legacy, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	expect(map[string]string{"legacy": `"2026-10-24T00:06:00Z"`, "modern": `"2026-10-24T00:03:00.123456Z"`})
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
