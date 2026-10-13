// Package logstream reads a Resource's containers into a bounded Log Stream.
package logstream

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/jimeh/hukube/engine/internal/protocol"
	"github.com/jimeh/hukube/engine/internal/relationship"
)

// Cluster supplies state and the requests a Log Stream needs.
type Cluster interface {
	Type(protocol.TypeKey) (protocol.ResourceType, bool)
	Status() protocol.ClusterStatus
	TypesChanged() (<-chan struct{}, func())
	StatusChanged() (<-chan struct{}, func())
	WatchObject(context.Context, protocol.ResourceRef, func(protocol.ResourceData), func(error))
	OpenPodLogs(context.Context, string, string, *corev1.PodLogOptions) (io.ReadCloser, error)
}

// Graph selects Pods through ownership Relationships.
type Graph interface {
	Node(protocol.TypeKey, string, string) (relationship.Node, bool)
	AllOwned(relationship.Node) []relationship.Node
	Changed() (<-chan struct{}, func())
}

// Consumer accepts frames without waiting for their delivery to a client.
type Consumer interface {
	Frame([]byte, int)
	Status(protocol.LogStreamStatus)
}

// Timing holds a Log Stream's delays and limits, so tests can shorten them.
type Timing struct {
	// RetryMin and RetryMax bound the delay before a container's log request
	// is opened again. The delay doubles between them.
	RetryMin, RetryMax time.Duration
	// Graph is the least time between two computations of the Pod set.
	Graph time.Duration
	// Status is the least time between two statuses.
	Status time.Duration
	// Batch is how long records wait to be merged with other containers'.
	Batch time.Duration
	// Initial is the longest the first batch waits for every container.
	Initial time.Duration
	// Appear is how long a target the index does not hold yet is waited for.
	Appear time.Duration
	// Silent is how long a fast follow may deliver nothing before it is
	// opened again. A follow is fast once it carries more than FastBytes
	// within FastWindow.
	Silent, FastWindow time.Duration
	FastBytes          int
	// BatchBytes sends a batch early, and FrameBytes splits it into frames.
	BatchBytes, FrameBytes int
	// Pods is the most Pods one Log Stream reads.
	Pods int
}

// DefaultTiming is the Timing of a Log Stream outside tests.
var DefaultTiming = Timing{
	RetryMin:   time.Second,
	RetryMax:   30 * time.Second,
	Graph:      250 * time.Millisecond,
	Status:     100 * time.Millisecond,
	Batch:      100 * time.Millisecond,
	Initial:    time.Second,
	Appear:     10 * time.Second,
	Silent:     15 * time.Second,
	FastWindow: time.Second,
	FastBytes:  2 << 20,
	BatchBytes: 256 << 10,
	FrameBytes: 64 << 10,
	Pods:       protocol.LogStreamMaxPods,
}

type podChange struct {
	uid  string
	data protocol.ResourceData
	err  error
}
type followedPod struct {
	node    relationship.Node
	cancel  context.CancelFunc
	loaded  bool
	names   []protocol.LogContainer
	readers map[string]*containerReader
}
type sourceEntry struct {
	source   protocol.LogSource
	settled  bool
	activity time.Time
}
type stream struct {
	ctx                          context.Context
	c                            Cluster
	out                          Consumer
	p                            protocol.LogStreamParams
	t                            Timing
	mu                           sync.Mutex
	sources                      map[int]*sourceEntry
	names                        []protocol.LogContainer
	pods, followed, nextID       int
	tail                         int64
	batch                        []record
	batchBytes                   int
	first, ready                 bool
	started, batchAt, lastStatus time.Time
	lastJSON                     []byte
	fatal                        chan error
}

func emptyStatus() protocol.LogStreamStatus {
	return protocol.LogStreamStatus{Sources: []protocol.LogSource{}, Containers: []protocol.LogContainer{}}
}

