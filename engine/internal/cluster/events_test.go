package cluster

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"reflect"
	"slices"
	"sync"
	"syscall"
	"testing"
	"testing/synctest"
	"time"

	corev1 "k8s.io/api/core/v1"
	eventsv1 "k8s.io/api/events/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

func TestResourceEventFallbacks(t *testing.T) {
	ts := func(n int) metav1.Time { return metav1.NewTime(time.Unix(int64(n), 0)) }
	cases := []struct {
		name               string
		event              corev1.Event
		last               int
		count              int
		reporter, instance string
	}{
		{
			"legacy recorder",
			corev1.Event{
				ObjectMeta: metav1.ObjectMeta{
					CreationTimestamp: ts(2),
				},
				FirstTimestamp: ts(3),
				EventTime:      metav1.NewMicroTime(ts(4).Time),
				LastTimestamp:  ts(5),
				Count:          3,
				Source: corev1.EventSource{
					Component: "kubelet",
					Host:      "node",
				},
			},
			5,
			3,
			"kubelet",
			"node",
		},
		{
			"modern recorder",
			corev1.Event{
				ObjectMeta: metav1.ObjectMeta{
					CreationTimestamp: ts(2),
				},
				FirstTimestamp:      ts(3),
				EventTime:           metav1.NewMicroTime(ts(4).Time),
				ReportingController: "scheduler",
				ReportingInstance:   "instance",
			},
			4,
			1,
			"scheduler",
			"instance",
		},
		{
			"series",
			corev1.Event{
				LastTimestamp: ts(5),
				EventTime:     metav1.NewMicroTime(ts(4).Time),
				Count:         3,
				Series: &corev1.EventSeries{
					Count:            7,
					LastObservedTime: metav1.NewMicroTime(ts(6).Time),
				},
			},
			6,
			7,
			"",
			"",
		},
		{
			"first timestamp",
			corev1.Event{
				ObjectMeta: metav1.ObjectMeta{
					CreationTimestamp: ts(2),
				},
				FirstTimestamp: ts(3),
				Count:          -1,
			},
			3,
			1,
			"",
			"",
		},
		{"creation timestamp", corev1.Event{ObjectMeta: metav1.ObjectMeta{CreationTimestamp: ts(2)}}, 2, 1, "", ""},
		{"zero series timestamp", corev1.Event{Series: &corev1.EventSeries{Count: 2}, LastTimestamp: ts(5)}, 5, 2, "", ""},
		{
			"independent reporter fallbacks",
			corev1.Event{
				Source: corev1.EventSource{
					Component: "old",
				},
				ReportingController: "new",
				ReportingInstance:   "new-host",
			},
			-62135596800,
			1,
			"old",
			"new-host",
		},
		{
			"source takes precedence",
			corev1.Event{
				Source: corev1.EventSource{
					Component: "old",
					Host:      "old-host",
				},
				ReportingController: "new",
				ReportingInstance:   "new-host",
			},
			-62135596800,
			1,
			"old",
			"old-host",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resourceEvent(&tc.event)
			if got.LastSeen.Unix() != int64(tc.last) || got.Count != tc.count ||
				got.Reporter != tc.reporter || got.ReporterInstance != tc.instance {
				t.Fatalf("conversion = %+v, want last %d count %d reporter %q instance %q",
					got, tc.last, tc.count, tc.reporter, tc.instance)
			}
		})
	}
}

