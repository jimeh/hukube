package server

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

type transportParams struct {
	Name string `json:"name"`
}
type transportCase struct {
	run   func(context.Context, streamOutput[string]) protocol.StreamEnd
	queue chan *streamQueue
}

var transportCases sync.Map
var testStream = protocol.DeclareStream[transportParams, string]("test.transport")

func init() {
	handleStream(testStream, func(ctx context.Context, _ *Server, p transportParams, out streamOutput[string]) protocol.StreamEnd {
		v, _ := transportCases.Load(p.Name)
		return v.(*transportCase).run(ctx, out)
	})
	base := streams[testStream.Name]
	streams[testStream.Name] = func(ctx context.Context, srv *Server, raw json.RawMessage, q *streamQueue) protocol.StreamEnd {
		p, err := decode[transportParams](raw)
		if err == nil {
			if v, ok := transportCases.Load(p.Name); ok {
				v.(*transportCase).queue <- q
			}
		}
		return base(ctx, srv, raw, q)
	}
}

type streamClient struct {
	t        *testing.T
	conn     *websocket.Conn
	consumed uint64
}

func dialStream(t *testing.T, ts *httptest.Server) *streamClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, wsURL(ts)+"/stream", &websocket.DialOptions{Subprotocols: []string{protocol.StreamSubprotocol, protocol.TokenSubprotocolPrefix + testToken}})
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	conn.SetReadLimit(4 << 20)
	t.Cleanup(func() { _ = conn.CloseNow() })
	c := &streamClient{t: t, conn: conn}
	m, _ := c.read(false)
	if m.Type != protocol.StreamServerTypeHello || m.Hello == nil || m.Hello.Protocol != protocol.Hash {
		t.Fatalf("first message = %+v, want hello with protocol hash", m)
	}
	return c
}
func (c *streamClient) send(m protocol.StreamClientMessage) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
	defer cancel()
	if err := wsjson.Write(ctx, c.conn, m); err != nil {
		c.t.Fatal(err)
	}
}
func (c *streamClient) read(ack bool) (protocol.StreamServerMessage, []byte) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
	defer cancel()
	typ, data, err := c.conn.Read(ctx)
	if err != nil {
		c.t.Fatal(err)
	}
	if typ == websocket.MessageBinary {
		c.consumed += uint64(len(data))
		if ack {
			c.send(protocol.StreamClientMessage{Type: protocol.StreamClientTypeAck, Bytes: c.consumed})
		}
		return protocol.StreamServerMessage{}, data
	}
	var m protocol.StreamServerMessage
	if err := json.Unmarshal(data, &m); err != nil {
		c.t.Fatal(err)
	}
	return m, nil
}
func transport(t *testing.T, run func(context.Context, streamOutput[string]) protocol.StreamEnd) (*streamClient, <-chan *streamQueue) {
	t.Helper()
	entry := &transportCase{run: run, queue: make(chan *streamQueue, 1)}
	transportCases.Store(t.Name(), entry)
	t.Cleanup(func() { transportCases.Delete(t.Name()) })
	c := dialStream(t, newTestServer(t))
	c.send(protocol.StreamClientMessage{Type: protocol.StreamClientTypeOpen, Method: testStream.Name, Params: params(transportParams{Name: t.Name()})})
	return c, entry.queue
}
func complete() protocol.StreamEnd {
	return protocol.StreamEnd{Reason: protocol.StreamEndReasonComplete}
}
func awaitSignal(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(waitTimeout):
		t.Fatal("operation did not reach its completion boundary")
	}
}

func TestStreamAuthentication(t *testing.T) {
	ts := newTestServer(t)
	for _, tt := range []struct {
		name, origin, token, subprotocol, host string
		status                                 int
	}{
		{"token", "", "wrong", protocol.StreamSubprotocol, "", 401},
		{"origin", "http://evil.example", testToken, protocol.StreamSubprotocol, "", 403},
		{"host", "http://evil.example", testToken, protocol.StreamSubprotocol, "evil.example", 403},
		{"subprotocol", "", testToken, protocol.Subprotocol, "", 101},
	} {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
			defer cancel()
			header := http.Header{}
			if tt.origin != "" {
				header.Set("Origin", tt.origin)
			}
			options := &websocket.DialOptions{Subprotocols: []string{tt.subprotocol, protocol.TokenSubprotocolPrefix + tt.token}, HTTPHeader: header}
			if tt.host != "" {
				options.HTTPClient = &http.Client{Transport: hostTransport{tt.host}}
			}
			conn, resp, err := websocket.Dial(ctx, wsURL(ts)+"/stream", options)
			if resp != nil && resp.Body != nil {
				defer resp.Body.Close()
			}
			if tt.status == 101 {
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = conn.CloseNow() }()
				_, _, err = conn.Read(ctx)
				if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
					t.Fatalf("wrong subprotocol close = %v, want policy violation", err)
				}
			} else if err == nil || resp == nil || resp.StatusCode != tt.status {
				if conn != nil {
					_ = conn.CloseNow()
				}
				t.Fatalf("handshake = %v, response %+v, want refusal %d", err, resp, tt.status)
			}
		})
	}
	c := dialStream(t, ts)
	c.send(protocol.StreamClientMessage{Type: protocol.StreamClientTypeOpen, Method: "unknown"})
	m, _ := c.read(false)
	if m.End == nil {
		t.Fatalf("after hello = %+v", m)
	}
}