// Run owns every watch and reader until the target ends or ctx is cancelled.
func Run(ctx context.Context, c Cluster, g Graph, p protocol.LogStreamParams, out Consumer, timing Timing) protocol.StreamEnd {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s := &stream{ctx: ctx, c: c, p: p, out: out, t: timing, sources: map[int]*sourceEntry{}, first: true, started: time.Now(), fatal: make(chan error, 1)}
	initialStatus := emptyStatus()
	out.Status(initialStatus)
	s.lastJSON, _ = json.Marshal(initialStatus)
	s.lastStatus = time.Now()
	graph, ungraph := g.Changed()
	defer ungraph()
	types, untypes := c.TypesChanged()
	defer untypes()
	status, unstatus := c.StatusChanged()
	defer unstatus()
	changes := make(chan podChange, 64)
	pods := map[string]*followedPod{}
	defer func() {
		for _, pod := range pods {
			pod.cancel()
		}
	}()
	tick := time.NewTicker(min(timing.Batch, timing.Status, timing.Graph))
	defer tick.Stop()
	var lastGraph time.Time
	dirty := true
	selected := false
	// The UI learns of a Resource from its own watch, which can be ahead of
	// the index. Until the index has shown the incarnation once, its absence
	// means "not yet" for a while, not "deleted".
	var missingSince time.Time
	initial := make(chan struct{})
	initialDone := false
	var initialAt time.Time
	defer func() {
		if !initialDone {
			close(initial)
		}
	}()
	finish := func(reason protocol.StreamEndReason, err error) protocol.StreamEnd {
		cancel()
		s.mu.Lock()
		s.flushLocked()
		s.ready = s.ready || selected
		for {
			wait := s.statusLocked(false)
			if wait <= 0 {
				break
			}
			s.mu.Unlock()
			timer := time.NewTimer(wait)
			<-timer.C
			s.mu.Lock()
		}
		s.mu.Unlock()
		end := protocol.StreamEnd{Reason: reason}
		if err != nil {
			end.Error = errorDetail(err)
		}
		return end
	}
	for {
		if dirty && (!selected || !p.Previous) && time.Since(lastGraph) >= timing.Graph {
			ready, err := targetReady(c, p.Type)
			if err != nil {
				return finish(protocol.StreamEndReasonError, err)
			}
			if ready {
				node, found := g.Node(p.Type, p.Namespace, p.Name)
				if !found || node.Meta.UID != p.UID {
					if selected || (!missingSince.IsZero() && time.Since(missingSince) >= timing.Appear) {
						return finish(protocol.StreamEndReasonDeleted, nil)
					}
					if missingSince.IsZero() {
						missingSince = time.Now()
					}
					// Stay dirty, to look again after the next interval.
					lastGraph = time.Now()
					continue
				}
				candidates := []relationship.Node{}
				if p.Type == "pods" {
					candidates = append(candidates, node)
				} else {
					for _, owned := range g.AllOwned(node) {
						if owned.Type == "pods" {
							candidates = append(candidates, owned)
						}
					}
				}
				slices.SortFunc(candidates, func(a, b relationship.Node) int {
					return cmp.Or(b.Meta.CreatedAt.Compare(a.Meta.CreatedAt), cmp.Compare(a.Meta.Name, b.Meta.Name), cmp.Compare(a.Meta.UID, b.Meta.UID))
				})
				present := map[string]bool{}
				for _, n := range candidates {
					present[n.Meta.UID] = true
				}
				for uid, pod := range pods {
					if !present[uid] {
						s.removePod(pod)
						delete(pods, uid)
					}
				}
				for _, n := range candidates {
					if len(pods) >= timing.Pods {
						break
					}
					if _, ok := pods[n.Meta.UID]; ok {
						continue
					}
					wctx, stop := context.WithCancel(ctx)
					pods[n.Meta.UID] = &followedPod{node: n, cancel: stop, readers: map[string]*containerReader{}}
					uid := n.Meta.UID
					ref := protocol.ResourceRef{Cluster: p.Cluster, Type: "pods", Namespace: n.Meta.Namespace, Name: n.Meta.Name}
					c.WatchObject(wctx, ref, func(d protocol.ResourceData) {
						select {
						case changes <- podChange{uid: uid, data: d}:
						case <-wctx.Done():
						}
					}, func(err error) {
						select {
						case changes <- podChange{uid: uid, err: err}:
						case <-wctx.Done():
						}
					})
				}
				s.mu.Lock()
				s.pods, s.followed = len(candidates), len(pods)
				s.names = containerNames(pods)
				s.mu.Unlock()
				if !selected {
					s.started = time.Now()
				}
				selected = true
			}
			dirty = false
			lastGraph = time.Now()
		}
		if selected && !initialDone {
			loaded := true
			count := 0
			for _, pod := range pods {
				loaded = loaded && pod.loaded
				count += len(pod.readers)
			}
			if loaded || time.Since(s.started) >= timing.Initial {
				s.tail = int64(max(50, min(1000, 2000/max(1, count))))
				close(initial)
				initialDone = true
				initialAt = time.Now()
			}
		}
		if p.Previous && selected && initialDone {
			done := true
			for _, pod := range pods {
				done = done && pod.loaded
				for _, reader := range pod.readers {
					select {
					case <-reader.done:
					default:
						done = false
					}
				}
			}
			if done {
				return finish(protocol.StreamEndReasonComplete, nil)
			}
		}
		select {
		case <-ctx.Done():
			return finish(protocol.StreamEndReasonComplete, nil)
		case err := <-s.fatal:
			return finish(protocol.StreamEndReasonError, err)
		case <-graph:
			dirty = true
		case <-types:
			dirty = true
		case <-status:
			dirty = true
		case change := <-changes:
			pod, ok := pods[change.uid]
			if !ok {
				continue
			}
			if change.err != nil {
				if apierrors.IsForbidden(change.err) || apierrors.IsUnauthorized(change.err) {
					return finish(protocol.StreamEndReasonError, change.err)
				}
				continue
			}
			var manifest corev1.Pod
			if !change.data.Deleted {
				if err := json.Unmarshal(change.data.Object, &manifest); err != nil {
					return finish(protocol.StreamEndReasonError, err)
				}
			}
			if change.data.Deleted || string(manifest.UID) != change.uid {
				s.removePod(pod)
				delete(pods, change.uid)
				s.mu.Lock()
				s.followed = len(pods)
				s.names = containerNames(pods)
				s.mu.Unlock()
				if p.Type == "pods" {
					return finish(protocol.StreamEndReasonDeleted, nil)
				}
				dirty = true
				continue
			}
			s.updatePod(pod, &manifest, initial)
			pod.loaded = true
			s.mu.Lock()
			s.names = containerNames(pods)
			s.mu.Unlock()
		case <-tick.C:
			s.mu.Lock()
			s.statusLocked(false)
			settled := true
			for _, source := range s.sources {
				settled = settled && (source.settled || (!source.activity.IsZero() && time.Since(source.activity) >= timing.Batch))
			}
			if len(s.batch) > 0 && time.Since(s.batchAt) >= timing.Batch && (!s.first || settled || time.Since(s.started) >= timing.Initial) {
				s.flushLocked()
			}
			// Ready follows the first lines, so a client never takes a
			// container that has not been read yet for one that printed nothing.
			if initialDone && !s.ready && (!s.first || (settled && len(s.batch) == 0) || time.Since(initialAt) >= timing.Initial) {
				s.ready = true
			}
			s.mu.Unlock()
		}
	}
}