func TestEventMatches(t *testing.T) {
	for _, tc := range []struct {
		name, targetUID, refUID, version string
		want                             bool
		otherUIDs                        []string
	}{
		{"exact UID ignores group", "new", "new", "other/v1", true, nil},
		{"old UID", "new", "old", "apps/v1", false, nil},
		{"name as UID", "new", "web", "apps/v1", true, nil},
		{"empty UID", "new", "", "apps/v1", true, nil},
		{"unknown target UID", "", "old", "apps/v1", true, nil},
		{"wrong group", "new", "", "other/v1", false, nil},
		{"unknown UID wrong group", "", "old", "other/v1", false, nil},
		{"missing version", "new", "", "", true, nil},
		{"core group differs", "new", "", "v1", false, nil},
		{"alias UID", "new", "hash", "apps/v1", true, []string{"hash"}},
		{"alias UID ignores group", "new", "hash", "other/v1", true, []string{"hash"}},
		{"alias does not match unrelated UID", "new", "old", "apps/v1", false, []string{"hash"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := eventMatches(corev1.ObjectReference{
				UID:        types.UID(tc.refUID),
				APIVersion: tc.version,
			}, protocol.ResourceEventsParams{
				Name:      "web",
				UID:       tc.targetUID,
				OtherUIDs: tc.otherUIDs,
			}, "apps")
			if got != tc.want {
				t.Fatalf("match = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestResourceEventsOrderCapAndCounts(t *testing.T) {
	events := make([]*corev1.Event, 501)
	for i := range events {
		events[i] = &corev1.Event{
			ObjectMeta: metav1.ObjectMeta{
				UID: types.UID(fmt.Sprintf("%03d", 500-i)),
			},
			Type:          "Warning",
			LastTimestamp: metav1.NewTime(time.Unix(1, 0)),
		}
	}
	events[0].LastTimestamp = metav1.NewTime(time.Unix(2, 0))
	got := resourceEvents(events)
	if len(got.Events) != 500 || got.Total != 501 || got.Warnings != 501 ||
		got.Events[0].UID != "500" || got.Events[1].UID != "000" || got.Events[499].UID != "498" {
		t.Fatalf("order/cap/counts: first %+v, last %+v, total %d warnings %d rows %d",
			got.Events[:2], got.Events[len(got.Events)-1], got.Total, got.Warnings, len(got.Events))
	}
	if resourceEvents(nil).Events == nil {
		t.Fatal("empty Events must encode as an array")
	}
}

// fakeEvents gates each list and watch so tests observe attempts and control
// their results. Calls record virtual time inside synctest's bubble.
type fakeEvents struct {
	ctx     context.Context
	cancel  context.CancelFunc
	done    chan struct{}
	lists   chan eventsListCall
	watches chan eventsWatchCall
}

type eventsListCall struct {
	at     time.Time
	result chan eventsListResult
}

type eventsListResult struct {
	events []corev1.Event
	err    error
}

type eventsWatchCall struct {
	opts    metav1.ListOptions
	watcher *watch.FakeWatcher
	result  chan error
}

func (f *fakeEvents) List(metav1.ListOptions) (runtime.Object, error) {
	call := eventsListCall{at: time.Now(), result: make(chan eventsListResult)}
	select {
	case f.lists <- call:
	case <-f.ctx.Done():
		return nil, f.ctx.Err()
	}
	var result eventsListResult
	select {
	case result = <-call.result:
	case <-f.ctx.Done():
		return nil, f.ctx.Err()
	}
	return &corev1.EventList{
		ListMeta: metav1.ListMeta{ResourceVersion: "1"}, Items: result.events,
	}, result.err
}

func (f *fakeEvents) Watch(opts metav1.ListOptions) (watch.Interface, error) {
	call := eventsWatchCall{opts: opts, watcher: watch.NewFake(), result: make(chan error)}
	select {
	case f.watches <- call:
	case <-f.ctx.Done():
		return nil, f.ctx.Err()
	}
	select {
	case err := <-call.result:
		if err != nil {
			return nil, err
		}
	case <-f.ctx.Done():
		return nil, f.ctx.Err()
	}
	return call.watcher, nil
}

func startFakeEvents(t *testing.T) (*fakeEvents, *eventsStore, chan protocol.ResourceEvents, chan error) {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	timing := testTiming()
	timing.RetryMax = 300 * time.Millisecond
	c := &Cluster{timing: timing, log: slog.New(slog.DiscardHandler)}
	fake := &fakeEvents{ctx: ctx, cancel: cancel, done: make(chan struct{}), lists: make(chan eventsListCall), watches: make(chan eventsWatchCall)}
	values := make(chan protocol.ResourceEvents, 10)
	failures := make(chan error, 10)
	store := &eventsStore{
		Store: cache.NewStore(cache.MetaNamespaceKeyFunc),
		emit:  func(d protocol.ResourceEvents) { values <- d },
	}
	go func() {
		defer close(fake.done)
		c.runEvents(ctx, fake, store, func(err error) { failures <- err })
	}()
	return fake, store, values, failures
}

func TestEventsListFailureRecovery(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fake, store, values, failures := startFakeEvents(t)
		event := corev1.Event{ObjectMeta: metav1.ObjectMeta{Name: "one", UID: "one"}}
		first := <-fake.lists
		first.result <- eventsListResult{events: []corev1.Event{event}}
		initial := <-values
		w := <-fake.watches
		w.result <- nil
		w.watcher.Error(&apierrors.NewResourceExpired("old version").ErrStatus)
		call := <-fake.lists
		denied := apierrors.NewForbidden(schema.GroupResource{Resource: "events"}, "", nil)
		for i := 0; i < 2; i++ {
			call.result <- eventsListResult{err: denied}
			call = <-fake.lists
			if err := <-failures; !errors.Is(err, denied) {
				t.Fatalf("error = %v, want %v", err, denied)
			}
			synctest.Wait()
			if len(failures) != 0 || len(values) != 0 {
				t.Fatalf("failure reported more than once or emitted data: errors %d values %d", len(failures), len(values))
			}
			if got := store.List(); len(got) != 1 || got[0].(*corev1.Event).UID != event.UID {
				t.Fatalf("failed list replaced held Events: %+v", got)
			}
		}
		call.result <- eventsListResult{events: []corev1.Event{event}}
		recovered := <-values
		if !reflect.DeepEqual(initial, recovered) {
			t.Fatalf("recovery = %+v, want %+v", recovered, initial)
		}
		w = <-fake.watches
		w.result <- nil
	})
}

func TestEventsExpiredWatchRelistsWithoutError(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fake, _, values, failures := startFakeEvents(t)
		first := <-fake.lists
		first.result <- eventsListResult{}
		<-values
		w := <-fake.watches
		if timeout := *w.opts.TimeoutSeconds; timeout < 1800 || timeout >= 3600 {
			t.Fatalf("watch timeout = %d, want 30 to 60 minutes", timeout)
		}
		w.result <- nil
		w.watcher.Error(&metav1.Status{Status: "Failure", Code: 410, Reason: metav1.StatusReasonExpired})
		next := <-fake.lists
		if delay := next.at.Sub(first.at); delay != testTiming().ObjectRetry {
			t.Fatalf("short watch relisted after %s, want %s", delay, testTiming().ObjectRetry)
		}
		if len(failures) != 0 {
			t.Fatalf("expired watch reported %d errors", len(failures))
		}
		next.result <- eventsListResult{}
		<-values
		w = <-fake.watches
		w.result <- nil
	})
}

// A Reflector retries a refused watch inside an attempt without returning. The
// attempt must end instead, so the failure is reported and the next list
// clears it.
func TestEventsRefusedWatchIsReportedAndRelists(t *testing.T) {
	dial := &net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}
	for name, tc := range map[string]struct{ refused, want error }{
		// The request's URL, which holds the field selector, is left out.
		"connection refused": {&url.Error{Op: "Get", URL: "https://cluster/events?fieldSelector=x", Err: dial}, dial},
		"too many requests":  {apierrors.NewTooManyRequests("slow down", 1), nil},
	} {
		refused, want := tc.refused, tc.want
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				fake, _, values, failures := startFakeEvents(t)
				first := <-fake.lists
				first.result <- eventsListResult{}
				<-values
				w := <-fake.watches
				w.result <- refused
				select {
				case err := <-failures:
					if want == nil {
						t.Fatalf("429 reported instead of resuming the watch: %v", err)
					}
					if err.Error() != want.Error() {
						t.Fatalf("error = %v, want %v", err, want)
					}
				case retry := <-fake.watches:
					if want != nil {
						t.Fatal("the watch was retried inside the attempt without a report")
					}
					if retry.opts.ResourceVersion != w.opts.ResourceVersion {
						t.Fatalf("resumed at %q, want %q", retry.opts.ResourceVersion, w.opts.ResourceVersion)
					}
					retry.result <- nil
					synctest.Wait()
					if len(failures) != 0 || len(values) != 0 {
						t.Fatalf("429 reported or relisted: errors %d values %d", len(failures), len(values))
					}
					return
				case <-fake.lists:
					t.Fatal("the watch failure relisted without reporting it")
				}
				next := <-fake.lists
				if delay := next.at.Sub(first.at); delay != testTiming().ObjectRetry {
					t.Fatalf("relisted after %s, want %s", delay, testTiming().ObjectRetry)
				}
				next.result <- eventsListResult{}
				<-values
				w = <-fake.watches
				w.result <- nil
			})
		})
	}
}

