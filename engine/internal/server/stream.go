package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/jimeh/hukube/engine/internal/execsession"
	"github.com/jimeh/hukube/engine/internal/protocol"
)

type streamLimits struct {
	queue, window, texts int
	open, write, drain   time.Duration
	// stall and stallFloor bound how long streamQueue.write holds its caller.
	stall      time.Duration
	stallFloor uint64
}

// streamWriteFrame is the most a frame made by streamQueue.write holds.
const streamWriteFrame = 32 << 10

var defaultStreamLimits = streamLimits{4 << 20, 1 << 20, 1024, 10 * time.Second, 10 * time.Second, 10 * time.Second, 30 * time.Second, 4 << 20}

type streamOutput[E any] struct {
	frame func([]byte, int)
	event func(E)
}

type streamHandler func(context.Context, *Server, json.RawMessage, *streamQueue) protocol.StreamEnd

var streamInputs = map[protocol.Method]bool{}

var streams = map[protocol.Method]streamHandler{}

func handleStream[P, E any](method protocol.Stream[P, E], handler func(context.Context, *Server, P, streamOutput[E]) protocol.StreamEnd) {
	if _, exists := streams[method.Name]; exists {
		panic("server: duplicate stream handler " + method.Name)
	}
	streams[method.Name] = func(ctx context.Context, srv *Server, raw json.RawMessage, q *streamQueue) protocol.StreamEnd {
		p, err := decode[P](raw)
		if err != nil {
			return streamError(err)
		}
		return handler(ctx, srv, p, streamOutput[E]{frame: q.frame, event: func(e E) {
			q.text(protocol.StreamServerMessage{Type: protocol.StreamServerTypeEvent, Event: e})
		}})
	}
}

func streamError(err error) protocol.StreamEnd {
	return protocol.StreamEnd{Reason: protocol.StreamEndReasonError, Error: toProtocolError(err)}
}

type streamItem struct {
	data    []byte
	records int
	msg     protocol.StreamServerMessage
}

type streamQueue struct {
	mu                 sync.Mutex
	items              []streamItem
	bytes, texts       int
	sent, acked        uint64
	lastAck            time.Time
	finished, overflow bool
	limits             streamLimits
	wake               chan struct{}
	changed            chan struct{}
	// waitingSince is when output began to wait for room in the window. It
	// is zero while writes find room at once. waiting counts the writes
	// waiting now.
	waitingSince time.Time
	waiting      int
	// taken holds what the client acknowledged in each of the last slices of
	// the stall period, and takenIn the slice each entry is for.
	taken   [stallSlices]uint64
	takenIn [stallSlices]int64
	input   *execsession.Input
	sizes   *execsession.Sizes
}

func newStreamQueue(limits streamLimits) *streamQueue {
	return &streamQueue{limits: limits, wake: make(chan struct{}, 1), changed: make(chan struct{}), lastAck: time.Now()}
}

func (q *streamQueue) signal() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *streamQueue) text(msg protocol.StreamServerMessage) {
	q.mu.Lock()
	q.items = append(q.items, streamItem{msg: msg})
	q.texts++
	q.overflow = q.overflow || q.texts > q.limits.texts
	q.mu.Unlock()
	q.signal()
}

// acknowledgeInput reports the total input passed on. Only the latest total
// matters, so one that is still queued is replaced, and a client that holds
// output back cannot grow the queue by typing.
func (q *streamQueue) acknowledgeInput(total uint64) {
	q.mu.Lock()
	if n := len(q.items); n > 0 && q.items[n-1].msg.Type == protocol.StreamServerTypeAck {
		q.items[n-1].msg.Bytes = total
		q.mu.Unlock()
		return
	}
	q.mu.Unlock()
	q.text(protocol.StreamServerMessage{Type: protocol.StreamServerTypeAck, Bytes: total})
}

func (q *streamQueue) frame(data []byte, records int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.finished || q.overflow {
		return
	}
	// A producer may reuse its buffer as soon as this call returns.
	q.items = append(q.items, streamItem{data: append([]byte(nil), data...), records: records})
	q.bytes += len(data)
	q.drop(q.limits.queue)
	q.signal()
}

// stallSlices is how finely streamQueue tracks what the client took lately.
const stallSlices = 6