func targetReady(c Cluster, key protocol.TypeKey) (bool, error) {
	ready := c.Status().Phase == protocol.ClusterPhaseReady
	for _, key := range []protocol.TypeKey{key, "pods"} {
		typ, ok := c.Type(key)
		if !ok {
			if ready {
				return false, fmt.Errorf("resource type %s is not served", key)
			}
			continue
		}
		switch typ.State {
		case protocol.TypeStateForbidden:
			return false, &protocol.ErrorDetail{Code: protocol.ErrorCodeForbidden, Message: fmt.Sprintf("Your credentials cannot list %s", key)}
		case protocol.TypeStateFailed:
			return false, fmt.Errorf("cannot index Resource Type %s", key)
		case protocol.TypeStateSyncing:
			ready = false
		}
	}
	return ready, nil
}

func errorDetail(err error) *protocol.ErrorDetail {
	var e *protocol.ErrorDetail
	if errors.As(err, &e) {
		return e
	}
	code := protocol.ErrorCodeInternal
	if apierrors.IsForbidden(err) || apierrors.IsUnauthorized(err) {
		code = protocol.ErrorCodeForbidden
	}
	return &protocol.ErrorDetail{Code: code, Message: err.Error()}
}

func (s *stream) fail(err error) {
	select {
	case s.fatal <- err:
	default:
	}
}
func (s *stream) removePod(pod *followedPod) {
	pod.cancel()
	for _, r := range pod.readers {
		r.cancel()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.flushLocked()
	for _, r := range pod.readers {
		delete(s.sources, r.id)
	}
}

func (s *stream) statusLocked(force bool) time.Duration {
	value := emptyStatus()
	value.Ready = s.ready
	value.Pods, value.Followed = s.pods, s.followed
	value.Containers = append(value.Containers, s.names...)
	for _, source := range s.sources {
		value.Sources = append(value.Sources, source.source)
	}
	slices.SortFunc(value.Sources, func(a, b protocol.LogSource) int { return cmp.Compare(a.ID, b.ID) })
	encoded, _ := json.Marshal(value)
	if bytes.Equal(encoded, s.lastJSON) {
		return 0
	}
	if wait := s.t.Status - time.Since(s.lastStatus); !force && wait > 0 {
		return wait
	}
	s.out.Status(value)
	s.lastJSON = encoded
	s.lastStatus = time.Now()
	return 0
}

func (s *stream) add(id int, r record) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.sources[id]
	if !ok || s.ctx.Err() != nil {
		return
	}
	r.source = id
	entry.activity = time.Now()
	entry.settled = false
	if len(s.batch) == 0 {
		s.batchAt = time.Now()
	}
	s.batch = append(s.batch, r)
	s.batchBytes += protocol.LogRecordHeaderSize + len(r.content)
	if s.batchBytes >= s.t.BatchBytes {
		s.flushLocked()
	}
}

