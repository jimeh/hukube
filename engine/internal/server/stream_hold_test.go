package server

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

// These tests cover streamQueue.write's one rule: it waits only while every
// byte it queued and the client has not acknowledged is younger than
// limits.hold. They run on synctest's clock, so each asserts the instant at
// which a write stops waiting.

const holdFrame = 4 // The payload of each write, which makes a 5-byte frame.

// holdQueue is a queue with a window of the given number of frames, and the
// client's side of it: what it was sent, and what it acknowledged.
type holdQueue struct {
	*streamQueue
	t        *testing.T
	received []byte
	gaps     []uint64
	written  []byte
}

func newHoldQueue(t *testing.T, frames int) *holdQueue {
	limits := defaultStreamLimits
	limits.window = frames * (holdFrame + 1)
	limits.hold = 3 * time.Second
	return &holdQueue{streamQueue: newStreamQueue(limits), t: t}
}

// held is how long a write waited, or why it failed.
type held struct {
	waited time.Duration
	err    error
}

// queue queues one frame of distinct content, and reports how long it waited.
func (q *holdQueue) queue() held {
	data := []byte(strings.Repeat(string(rune('a'+len(q.written)/holdFrame%26)), holdFrame))
	q.written = append(q.written, data...)
	started := time.Now()
	_, err := q.streamQueue.write(q.t.Context(), data)
	return held{time.Since(started), err}
}

// write queues one frame from the test's own goroutine.
func (q *holdQueue) write() time.Duration {
	q.t.Helper()
	result := q.queue()
	if result.err != nil {
		q.t.Fatal(result.err)
	}
	return result.waited
}

// writeLater starts a write that is expected to wait, and returns a channel
// that carries how it went.
func (q *holdQueue) writeLater() <-chan held {
	done := make(chan held, 1)
	go func() { done <- q.queue() }()
	synctest.Wait()
	return done
}

// send does what the socket's writer does: it sends everything the window
// allows. It returns the number of data frames sent.
func (q *holdQueue) send() int {
	frames := 0
	for {
		item, ready, _, _ := q.next()
		if !ready {
			return frames
		}
		if item.msg.Gap != nil {
			q.gaps = append(q.gaps, item.msg.Gap.Bytes)
		}
		if item.data != nil {
			q.received = append(q.received, item.data[1:]...)
			frames++
		}
	}
}

// acknowledge has the client acknowledge the given number of bytes more.
func (q *holdQueue) acknowledge(bytes int) {
	q.t.Helper()
	q.mu.Lock()
	total := q.acked + uint64(bytes)
	q.mu.Unlock()
	if !q.streamQueue.acknowledge(total) {
		q.t.Fatalf("acknowledgement of %d refused", total)
	}
}

func (q *holdQueue) acknowledgeAll() {
	q.mu.Lock()
	total := q.sent
	q.mu.Unlock()
	q.streamQueue.acknowledge(total)
}

func (q *holdQueue) outstanding() (queued, inFlight int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.bytes, int(q.sent - q.acked)
}

// fill writes and sends frames until the window is full and in flight.
func (q *holdQueue) fill() {
	q.t.Helper()
	for range q.limits.window / (holdFrame + 1) {
		if waited := q.write(); waited != 0 {
			q.t.Fatalf("a write with room waited %v", waited)
		}
		q.send()
	}
}

func expectWaiting(t *testing.T, done <-chan held) {
	t.Helper()
	synctest.Wait()
	select {
	case result := <-done:
		t.Fatalf("the write stopped waiting after %v (error: %v)", result.waited, result.err)
	default:
	}
}

func expectWaited(t *testing.T, done <-chan held, want time.Duration) {
	t.Helper()
	synctest.Wait()
	select {
	case result := <-done:
		if result.err != nil || result.waited != want {
			t.Fatalf("the write waited %v (error: %v), want %v", result.waited, result.err, want)
		}
	default:
		t.Fatalf("the write is still waiting, want it to stop after %v", want)
	}
}

// A silent client: a write waits until the oldest output it is behind is as
// old as the limit, to the instant, and later writes do not wait at all.
func TestHoldSilentClient(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := newHoldQueue(t, 2)
		q.fill()
		done := q.writeLater()
		time.Sleep(q.limits.hold - time.Nanosecond)
		expectWaiting(t, done)
		time.Sleep(time.Nanosecond)
		expectWaited(t, done, q.limits.hold)
		for range 5 {
			if waited := q.write(); waited != 0 {
				t.Fatalf("a write behind output older than the limit waited %v", waited)
			}
		}
	})
}

