package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/jimeh/hukube/engine/internal/cluster"
	"github.com/jimeh/hukube/engine/internal/protocol"
	"github.com/jimeh/hukube/engine/internal/settings"
	"github.com/jimeh/hukube/engine/internal/testenv"
)

const (
	testToken   = "s3cret"
	waitTimeout = 30 * time.Second
)

var cfg *rest.Config

func TestMain(m *testing.M) {
	minEmitInterval = 10 * time.Millisecond
	os.Exit(testenv.Run(m, &cfg))
}

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	store, err := settings.Open("")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.DiscardHandler)
	source := testenv.Source{Config: cfg}
	srv := New(Config{
		Token:          testToken,
		AllowedOrigins: []string{"hukube://app"},
		Source:         source,
		Clusters:       cluster.NewManager(ctx, source, log),
		Settings:       store,
		Log:            log,
	})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func wsURL(ts *httptest.Server) string { return "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws" }

type client struct {
	t    *testing.T
	conn *websocket.Conn
}

// dial connects to the control socket, returning the HTTP status of a
// rejected handshake alongside the error.
func dial(t *testing.T, ts *httptest.Server, subprotocols []string, origin string) (*client, int, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
	defer cancel()
	header := http.Header{}
	if origin != "" {
		header.Set("Origin", origin)
	}
	conn, resp, err := websocket.Dial(ctx, wsURL(ts), &websocket.DialOptions{Subprotocols: subprotocols, HTTPHeader: header})
	status := 0
	if resp != nil {
		status = resp.StatusCode
		if resp.Body != nil {
			_ = resp.Body.Close()
		}
	}
	if err != nil {
		return nil, status, err
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	return &client{t: t, conn: conn}, status, nil
}

func mustDial(t *testing.T, ts *httptest.Server) *client {
	t.Helper()
	c, _, err := dial(t, ts, []string{protocol.Subprotocol, protocol.TokenSubprotocolPrefix + testToken}, "")
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func (c *client) send(msg protocol.ClientMessage) {
	c.t.Helper()
	if err := wsjson.Write(context.Background(), c.conn, msg); err != nil {
		c.t.Fatal(err)
	}
}

// await reads messages until one for id satisfies match, failing with the
// last message seen for id if none does in time.
func (c *client) await(id uint64, match func(protocol.ServerMessage, json.RawMessage) bool) json.RawMessage {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
	defer cancel()
	var last string
	for {
		var msg struct {
			protocol.ServerMessage
			Data json.RawMessage `json:"data"`
		}
		if err := wsjson.Read(ctx, c.conn, &msg); err != nil {
			c.t.Fatalf("no matching message for id %d: %v; last seen: %s", id, err, last)
		}
		if msg.ID != id {
			continue
		}
		last = fmt.Sprintf("%+v data=%s", msg.ServerMessage, msg.Data)
		if match(msg.ServerMessage, msg.Data) {
			return msg.Data
		}
	}
}

func params(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func TestControlSocketRejectsUnauthenticatedClients(t *testing.T) {
	ts := newTestServer(t)
	tests := []struct {
		name         string
		subprotocols []string
		origin       string
		wantStatus   int
	}{
		{"missing token", []string{protocol.Subprotocol}, "", http.StatusUnauthorized},
		{"wrong token", []string{protocol.Subprotocol, protocol.TokenSubprotocolPrefix + "nope"}, "", http.StatusUnauthorized},
		{"foreign origin", []string{protocol.Subprotocol, protocol.TokenSubprotocolPrefix + testToken}, "http://evil.example", http.StatusForbidden},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, status, err := dial(t, ts, tt.subprotocols, tt.origin)
			if err == nil {
				t.Fatal("dial succeeded, want rejection")
			}
			if status != tt.wantStatus {
				t.Fatalf("status = %d, want %d", status, tt.wantStatus)
			}
		})
	}

	t.Run("allowed origins", func(t *testing.T) {
		for _, origin := range []string{"hukube://app", ts.URL} {
			if _, _, err := dial(t, ts, []string{protocol.Subprotocol, protocol.TokenSubprotocolPrefix + testToken}, origin); err != nil {
				t.Errorf("origin %q rejected: %v", origin, err)
			}
		}
	})
}

func TestUnknownMethodsReturnBadRequest(t *testing.T) {
	c := mustDial(t, newTestServer(t))
	c.send(protocol.ClientMessage{ID: 1, Type: protocol.ClientTypeRequest, Method: "nope"})
	c.send(protocol.ClientMessage{ID: 2, Type: protocol.ClientTypeSubscribe, Method: "nope"})
	for _, id := range []uint64{1, 2} {
		c.await(id, func(m protocol.ServerMessage, _ json.RawMessage) bool {
			return m.Type == protocol.ServerTypeError && m.Error.Code == protocol.ErrorCodeBadRequest
		})
	}
}

// Settings written by one client reach every client watching them, which is
// how windows share Workspace state (ADR-0009).
func TestSettingsAreSharedAcrossClients(t *testing.T) {
	ts := newTestServer(t)
	watcher, writer := mustDial(t, ts), mustDial(t, ts)

	watcher.send(protocol.ClientMessage{ID: 1, Type: protocol.ClientTypeSubscribe, Method: protocol.MethodSettingsWatch,
		Params: params(protocol.SettingKey{Key: "workspace/a"})})
	watcher.await(1, func(m protocol.ServerMessage, data json.RawMessage) bool {
		var s protocol.Setting
		_ = json.Unmarshal(data, &s)
		return m.Type == protocol.ServerTypeData && string(s.Value) == "null"
	})

	writer.send(protocol.ClientMessage{ID: 7, Type: protocol.ClientTypeRequest, Method: protocol.MethodSettingsPut,
		Params: params(protocol.Setting{Key: "workspace/a", Value: json.RawMessage(`{"panes":2}`)})})
	writer.await(7, func(m protocol.ServerMessage, _ json.RawMessage) bool { return m.Type == protocol.ServerTypeResult })

	watcher.await(1, func(m protocol.ServerMessage, data json.RawMessage) bool {
		var s protocol.Setting
		_ = json.Unmarshal(data, &s)
		return m.Type == protocol.ServerTypeData && string(s.Value) == `{"panes":2}`
	})
}

func TestQuerySubscriptionFollowsTheCluster(t *testing.T) {
	c := mustDial(t, newTestServer(t))
	cs := kubernetes.NewForConfigOrDie(cfg)
	ctx := context.Background()
	ns, err := cs.CoreV1().Namespaces().Create(ctx,
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{GenerateName: "query-"}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}

	query := protocol.QueryParams{
		Cluster: testenv.ClusterID,
		Where: &protocol.Expr{Op: protocol.ExprOpAnd, Args: []protocol.Expr{
			{Op: protocol.ExprOpIn, Field: protocol.FieldType, Values: []string{"configmaps"}},
			{Op: protocol.ExprOpIn, Field: protocol.FieldNamespace, Values: []string{ns.Name}},
		}},
		Limit: 1,
	}
	c.send(protocol.ClientMessage{ID: 3, Type: protocol.ClientTypeSubscribe, Method: protocol.MethodResourcesQuery, Params: params(query)})

	result := func(data json.RawMessage) protocol.QueryResult {
		var r protocol.QueryResult
		_ = json.Unmarshal(data, &r)
		return r
	}
	c.await(3, func(m protocol.ServerMessage, _ json.RawMessage) bool { return m.Type == protocol.ServerTypeData })

	for _, name := range []string{"alpha", "beta"} {
		_, err := cs.CoreV1().ConfigMaps(ns.Name).Create(ctx,
			&corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: name}}, metav1.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
	}
	c.await(3, func(_ protocol.ServerMessage, data json.RawMessage) bool {
		r := result(data)
		return r.Total == 2 && len(r.Rows) == 1 && r.Rows[0].Name == "alpha"
	})

	// Scrolling the window updates the subscription in place.
	query.Offset = 1
	c.send(protocol.ClientMessage{ID: 3, Type: protocol.ClientTypeUpdate, Params: params(query)})
	c.await(3, func(_ protocol.ServerMessage, data json.RawMessage) bool {
		r := result(data)
		return r.Offset == 1 && len(r.Rows) == 1 && r.Rows[0].Name == "beta"
	})
}

func TestOutboxKeepsOnlyLatestSubscriptionData(t *testing.T) {
	o := newOutbox()
	o.push(protocol.ServerMessage{ID: 1, Type: protocol.ServerTypeResult})
	o.latest(protocol.ServerMessage{ID: 5, Type: protocol.ServerTypeData, Data: "stale"})
	o.latest(protocol.ServerMessage{ID: 6, Type: protocol.ServerTypeData, Data: "other"})
	o.latest(protocol.ServerMessage{ID: 5, Type: protocol.ServerTypeData, Data: "fresh"})
	o.push(protocol.ServerMessage{ID: 2, Type: protocol.ServerTypeResult})
	o.latest(protocol.ServerMessage{ID: 9, Type: protocol.ServerTypeData, Data: "dropped"})
	o.drop(9)

	var got []string
	for _, m := range o.take() {
		got = append(got, fmt.Sprintf("%d:%v", m.ID, m.Data))
	}
	want := "1:<nil> 2:<nil> 5:fresh 6:other"
	if strings.Join(got, " ") != want {
		t.Errorf("take() = %v, want %s", got, want)
	}
	if rest := o.take(); len(rest) != 0 {
		t.Errorf("second take() = %v, want empty", rest)
	}
}