// write queues output for a stream that must not lose it, and waits for room
// in the window while the client keeps up. A client keeps up when output has
// waited for less than the stall period, or when it took at least the stall
// floor during the last one. For a client that does not, write does not wait:
// it queues the output and drops the oldest, leaving a gap.
//
// This bounds how long an Exec Session's producer is held. client-go reads
// its heartbeat on the goroutine that writes output, and ends a session that
// has read none for a minute.
func (q *streamQueue) write(ctx context.Context, data []byte) (int, error) {
	written := 0
	for len(data) > 0 {
		n := min(len(data), streamWriteFrame, q.limits.window-1)
		if n <= 0 {
			return written, io.ErrShortWrite
		}
		frame := append([]byte{protocol.StreamChannelStdout}, data[:n]...)
		q.mu.Lock()
		shed, waited := false, false
		for q.bytes+int(q.sent-q.acked)+len(frame) > q.limits.window && !q.finished && !q.overflow {
			now := time.Now()
			if q.waitingSince.IsZero() {
				q.waitingSince = now
			}
			grace := q.limits.stall - now.Sub(q.waitingSince)
			if grace <= 0 && q.takenLately(now) < q.limits.stallFloor {
				shed = true
				break
			}
			waited = true
			// The answer can change when the grace ends, and whenever a slice
			// of the last stall period falls out of it.
			wait := max(q.limits.stall/stallSlices, time.Millisecond)
			if grace > 0 {
				wait = min(wait, grace)
			}
			changed := q.changed
			q.waiting++
			q.mu.Unlock()
			timer := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				timer.Stop()
				q.mu.Lock()
				q.waiting--
				q.mu.Unlock()
				return written, ctx.Err()
			case <-changed:
				timer.Stop()
			case <-timer.C:
			}
			q.mu.Lock()
			q.waiting--
		}
		if q.finished || q.overflow || ctx.Err() != nil {
			q.mu.Unlock()
			if ctx.Err() == nil {
				<-ctx.Done()
			}
			return written, io.ErrClosedPipe
		}
		// Output stops waiting when a write finds room at once.
		if !shed && !waited {
			q.waitingSince = time.Time{}
		}
		q.items = append(q.items, streamItem{data: frame})
		q.bytes += len(frame)
		if shed {
			q.drop(q.limits.window)
		}
		q.mu.Unlock()
		q.signal()
		written += n
		data = data[n:]
	}
	return written, nil
}

// slice numbers the slice of the stall period that now falls in. q.mu is held
// by the caller of this and the two methods below.
func (q *streamQueue) slice(now time.Time) int64 {
	return now.UnixNano() / int64(max(q.limits.stall/stallSlices, time.Nanosecond))
}

// took records that the client acknowledged n bytes.
func (q *streamQueue) took(now time.Time, n uint64) {
	slice := q.slice(now)
	at := slice % stallSlices
	if q.takenIn[at] != slice {
		q.takenIn[at], q.taken[at] = slice, 0
	}
	q.taken[at] += n
}

// takenLately is what the client acknowledged in about the last stall period.
func (q *streamQueue) takenLately(now time.Time) uint64 {
	slice, total := q.slice(now), uint64(0)
	for at, in := range q.takenIn {
		if in > slice-stallSlices {
			total += q.taken[at]
		}
	}
	return total
}

// drop replaces the oldest data with a gap at its position, preserving text.
// q.mu is held by the caller.
func (q *streamQueue) drop(bound int) {
	gapAt := -1
	for i := 0; q.bytes > bound && i < len(q.items); {
		item := q.items[i]
		if item.msg.Gap != nil && gapAt < 0 {
			gapAt = i
		}
		if item.data == nil {
			i++
			continue
		}
		q.bytes -= len(item.data)
		if gapAt < 0 {
			q.items[i] = streamItem{msg: protocol.StreamServerMessage{Type: protocol.StreamServerTypeGap, Gap: &protocol.StreamGap{}}}
			q.texts++
			gapAt = i
			i++
		} else {
			copy(q.items[i:], q.items[i+1:])
			q.items[len(q.items)-1] = streamItem{}
			q.items = q.items[:len(q.items)-1]
		}
		q.items[gapAt].msg.Gap.Bytes += uint64(len(item.data))
		q.items[gapAt].msg.Gap.Records += uint64(item.records)
	}
	q.overflow = q.overflow || q.texts > q.limits.texts
}

func (q *streamQueue) acknowledge(n uint64) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if n < q.acked || n > q.sent {
		return false
	}
	if n > q.acked {
		now := time.Now()
		q.took(now, n-q.acked)
		q.acked, q.lastAck = n, now
		close(q.changed)
		q.changed = make(chan struct{})
	}
	q.signal()
	return true
}

func (q *streamQueue) end(end protocol.StreamEnd) {
	q.mu.Lock()
	if q.finished {
		q.mu.Unlock()
		return
	}
	q.finished = true
	close(q.changed)
	q.changed = make(chan struct{})
	q.lastAck = time.Now()
	q.items = append(q.items, streamItem{msg: protocol.StreamServerMessage{Type: protocol.StreamServerTypeEnd, End: &end}})
	q.texts++
	q.overflow = q.overflow || q.texts > q.limits.texts
	q.mu.Unlock()
	q.signal()
}