type hostTransport struct{ host string }

func (h hostTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Host = h.host
	return http.DefaultTransport.RoundTrip(r)
}

func TestStreamBadOpen(t *testing.T) {
	for _, msg := range []protocol.StreamClientMessage{
		{Type: protocol.StreamClientTypeOpen, Method: "unknown"},
		{Type: protocol.StreamClientTypeOpen, Method: testStream.Name, Params: json.RawMessage(`[]`)},
		{Type: protocol.StreamClientTypeAck},
	} {
		c := dialStream(t, newTestServer(t))
		c.send(msg)
		m, _ := c.read(false)
		if m.End == nil || m.End.Reason != protocol.StreamEndReasonError || m.End.Error == nil || m.End.Error.Code != protocol.ErrorCodeBadRequest {
			t.Fatalf("bad open = %+v, want end with bad_request", m)
		}
	}
	c := dialStream(t, newTestServer(t))
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, _, err := c.conn.Read(ctx)
	if err == nil || ctx.Err() != nil {
		t.Fatalf("no open did not close within open timeout: %v", err)
	}
}

func TestStreamSlowClientBound(t *testing.T) {
	produced := make(chan struct{})
	burst := make(chan struct{})
	release := make(chan struct{})
	c, queues := transport(t, func(ctx context.Context, out streamOutput[string]) protocol.StreamEnd {
		out.frame(make([]byte, 1<<20), 1)
		select {
		case <-burst:
		case <-ctx.Done():
			return complete()
		}
		for i := 0; i < 1024; i++ {
			frame := make([]byte, 64<<10)
			frame[0] = 1
			binary.BigEndian.PutUint32(frame[1:], uint32(i))
			out.frame(frame, 1)
		}
		close(produced)
		select {
		case <-release:
		case <-ctx.Done():
		}
		return complete()
	})
	c.read(false)
	close(burst)
	awaitSignal(t, produced)
	q := <-queues
	q.mu.Lock()
	queued, sent, items := q.bytes, q.sent, slices.Clone(q.items)
	q.mu.Unlock()
	if queued > 4<<20 || sent > 1<<20 {
		t.Fatalf("queue=%d sent=%d, want bounded queue and window", queued, sent)
	}
	var expected protocol.StreamGap
	for _, item := range items {
		if item.msg.Gap != nil {
			expected = *item.msg.Gap
		}
	}
	if expected.Records == 0 {
		t.Fatal("64 MiB producer did not overflow queue")
	}
	c.send(protocol.StreamClientMessage{Type: protocol.StreamClientTypeAck, Bytes: c.consumed})
	outstanding := sent
	var gap protocol.StreamGap
	previous := -1
	received := 0
	for received < 1024-int(expected.Records) {
		m, data := c.read(true)
		if m.Gap != nil {
			gap = *m.Gap
		}
		if data != nil {
			index := int(binary.BigEndian.Uint32(data[1:]))
			if index <= previous {
				t.Fatalf("newest frames out of order: %d after %d", index, previous)
			}
			previous = index
			received++
		}
	}
	if gap != expected || gap.Bytes != gap.Records*(64<<10) || previous != 1023 || outstanding > 1<<20 {
		t.Fatalf("gap=%+v want=%+v last=%d", gap, expected, previous)
	}
	close(release)
	m, _ := c.read(true)
	if m.End == nil {
		t.Fatalf("final=%+v, want end", m)
	}
}

func TestStreamWindowAndOrder(t *testing.T) {
	added := make(chan struct{})
	release := make(chan struct{})
	c, queues := transport(t, func(ctx context.Context, out streamOutput[string]) protocol.StreamEnd {
		out.event("before")
		out.frame(make([]byte, (1<<20)+1), 1)
		out.event("middle")
		out.frame([]byte{1, 2, 3}, 1)
		out.event("after")
		close(added)
		select {
		case <-release:
		case <-ctx.Done():
		}
		return complete()
	})
	awaitSignal(t, added)
	q := <-queues
	m, _ := c.read(false)
	if m.Event != "before" {
		t.Fatalf("first=%+v", m)
	}
	_, frame := c.read(false)
	if len(frame) != (1<<20)+1 {
		t.Fatalf("first frame length=%d", len(frame))
	}
	m, _ = c.read(false)
	if m.Event != "middle" {
		t.Fatalf("middle=%+v", m)
	}
	q.mu.Lock()
	sent := q.sent
	acked := q.acked
	q.mu.Unlock()
	if sent-acked != uint64(len(frame)) {
		t.Fatalf("unacknowledged=%d, want only first frame", sent-acked)
	}
	c.send(protocol.StreamClientMessage{Type: protocol.StreamClientTypeAck, Bytes: c.consumed})
	_, frame = c.read(true)
	if !slices.Equal(frame, []byte{1, 2, 3}) {
		t.Fatalf("second frame=%v", frame)
	}
	m, _ = c.read(false)
	if m.Event != "after" {
		t.Fatalf("after=%+v", m)
	}
	close(release)
	m, _ = c.read(false)
	if m.End == nil {
		t.Fatalf("end=%+v", m)
	}
}