// The API server can also refuse an expired resourceVersion when the watch
// starts, instead of sending an error event.
func TestEventsExpiredWatchStartRelistsWithoutError(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fake, _, values, failures := startFakeEvents(t)
		first := <-fake.lists
		first.result <- eventsListResult{}
		<-values
		w := <-fake.watches
		w.result <- apierrors.NewResourceExpired("old version")
		next := <-fake.lists
		if delay := next.at.Sub(first.at); delay != testTiming().ObjectRetry {
			t.Fatalf("relisted after %s, want %s", delay, testTiming().ObjectRetry)
		}
		if len(failures) != 0 {
			t.Fatalf("expired watch start reported %d errors", len(failures))
		}
		next.result <- eventsListResult{}
		<-values
		w = <-fake.watches
		w.result <- nil
	})
}

func TestEventsRetryDelayDoubles(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fake, _, values, failures := startFakeEvents(t)
		denied := apierrors.NewForbidden(schema.GroupResource{Resource: "events"}, "", nil)
		call := <-fake.lists
		for _, want := range []time.Duration{
			100 * time.Millisecond, 200 * time.Millisecond, 300 * time.Millisecond, 300 * time.Millisecond,
		} {
			previous := call.at
			call.result <- eventsListResult{}
			<-values
			w := <-fake.watches
			w.result <- denied
			call = <-fake.lists
			if delay := call.at.Sub(previous); delay != want {
				t.Fatalf("retry delay = %s, want %s", delay, want)
			}
			if err := <-failures; !errors.Is(err, denied) {
				t.Fatalf("error = %v, want %v", err, denied)
			}
		}
		// A started watch resets the delay even if its next resume fails.
		startedAt := call.at
		call.result <- eventsListResult{}
		<-values
		w := <-fake.watches
		w.result <- nil
		w.watcher.Add(&corev1.Event{ObjectMeta: metav1.ObjectMeta{Name: "one", ResourceVersion: "2"}})
		<-values
		w.watcher.Stop()
		resume := <-fake.watches
		resume.result <- denied
		call = <-fake.lists
		if delay := call.at.Sub(startedAt); delay != testTiming().ObjectRetry {
			t.Fatalf("retry after started watch = %s, want %s", delay, testTiming().ObjectRetry)
		}
		if err := <-failures; !errors.Is(err, denied) {
			t.Fatalf("watch-start error = %v, want %v", err, denied)
		}
		call.result <- eventsListResult{}
		<-values
		w = <-fake.watches
		w.result <- nil
	})
}