// Output that was sent cannot be taken back. Shedding drops queued output
// only, oldest first, and keeps one window of the newest. The client gets
// what was in flight, then one gap, then the newest output.
func TestHoldShedsQueuedOutputOnly(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := newHoldQueue(t, 2)
		q.fill()
		sent := bytes.Clone(q.received)
		time.Sleep(q.limits.hold)
		for range 20 {
			q.write()
			if q.send() != 0 {
				t.Fatal("output was sent beyond the window")
			}
			if queued, inFlight := q.outstanding(); queued > q.limits.window || inFlight != q.limits.window {
				t.Fatalf("queued=%d in flight=%d with a window of %d", queued, inFlight, q.limits.window)
			}
		}
		q.acknowledgeAll()
		q.send()
		if len(q.gaps) != 1 {
			t.Fatalf("gaps=%v, want one", q.gaps)
		}
		newest := q.received[len(sent):]
		if !bytes.Equal(q.received[:len(sent)], sent) || len(newest) == 0 || !bytes.HasSuffix(q.written, newest) {
			t.Fatalf("received %q then %q of %q", sent, newest, q.written)
		}
		// Every byte is accounted for: delivered, or counted by the gap, which
		// also counts the channel byte of each frame it replaced.
		dropped := len(q.written) - len(q.received)
		if gap := int(q.gaps[0]); gap < dropped || gap > dropped+dropped/holdFrame {
			t.Fatalf("received %d of %d bytes written, with a gap of %d", len(q.received), len(q.written), gap)
		}
	})
}

// A trickle: the client acknowledges one frame a second. Each acknowledgement
// lets one write in, and none of them renews the wait. Once the oldest
// unacknowledged output is as old as the limit, writes stop waiting, and
// start again only when that output has been acknowledged.
func TestHoldTrickleOfAcknowledgements(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := newHoldQueue(t, 4)
		q.fill()
		for range 2 {
			done := q.writeLater()
			time.Sleep(time.Second)
			expectWaiting(t, done)
			q.acknowledge(holdFrame + 1)
			expectWaited(t, done, time.Second)
			q.send()
		}
		// Two of the first four frames are still unacknowledged, two seconds old.
		done := q.writeLater()
		time.Sleep(time.Second - time.Nanosecond)
		expectWaiting(t, done)
		time.Sleep(time.Nanosecond)
		expectWaited(t, done, time.Second)
		// One more acknowledgement leaves the fourth frame, as old as the limit.
		q.acknowledge(holdFrame + 1)
		q.send()
		if waited := q.write(); waited != 0 {
			t.Fatalf("an acknowledgement renewed the wait: %v", waited)
		}
		// With the fourth acknowledged, the oldest output is one second
		// younger, and a write waits for it again.
		q.acknowledge(holdFrame + 1)
		q.send()
		for {
			if queued, inFlight := q.outstanding(); queued+inFlight+holdFrame+1 > q.limits.window {
				break
			}
			q.write()
			q.send()
		}
		done = q.writeLater()
		expectWaiting(t, done)
		time.Sleep(time.Second)
		expectWaited(t, done, time.Second)
	})
}

// Batches of small acknowledgements: one acknowledgement makes room for two
// frames, so the second write finds room at once. That does not renew the
// wait either.
func TestHoldBatchesOfAcknowledgements(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := newHoldQueue(t, 4)
		q.fill()
		done := q.writeLater()
		time.Sleep(2 * time.Second)
		q.acknowledge(2 * (holdFrame + 1))
		expectWaited(t, done, 2*time.Second)
		q.send()
		if waited := q.write(); waited != 0 {
			t.Fatalf("a write with room waited %v", waited)
		}
		q.send()
		// The window is full again, and the third and fourth frames are from
		// the start. A write waits the one second they have left.
		done = q.writeLater()
		time.Sleep(time.Second - time.Nanosecond)
		expectWaiting(t, done)
		time.Sleep(time.Nanosecond)
		expectWaited(t, done, time.Second)
	})
}

// A client that keeps up acknowledges everything it is sent ten times a
// second. Writes wait for it, and no output is dropped.
func TestHoldClientThatKeepsUp(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := newHoldQueue(t, 4)
		ctx, stop := context.WithCancel(t.Context())
		client := make(chan struct{})
		go func() {
			defer close(client)
			for ctx.Err() == nil {
				q.send()
				q.acknowledgeAll()
				time.Sleep(100 * time.Millisecond)
			}
		}()
		waited := time.Duration(0)
		for time.Duration(len(q.written)/holdFrame)*25*time.Millisecond < 10*q.limits.hold {
			waited += q.write()
		}
		stop()
		<-client
		q.send()
		if len(q.gaps) != 0 || !bytes.Equal(q.received, q.written) {
			t.Fatalf("gaps=%v, received %d of %d bytes", q.gaps, len(q.received), len(q.written))
		}
		// The client took four frames a tick, so the producer was held to its
		// pace for all but the first of them.
		if waited < 9*q.limits.hold {
			t.Fatalf("the producer waited %v in all, and was not held to the client's pace", waited)
		}
	})
}

// An idle session has nothing unacknowledged, so its age is nothing: after
// any time, a burst gets the whole limit.
func TestHoldIdleSession(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := newHoldQueue(t, 2)
		q.write()
		q.send()
		q.acknowledgeAll()
		time.Sleep(10 * q.limits.hold)
		q.fill()
		done := q.writeLater()
		time.Sleep(q.limits.hold - time.Nanosecond)
		expectWaiting(t, done)
		time.Sleep(time.Nanosecond)
		expectWaited(t, done, q.limits.hold)
	})
}
