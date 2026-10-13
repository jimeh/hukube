package cluster

import (
	"context"
	"errors"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	utilnet "k8s.io/apimachinery/pkg/util/net"
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
// A failed list, and a watch that cannot start, are passed to onErr and
// retried with a delay from Timing.ObjectRetry up to Timing.RetryMax, which
// goes back to its start once a watch has started. Held Events survive a
// failure; the next completed list emits them again to clear the error. Two
// cases are not reported: an expired resourceVersion, which the next list
// answers, and a 429 at the start of a watch, which the Reflector retries by
// itself.
// Events are selected by kind, name, Namespace, incarnation, and API group,
// including references with no UID, the Resource's name as UID, or one of the
// params' other UIDs (ADR-0014).
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
	watcher := eventsListerWatcher{
		ListerWatcher: lw, ListerWatcherWithContext: cache.ToListerWatcherWithContext(lw),
		started: func() { delay = c.timing.ObjectRetry },
	}
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
		if expired(err) {
			// The next attempt lists again, which is all an expired
			// resourceVersion needs.
			err = nil
		}
		wait := delay
		switch {
		case err != nil:
			err = requestCause(err)
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
	started func()
}

func (eventsListerWatcher) IsWatchListSemanticsUnSupported() bool { return true }

// WatchWithContext makes a refused connection end the attempt. A
// Reflector retries a refused connection inside the attempt without
// returning, so an unreachable Cluster would leave the client with Events that
// no longer update and no error. An error the Reflector does not recognize
// returns to runEvents, which reports it and lists again. A 429 stays with
// the Reflector, which backs off and resumes the watch without another list.
// A started watch resets the retry delay.
func (w eventsListerWatcher) WatchWithContext(ctx context.Context, opts metav1.ListOptions) (watch.Interface, error) {
	result, err := w.ListerWatcherWithContext.WatchWithContext(ctx, opts)
	if utilnet.IsConnectionRefused(err) {
		return nil, errors.New(requestCause(err).Error())
	}
	if err == nil {
		w.started()
	}
	return result, err
}

// requestCause drops the request's URL from a transport error. The URL holds
// the whole field selector, which says nothing a user can act on.
func requestCause(err error) error {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return urlErr.Err
	}
	return err
}

// eventsStore emits after the Reflector replaces its list or changes a row.
type eventsStore struct {
	cache.Store
	mu     sync.Mutex
	target protocol.ResourceEventsParams
	group  string
	emit   func(protocol.ResourceEvents)
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
	return s.change(func() error { return s.Store.Replace(items, rv) })
}

func eventMatches(ref corev1.ObjectReference, target protocol.ResourceEventsParams, group string) bool {
	knownUID := string(ref.UID) == target.UID || slices.Contains(target.OtherUIDs, string(ref.UID))
	sameIncarnation := target.UID == "" || ref.UID == "" || knownUID || string(ref.UID) == target.Name
	sameGroup := (ref.UID != "" && knownUID) || ref.APIVersion == "" ||
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
