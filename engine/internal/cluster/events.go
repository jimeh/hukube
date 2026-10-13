package cluster

import (
	"context"
	"slices"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/tools/cache"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

const (
	maxResourceEvents = 500
	// eventsMinWatchTimeout keeps quiet watches from relisting every second
	// resume after etcd compacts their resourceVersion. Events are uncached and
	// receive no bookmarks; 30 minutes asks for a timeout of 30 to 60 minutes.
	eventsMinWatchTimeout = 30 * time.Minute
)

// WatchEvents calls emit with the Events about one Resource after every list
// and watch change, newest first and capped at maxResourceEvents, until ctx ends.
// It waits for the Resource Type to be discovered before starting the watch.
// A type the connected Cluster does not serve is reported through onErr while
// waiting for it to appear.
//
// Failed lists or watch starts are passed to onErr and retried with a delay
// from Timing.ObjectRetry up to Timing.RetryMax. Held Events survive a failure;
// the next completed list emits them again to clear the error. An expired
// resourceVersion is handled by the Reflector without reporting it to onErr.
// Events are selected by kind, name, Namespace, incarnation, and API group,
// including references with no UID or the Resource's name as UID (ADR-0014).
func (c *Cluster) WatchEvents(
	ctx context.Context, p protocol.ResourceEventsParams,
	emit func(protocol.ResourceEvents), onErr func(error),
) {
	go func() {
		info, err := c.waitForType(ctx, p.Type, onErr)
		if err != nil {
			return
		}
		namespace := ""
		if info.Namespaced {
			namespace = p.Namespace
		}
		client := c.core.Events(namespace)
		selector := fields.Set{
			"involvedObject.kind":      info.Kind,
			"involvedObject.name":      p.Name,
			"involvedObject.namespace": namespace,
		}.AsSelector().String()
		store := &eventsStore{
			Store:  cache.NewStore(cache.MetaNamespaceKeyFunc),
			target: p, group: info.Group, emit: emit,
		}
		lw := &cache.ListWatch{
			ListWithContextFunc: func(ctx context.Context, opts metav1.ListOptions) (runtime.Object, error) {
				opts.FieldSelector = selector
				return client.List(ctx, opts)
			},
			WatchFuncWithContext: func(ctx context.Context, opts metav1.ListOptions) (watch.Interface, error) {
				opts.FieldSelector = selector
				return client.Watch(ctx, opts)
			},
		}
		c.runEvents(ctx, lw, store, onErr)
	}()
}

// runEvents owns retries so refused lists use the Cluster's logger and Timing.
func (c *Cluster) runEvents(ctx context.Context, lw cache.ListerWatcher, store *eventsStore, onErr func(error)) {
	delay := c.timing.ObjectRetry
	store.listed = func() { delay = c.timing.ObjectRetry }
	watcher := eventsListerWatcher{lw, cache.ToListerWatcherWithContext(lw)}
	reflector := cache.NewReflectorWithOptions(watcher, &corev1.Event{}, store, cache.ReflectorOptions{
		Name:            c.id + "/events/" + store.target.Name,
		TypeDescription: "Events",
		MinWatchTimeout: eventsMinWatchTimeout,
	})
	for ctx.Err() == nil {
		started := time.Now()
		err := reflector.ListAndWatchWithContext(ctx)
		if ctx.Err() != nil {
			return
		}
		wait := delay
		switch {
		case err != nil:
			onErr(err)
			c.log.Warn("events watch failed", "err", err, "retry", wait)
			delay = min(delay*2, c.timing.RetryMax)
		case time.Since(started) >= c.timing.ObjectRetry:
			continue
		}
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
	}
}

// eventsListerWatcher disables streaming lists for uncached Events. Each
// attempt must complete a list before starting its watch.
type eventsListerWatcher struct {
	cache.ListerWatcher
	cache.ListerWatcherWithContext
}

func (eventsListerWatcher) IsWatchListSemanticsUnSupported() bool { return true }

// eventsStore emits after the Reflector replaces its list or changes a row.
// listed resets the retry delay after a completed list.
type eventsStore struct {
	cache.Store
	mu     sync.Mutex
	target protocol.ResourceEventsParams
	group  string
	emit   func(protocol.ResourceEvents)
	listed func()
}

func (s *eventsStore) send() {
	events := make([]*corev1.Event, 0)
	for _, obj := range s.List() {
		ev := obj.(*corev1.Event)
		if eventMatches(ev.InvolvedObject, s.target, s.group) {
			events = append(events, ev)
		}
	}
	s.emit(resourceEvents(events))
}

func (s *eventsStore) change(fn func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := fn(); err != nil {
		return err
	}
	s.send()
	return nil
}
func (s *eventsStore) Add(obj any) error { return s.change(func() error { return s.Store.Add(obj) }) }
func (s *eventsStore) Update(obj any) error {
	return s.change(func() error { return s.Store.Update(obj) })
}
func (s *eventsStore) Delete(obj any) error {
	return s.change(func() error { return s.Store.Delete(obj) })
}
func (s *eventsStore) Replace(items []any, rv string) error {
	return s.change(func() error {
		if err := s.Store.Replace(items, rv); err != nil {
			return err
		}
		if s.listed != nil {
			s.listed()
		}
		return nil
	})
}

func eventMatches(ref corev1.ObjectReference, target protocol.ResourceEventsParams, group string) bool {
	sameIncarnation := target.UID == "" || ref.UID == "" || string(ref.UID) == target.UID || string(ref.UID) == target.Name
	sameGroup := (ref.UID != "" && string(ref.UID) == target.UID) || ref.APIVersion == "" ||
		schema.FromAPIVersionAndKind(ref.APIVersion, ref.Kind).Group == group
	return sameIncarnation && sameGroup
}

func resourceEvent(ev *corev1.Event) protocol.ResourceEvent {
	var seriesTime time.Time
	if ev.Series != nil {
		seriesTime = ev.Series.LastObservedTime.Time
	}
	var last time.Time
	for _, timestamp := range []time.Time{
		seriesTime, ev.LastTimestamp.Time, ev.EventTime.Time,
		ev.FirstTimestamp.Time, ev.CreationTimestamp.Time,
	} {
		if !timestamp.IsZero() {
			last = timestamp
			break
		}
	}
	count := int(ev.Count)
	if count <= 0 {
		count = 1
	}
	if ev.Series != nil {
		count = int(ev.Series.Count)
	}
	reporter, instance := ev.Source.Component, ev.Source.Host
	if reporter == "" {
		reporter = ev.ReportingController
	}
	if instance == "" {
		instance = ev.ReportingInstance
	}
	return protocol.ResourceEvent{
		UID: string(ev.UID), Type: ev.Type, Reason: ev.Reason, Message: ev.Message,
		Count: count, LastSeen: last, Reporter: reporter, ReporterInstance: instance,
	}
}

func resourceEvents(events []*corev1.Event) protocol.ResourceEvents {
	result := protocol.ResourceEvents{Events: make([]protocol.ResourceEvent, 0, len(events)), Total: len(events)}
	for _, ev := range events {
		result.Events = append(result.Events, resourceEvent(ev))
		if ev.Type == "Warning" {
			result.Warnings++
		}
	}
	slices.SortFunc(result.Events, func(a, b protocol.ResourceEvent) int {
		if cmp := b.LastSeen.Compare(a.LastSeen); cmp != 0 {
			return cmp
		}
		return strings.Compare(a.UID, b.UID)
	})
	if len(result.Events) > maxResourceEvents {
		result.Events = result.Events[:maxResourceEvents]
	}
	return result
}