func (s *stream) flushLocked() {
	if len(s.batch) == 0 {
		return
	}
	// Readers publish their source before opening a request.
	s.statusLocked(false)
	frame := []byte{protocol.StreamChannelStdout}
	count := 0
	for _, r := range merge(s.batch) {
		size := protocol.LogRecordHeaderSize + len(r.content)
		if count > 0 && len(frame)+size > s.t.FrameBytes {
			s.out.Frame(frame, count)
			frame = []byte{protocol.StreamChannelStdout}
			count = 0
		}
		frame = appendRecord(frame, r)
		count++
	}
	if count > 0 {
		s.out.Frame(frame, count)
	}
	s.batch = nil
	s.batchBytes = 0
	s.first = false
}

func containerNames(pods map[string]*followedPod) []protocol.LogContainer {
	rank := func(k protocol.LogContainerKind) int {
		switch k {
		case protocol.LogContainerKindContainer:
			return 0
		case protocol.LogContainerKindInit:
			return 1
		default:
			return 2
		}
	}
	seen := map[string]protocol.LogContainer{}
	for _, pod := range pods {
		for _, name := range pod.names {
			old, exists := seen[name.Name]
			if !exists || rank(name.Kind) < rank(old.Kind) {
				seen[name.Name] = name
			}
		}
	}
	names := make([]protocol.LogContainer, 0, len(seen))
	for _, name := range seen {
		names = append(names, name)
	}
	slices.SortFunc(names, func(a, b protocol.LogContainer) int {
		return cmp.Or(cmp.Compare(rank(a.Kind), rank(b.Kind)), cmp.Compare(a.Name, b.Name))
	})
	return names
}