func TestEventsCancelStopsWatch(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fake, _, values, _ := startFakeEvents(t)
		call := <-fake.lists
		call.result <- eventsListResult{}
		<-values
		w := <-fake.watches
		w.result <- nil
		synctest.Wait()
		if w.watcher.IsStopped() {
			t.Fatal("watch stopped before cancellation")
		}
		fake.cancel()
		synctest.Wait()
		select {
		case <-fake.done:
		default:
			t.Fatal("runEvents did not return after cancellation")
		}
		if !w.watcher.IsStopped() {
			t.Fatal("watch was not stopped after cancellation")
		}
	})
}

func TestWatchEventsSelectionAndChanges(t *testing.T) {
	c := connect(t)
	cs := kubernetes.NewForConfigOrDie(cfg)
	ns := createNamespace(t, cs)
	otherNS := createNamespace(t, cs)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cm, err := cs.CoreV1().ConfigMaps(ns).Create(ctx, &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name: "watched",
		},
	}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	oldUID := cm.UID
	if err := cs.CoreV1().ConfigMaps(ns).Delete(ctx, cm.Name, metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	cm, err = cs.CoreV1().ConfigMaps(ns).Create(ctx, &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name: "watched",
		},
	}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	makeEvent := func(eventNS, name, kind, targetName string, uid types.UID) *corev1.Event {
		ev, err := cs.CoreV1().Events(eventNS).Create(ctx, &corev1.Event{
			ObjectMeta: metav1.ObjectMeta{
				Name: name,
			},
			InvolvedObject: corev1.ObjectReference{
				APIVersion: "v1",
				Kind:       kind,
				Name:       targetName,
				Namespace:  eventNS,
				UID:        uid,
			},
			Reason:        name,
			Message:       "message",
			Type:          "Warning",
			Count:         1,
			LastTimestamp: metav1.Now(),
		}, metav1.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
		return ev
	}
	current := makeEvent(ns, "current", "ConfigMap", "watched", cm.UID)
	makeEvent(ns, "old", "ConfigMap", "watched", oldUID)
	makeEvent(ns, "no-uid", "ConfigMap", "watched", "")
	makeEvent(ns, "other-name", "ConfigMap", "other", "")
	makeEvent(ns, "other-kind", "Secret", "watched", "")
	makeEvent(otherNS, "other-namespace", "ConfigMap", "watched", "")
	p := protocol.ResourceEventsParams{Type: "configmaps", Namespace: ns, Name: "watched", UID: string(cm.UID)}
	observe := func(p protocol.ResourceEventsParams) func(int, func(protocol.ResourceEvents) bool) {
		var mu sync.Mutex
		var latest protocol.ResourceEvents
		var lastErr error
		c.WatchEvents(ctx, p, func(d protocol.ResourceEvents) {
			mu.Lock()
			latest = d
			lastErr = nil
			mu.Unlock()
		}, func(err error) {
			mu.Lock()
			lastErr = err
			mu.Unlock()
		})
		return func(total int, match func(protocol.ResourceEvents) bool) {
			t.Helper()
			eventually(t, func() (bool, string) {
				mu.Lock()
				defer mu.Unlock()
				return latest.Events != nil && latest.Total == total && (match == nil || match(latest)),
					fmt.Sprintf("%+v error %v", latest, lastErr)
			})
		}
	}
	expect := observe(p)
	hasReasons := func(want ...string) func(protocol.ResourceEvents) bool {
		return func(d protocol.ResourceEvents) bool {
			got := make([]string, 0, len(d.Events))
			for _, ev := range d.Events {
				got = append(got, ev.Reason)
			}
			slices.Sort(got)
			return slices.Equal(got, want)
		}
	}
	expect(2, hasReasons("current", "no-uid"))
	unknown := p
	unknown.UID = ""
	expectUnknown := observe(unknown)
	expectUnknown(3, hasReasons("current", "no-uid", "old"))
	current.Count = 4
	current.LastTimestamp = metav1.NewTime(time.Now().Add(time.Minute))
	current, err = cs.CoreV1().Events(ns).Update(ctx, current, metav1.UpdateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	expect(2, func(d protocol.ResourceEvents) bool {
		return hasReasons("current", "no-uid")(d) && d.Events[0].UID == string(current.UID) && d.Events[0].Count == 4 &&
			d.Events[0].LastSeen.Equal(current.LastTimestamp.Time)
	})
	if err := cs.CoreV1().Events(ns).Delete(ctx, current.Name, metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	expect(1, hasReasons("no-uid"))
	expectUnknown(2, hasReasons("no-uid", "old"))
}

func TestWatchEventsClusterScopedAndModern(t *testing.T) {
	c := connect(t)
	cs := kubernetes.NewForConfigOrDie(cfg)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	node, err := cs.CoreV1().Nodes().Create(ctx, &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			GenerateName: "events-node-",
		},
	}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := cs.CoreV1().Nodes().Delete(context.Background(), node.Name, metav1.DeleteOptions{}); err != nil {
			t.Error(err)
		}
	})
	cleanupEvent := func(name string) {
		t.Cleanup(func() {
			if err := cs.CoreV1().Events("default").Delete(context.Background(), name, metav1.DeleteOptions{}); err != nil {
				t.Error(err)
			}
		})
	}
	for i, uid := range []types.UID{node.UID, types.UID(node.Name), ""} {
		ev, err := cs.CoreV1().Events("default").Create(ctx, &corev1.Event{
			ObjectMeta: metav1.ObjectMeta{
				GenerateName: "node-event-",
			},
			InvolvedObject: corev1.ObjectReference{
				APIVersion: "v1",
				Kind:       "Node",
				Name:       node.Name,
				UID:        uid,
			},
			Reason: fmt.Sprintf("Test%d", i),
			Type:   "Normal",
		}, metav1.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
		cleanupEvent(ev.Name)
	}
	ev, err := cs.CoreV1().Events("default").Create(ctx, &corev1.Event{
		ObjectMeta: metav1.ObjectMeta{
			GenerateName: "namespaced-event-",
		},
		InvolvedObject: corev1.ObjectReference{
			APIVersion: "v1",
			Kind:       "Node",
			Name:       node.Name,
			Namespace:  "default",
		},
		Reason: "Other",
		Type:   "Normal",
	}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	cleanupEvent(ev.Name)
	last := metav1.NewMicroTime(time.Now().Truncate(time.Microsecond))
	modern, err := cs.EventsV1().Events("default").Create(ctx, &eventsv1.Event{
		ObjectMeta: metav1.ObjectMeta{
			GenerateName: "modern-event-",
		},
		Regarding: corev1.ObjectReference{
			APIVersion: "v1",
			Kind:       "Node",
			Name:       node.Name,
		},
		EventTime: last,
		Series: &eventsv1.EventSeries{
			Count:            9,
			LastObservedTime: last,
		},
		ReportingController: "test",
		ReportingInstance:   "test-1",
		Action:              "Test",
		Reason:              "Modern",
		Type:                "Normal",
	}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	cleanupEvent(modern.Name)
	var mu sync.Mutex
	var latest protocol.ResourceEvents
	c.WatchEvents(ctx, protocol.ResourceEventsParams{
		Type: "nodes",
		Name: node.Name,
		UID:  string(node.UID),
	}, func(d protocol.ResourceEvents) {
		mu.Lock()
		latest = d
		mu.Unlock()
	}, func(err error) {
		t.Log(err)
	})
	eventually(t, func() (bool, string) {
		mu.Lock()
		defer mu.Unlock()
		matches := 0
		for _, ev := range latest.Events {
			if ev.UID == string(modern.UID) && ev.Count == 9 && ev.LastSeen.Equal(last.Time) {
				matches++
			}
		}
		return latest.Total == 4 && matches == 1, fmt.Sprintf("%+v", latest)
	})
}
