package server

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"testing"
)

// scriptedTopic is a topic whose computed values a test supplies one at a
// time. A compute call blocks until it is given a value, so a test that has
// seen the next compute start knows the previous emit has finished.
type scriptedTopic struct {
	ctx context.Context
	// failNext, when set, makes the next start fail with it.
	failNext error
	starts   chan func()
	entered  chan struct{}
	values   chan scripted
}

type scripted struct {
	v   any
	err error
}

func newScriptedTopic(ctx context.Context) *scriptedTopic {
	return &scriptedTopic{
		ctx:     ctx,
		starts:  make(chan func(), 4),
		entered: make(chan struct{}),
		values:  make(chan scripted),
	}
}

func (st *scriptedTopic) start(_ context.Context, _ *Server, _ json.RawMessage, notify func()) (*liveValue, error) {
	if err := st.failNext; err != nil {
		st.failNext = nil
		return nil, err
	}
	st.starts <- notify
	return &liveValue{
		compute: func() (any, error) {
			select {
			case st.entered <- struct{}{}:
			case <-st.ctx.Done():
				return nil, nil
			}
			select {
			case s := <-st.values:
				return s.v, s.err
			case <-st.ctx.Done():
				return nil, nil
			}
		},
		stop: func() {},
	}, nil
}

// subscriptionHarness runs one subscription against a scripted topic.
type subscriptionHarness struct {
	t      *testing.T
	sess   *session
	sub    *subscription
	topic  *scriptedTopic
	notify func()
}

func startSubscription(t *testing.T) *subscriptionHarness {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	h := &subscriptionHarness{
		t:     t,
		sess:  &session{out: newOutbox()},
		sub:   &subscription{cancel: cancel, params: make(chan json.RawMessage, 1)},
		topic: newScriptedTopic(ctx),
	}
	h.sub.params <- json.RawMessage(`{}`)
	go h.sess.runSubscription(ctx, 1, h.topic.start, h.sub)
	h.notify = <-h.topic.starts
	<-h.topic.entered
	return h
}

// compute answers the compute call in progress, then waits for the next one
// to start, by which point the answered value has been emitted or skipped.
func (h *subscriptionHarness) compute(v any, err error) {
	h.topic.values <- scripted{v: v, err: err}
	h.notify()
	<-h.topic.entered
}

// restart answers the compute call in progress, then updates the params and
// waits for the restarted topic's first compute call.
func (h *subscriptionHarness) restart(v any) {
	h.topic.values <- scripted{v: v}
	h.sub.params <- json.RawMessage(`{"restarted":true}`)
	h.notify = <-h.topic.starts
	<-h.topic.entered
}

// sent drains the outbox, describing each message as "data:<json>", with the
// data encoded as the write loop would, or "error:<message>".
func (h *subscriptionHarness) sent() []string {
	got := []string{}
	for _, m := range h.sess.out.take() {
		if m.Error != nil {
			got = append(got, "error:"+m.Error.Message)
			continue
		}
		data, err := json.Marshal(m.Data)
		if err != nil {
			h.t.Fatal(err)
		}
		got = append(got, "data:"+string(data))
	}
	return got
}

func (h *subscriptionHarness) expect(step string, want ...string) {
	h.t.Helper()
	if want == nil {
		want = []string{}
	}
	if got := h.sent(); !slices.Equal(got, want) {
		h.t.Errorf("%s: sent %q, want %q", step, got, want)
	}
}

func TestSubscriptionSkipsIdenticalData(t *testing.T) {
	h := startSubscription(t)
	h.compute("A", nil)
	h.expect("first value", `data:"A"`)
	h.compute("A", nil)
	h.expect("identical value")
	h.compute("B", nil)
	h.expect("changed value", `data:"B"`)
}

// The client keeps showing an error until data arrives, so data equal to the
// value from before the error must be sent again.
func TestSubscriptionResendsDataAfterError(t *testing.T) {
	h := startSubscription(t)
	h.compute("A", nil)
	h.expect("first value", `data:"A"`)
	h.compute(nil, errors.New("watch failed"))
	h.expect("error", "error:watch failed")
	h.compute("A", nil)
	h.expect("value after error", `data:"A"`)
}

// The client learns the result of an update from the first value after it,
// even when that value has not changed.
func TestSubscriptionSendsFirstValueAfterRestart(t *testing.T) {
	h := startSubscription(t)
	h.compute("A", nil)
	h.expect("first value", `data:"A"`)
	h.restart("A")
	h.expect("identical value before restart")
	h.compute("A", nil)
	h.expect("first value after restart", `data:"A"`)
}

// A client too slow to drain the outbox only sees the latest pending value,
// so skipping must compare with the last value queued, not one it never got.
func TestSubscriptionDeliversLatestValueToStalledClient(t *testing.T) {
	h := startSubscription(t)
	h.compute("A", nil)
	h.compute("B", nil)
	h.compute("A", nil)
	h.expect("after A, B, A", `data:"A"`)
}

// A topic that fails to start reports an error, and the client then needs
// the first value of the next start even if it equals the last one sent.
func TestSubscriptionRecoversFromFailedStart(t *testing.T) {
	h := startSubscription(t)
	h.compute("A", nil)
	h.expect("first value", `data:"A"`)

	h.topic.failNext = errors.New("cluster unknown")
	h.topic.values <- scripted{v: "A"}
	h.sub.params <- json.RawMessage(`{"fail":true}`)
	h.sub.params <- json.RawMessage(`{"fail":false}`)
	h.notify = <-h.topic.starts
	<-h.topic.entered
	h.expect("failed start", "error:cluster unknown")
	h.compute("A", nil)
	h.expect("first value after a failed start", `data:"A"`)
}

// A value that cannot be encoded is reported as an error rather than sent.
func TestSubscriptionReportsUnencodableData(t *testing.T) {
	h := startSubscription(t)
	h.compute("A", nil)
	h.expect("first value", `data:"A"`)
	h.compute(func() {}, nil)
	h.expect("unencodable value", "error:encode data: json: unsupported type: func()")
	h.compute("A", nil)
	h.expect("value after the error", `data:"A"`)
}