// next reserves the next frame before writing, so an acknowledgement racing
// the write can never appear to acknowledge unsent bytes.
func (q *streamQueue) next() (streamItem, bool, bool, time.Duration) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.overflow {
		return streamItem{}, false, true, 0
	}
	if len(q.items) == 0 {
		return streamItem{}, false, false, 0
	}
	item := q.items[0]
	// A gap keeps the flow-control position of the data it replaced, so
	// a stalled client receives one coalesced gap when it resumes.
	if (item.data != nil || item.msg.Gap != nil) && q.sent-q.acked >= uint64(q.limits.window) {
		if !q.finished {
			return streamItem{}, false, false, 0
		}
		wait := q.limits.drain - time.Since(q.lastAck)
		if wait > 0 {
			return streamItem{}, false, false, wait
		}
		q.drop(0)
		item = q.items[0]
	}
	q.items[0] = streamItem{}
	q.items = q.items[1:]
	if item.data != nil {
		q.bytes -= len(item.data)
		q.sent += uint64(len(item.data))
	} else {
		q.texts--
	}
	return item, true, false, 0
}

func (s *Server) serveStream(w http.ResponseWriter, r *http.Request) {
	if !s.originAllowed(r) {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	if !s.tokenValid(r) {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{protocol.StreamSubprotocol}, InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer func() { _ = conn.CloseNow() }()
	if conn.Subprotocol() != protocol.StreamSubprotocol {
		conn.Close(websocket.StatusPolicyViolation, "client must offer "+protocol.StreamSubprotocol)
		return
	}
	s.runStream(r.Context(), conn, defaultStreamLimits)
}

func (s *Server) runStream(ctx context.Context, conn *websocket.Conn, limits streamLimits) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	conn.SetReadLimit(streamReadLimit)
	wctx, stop := context.WithTimeout(ctx, limits.write)
	err := wsjson.Write(wctx, conn, protocol.StreamServerMessage{Type: protocol.StreamServerTypeHello, Hello: &protocol.Hello{Protocol: protocol.Hash}})
	stop()
	if err != nil {
		return
	}
	openCtx, stop := context.WithTimeout(ctx, limits.open)
	var open protocol.StreamClientMessage
	err = wsjson.Read(openCtx, conn, &open)
	stop()
	if err != nil {
		return
	}
	producerCtx, stopProducer := context.WithCancel(ctx)
	defer stopProducer()
	q := newStreamQueue(limits)
	if streamInputs[open.Method] {
		q.input = execsession.NewInput(q.acknowledgeInput)
		q.sizes = execsession.NewSizes()
		defer s.trackExecSocket()()
	}
	if open.Type != protocol.StreamClientTypeOpen {
		q.end(streamError(badRequest(fmt.Errorf("first message must be open"))))
	} else if handler, ok := streams[open.Method]; !ok {
		q.end(streamError(badRequest(fmt.Errorf("unknown stream %q", open.Method))))
	} else {
		go func() { q.end(handler(producerCtx, s, open.Params, q)) }()
	}
	go func() {
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				cancel()
				return
			}
			valid := false
			if typ == websocket.MessageBinary {
				valid = q.input != nil && len(data) > 1 && data[0] == protocol.StreamChannelStdin && q.input.Write(data[1:])
			} else {
				var msg protocol.StreamClientMessage
				if json.Unmarshal(data, &msg) == nil {
					switch msg.Type {
					case protocol.StreamClientTypeAck:
						valid = q.acknowledge(msg.Bytes)
					case protocol.StreamClientTypeResize:
						if q.sizes != nil && msg.Cols > 0 && msg.Rows > 0 {
							q.sizes.Resize(msg.Cols, msg.Rows)
							valid = true
						}
					}
				}
			}
			if !valid {
				q.end(streamError(badRequest(fmt.Errorf("invalid stream input"))))
				stopProducer()
				// Keep the writer alive long enough to deliver the refusal.
				return
			}
		}
	}()
	for {
		item, ready, overflow, wait := q.next()
		if overflow {
			return
		}
		if !ready {
			var timer *time.Timer
			var tick <-chan time.Time
			if wait > 0 {
				timer = time.NewTimer(wait)
				tick = timer.C
			}
			select {
			case <-ctx.Done():
				if timer != nil {
					timer.Stop()
				}
				return
			case <-q.wake:
			case <-tick:
			}
			if timer != nil {
				timer.Stop()
			}
			continue
		}
		wctx, stop := context.WithTimeout(ctx, limits.write)
		if item.data != nil {
			err = conn.Write(wctx, websocket.MessageBinary, item.data)
		} else {
			err = wsjson.Write(wctx, conn, item.msg)
		}
		stop()
		if err != nil {
			return
		}
		if item.msg.End != nil {
			conn.Close(websocket.StatusNormalClosure, "stream ended")
			return
		}
	}
}