func TestStreamEnding(t *testing.T) {
	for _, reason := range []protocol.StreamEndReason{protocol.StreamEndReasonComplete, protocol.StreamEndReasonDeleted, protocol.StreamEndReasonError} {
		t.Run(string(reason), func(t *testing.T) {
			c, _ := transport(t, func(_ context.Context, out streamOutput[string]) protocol.StreamEnd {
				out.frame([]byte{1, 42}, 1)
				end := protocol.StreamEnd{Reason: reason}
				if reason == protocol.StreamEndReasonError {
					end.Error = badRequest(fmt.Errorf("test"))
				}
				return end
			})
			_, data := c.read(true)
			if !slices.Equal(data, []byte{1, 42}) {
				t.Fatalf("data before end=%v", data)
			}
			m, _ := c.read(false)
			if m.End == nil || m.End.Reason != reason {
				t.Fatalf("end=%+v want %s", m, reason)
			}
			ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
			defer cancel()
			_, _, err := c.conn.Read(ctx)
			if websocket.CloseStatus(err) != websocket.StatusNormalClosure {
				t.Fatalf("after end=%v, want normal close", err)
			}
		})
	}
	t.Run("no acknowledgements", func(t *testing.T) {
		c, _ := transport(t, func(_ context.Context, out streamOutput[string]) protocol.StreamEnd {
			out.frame(make([]byte, 1<<20), 1)
			out.frame([]byte{1, 42}, 1)
			return complete()
		})
		c.read(false)
		m, _ := c.read(false)
		if m.Gap == nil || m.Gap.Bytes != 2 || m.Gap.Records != 1 {
			t.Fatalf("drain timeout=%+v, want gap", m)
		}
		m, _ = c.read(false)
		if m.End == nil {
			t.Fatalf("after gap=%+v", m)
		}
	})
	t.Run("cancellation", func(t *testing.T) {
		started, stopped := make(chan struct{}), make(chan struct{})
		c, _ := transport(t, func(ctx context.Context, _ streamOutput[string]) protocol.StreamEnd {
			close(started)
			<-ctx.Done()
			close(stopped)
			return complete()
		})
		awaitSignal(t, started)
		_ = c.conn.CloseNow()
		awaitSignal(t, stopped)
	})
}

func TestStreamQueueTextAndGapOrder(t *testing.T) {
	q := newStreamQueue(streamLimits{queue: 4, window: 2, texts: 5})
	q.text(protocol.StreamServerMessage{Type: protocol.StreamServerTypeEvent, Event: "before"})
	q.frame([]byte{1, 2}, 1)
	q.text(protocol.StreamServerMessage{Type: protocol.StreamServerTypeEvent, Event: "middle"})
	q.frame([]byte{3, 4}, 2)
	q.frame([]byte{5, 6}, 3)
	q.frame([]byte{7, 8}, 4)
	q.mu.Lock()
	defer q.mu.Unlock()
	var got []string
	for _, item := range q.items {
		switch {
		case item.msg.Gap != nil:
			got = append(got, fmt.Sprintf("gap:%d:%d", item.msg.Gap.Bytes, item.msg.Gap.Records))
		case item.data != nil:
			got = append(got, fmt.Sprintf("%v", item.data))
		default:
			got = append(got, item.msg.Event.(string))
		}
	}
	if strings.Join(got, " ") != "before gap:4:3 middle [5 6] [7 8]" {
		t.Fatalf("queue order=%v", got)
	}
}

func TestStreamLimits(t *testing.T) {
	q := newStreamQueue(streamLimits{queue: 8, window: 4, texts: 1})
	q.text(protocol.StreamServerMessage{})
	q.text(protocol.StreamServerMessage{})
	_, _, overflow, _ := q.next()
	if !overflow {
		t.Fatal("text limit did not force close")
	}
	q = newStreamQueue(defaultStreamLimits)
	q.frame([]byte{1}, 1)
	q.next()
	if q.acknowledge(2) {
		t.Fatal("acknowledged bytes never sent")
	}
	if !q.acknowledge(1) || q.acknowledge(0) {
		t.Fatal("cumulative acknowledgement validation failed")
	}
}
