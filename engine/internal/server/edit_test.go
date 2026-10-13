package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket/wsjson"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/jimeh/hukube/engine/internal/cluster"
	"github.com/jimeh/hukube/engine/internal/protocol"
	"github.com/jimeh/hukube/engine/internal/testenv"
)

type editTransport func(*http.Request) (*http.Response, error)

func (f editTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func newEditServer(t *testing.T, config *rest.Config, readOnly bool) *httptest.Server {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	source := testenv.Source{Config: config}
	log := slog.New(slog.DiscardHandler)
	srv := New(Config{Token: testToken, ReadOnly: readOnly, Source: source, Clusters: cluster.NewManager(ctx, source, log), Log: log})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func serverEdit(t *testing.T) protocol.ResourceEdit {
	t.Helper()
	cs := kubernetes.NewForConfigOrDie(cfg)
	ctx := context.Background()
	ns, err := cs.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{GenerateName: "edit-"}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	cm, err := cs.CoreV1().ConfigMaps(ns.Name).Create(ctx, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "web"}, Data: map[string]string{"a": "old"}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	cm.APIVersion, cm.Kind = "v1", "ConfigMap"
	base, err := json.Marshal(cm)
	if err != nil {
		t.Fatal(err)
	}
	cm.Data["a"] = "new"
	manifest, err := json.Marshal(cm)
	if err != nil {
		t.Fatal(err)
	}
	return protocol.ResourceEdit{Cluster: testenv.ClusterID, Type: "configmaps", Namespace: ns.Name, Name: cm.Name, UID: string(cm.UID), Base: base, Manifest: manifest}
}

func sendRequest(t *testing.T, c *client, id uint64, method protocol.Method, params any) {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	c.send(protocol.ClientMessage{ID: id, Type: protocol.ClientTypeRequest, Method: method, Params: raw})
}
func awaitReply(t *testing.T, c *client, id uint64) protocol.ServerMessage {
	t.Helper()
	var reply protocol.ServerMessage
	c.await(id, func(msg protocol.ServerMessage, _ json.RawMessage) bool {
		reply = msg
		return msg.Type == protocol.ServerTypeResult || msg.Type == protocol.ServerTypeError
	})
	return reply
}
func receiveChannel[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(waitTimeout):
		t.Fatal("timed out waiting for progress")
		var zero T
		return zero
	}
}

func TestReadOnlyRequests(t *testing.T) {
	// No Cluster manager is needed: the mode must refuse before resolving a Cluster.
	ts := newEditServer(t, cfg, true)
	c := mustDial(t, ts)
	for i, method := range []protocol.Method{protocol.RequestResourceApply.Name, protocol.RequestResourceDelete.Name} {
		sendRequest(t, c, uint64(i+1), method, map[string]string{"cluster": "missing"})
		reply := awaitReply(t, c, uint64(i+1))
		if reply.Error == nil || reply.Error.Code != protocol.ErrorCodeForbidden || !strings.Contains(reply.Error.Message, "read-only") {
			t.Fatalf("mutation not refused: %+v", reply)
		}
	}
	sendRequest(t, c, 3, protocol.RequestResourceAccess.Name, protocol.ResourceRef{Cluster: "missing"})
	raw := c.await(3, func(msg protocol.ServerMessage, _ json.RawMessage) bool { return msg.Type == protocol.ServerTypeResult })
	var access protocol.ResourceAccess
	if err := json.Unmarshal(raw, &access); err != nil {
		t.Fatal(err)
	}
	if access.Edit.Allowed || access.Delete.Allowed || !strings.Contains(access.Edit.Reason, "read-only") || !strings.Contains(access.Delete.Reason, "read-only") {
		t.Fatalf("read-only access = %+v", access)
	}
}

func TestRequestCancellationDuringDryRun(t *testing.T) {
	p := serverEdit(t)
	entered := make(chan context.Context, 1)
	ended := make(chan struct{}, 1)
	config := rest.CopyConfig(cfg)
	config.WrapTransport = func(next http.RoundTripper) http.RoundTripper {
		return editTransport(func(r *http.Request) (*http.Response, error) {
			if r.Method == http.MethodPatch {
				entered <- r.Context()
				<-r.Context().Done()
				ended <- struct{}{}
				return nil, r.Context().Err()
			}
			return next.RoundTrip(r)
		})
	}
	c := mustDial(t, newEditServer(t, config, false))
	sendRequest(t, c, 1, protocol.RequestResourceReview.Name, p)
	patchCtx := receiveChannel(t, entered)
	c.send(protocol.ClientMessage{ID: 999, Type: protocol.ClientTypeCancel})
	c.send(protocol.ClientMessage{ID: 1, Type: protocol.ClientTypeCancel})
	reply := awaitReply(t, c, 1)
	if reply.Error == nil || reply.Error.Code != protocol.ErrorCodeCancelled {
		t.Fatalf("cancel = %+v", reply)
	}
	receiveChannel(t, ended)
	if !errors.Is(patchCtx.Err(), context.Canceled) {
		t.Fatalf("dry run kept running: %v", patchCtx.Err())
	}
}

func TestMutationFinishesAfterCancelOrSocketClose(t *testing.T) {
	for _, method := range []protocol.Method{protocol.RequestResourceApply.Name, protocol.RequestResourceDelete.Name} {
		for _, disconnect := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/closed=%v", method, disconnect), func(t *testing.T) {
				p := serverEdit(t)
				entered := make(chan context.Context, 1)
				release := make(chan struct{})
				finished := make(chan error, 1)
				defer close(release)
				config := rest.CopyConfig(cfg)
				config.WrapTransport = func(next http.RoundTripper) http.RoundTripper {
					return editTransport(func(r *http.Request) (*http.Response, error) {
						if r.Method == http.MethodPatch || r.Method == http.MethodDelete {
							entered <- r.Context()
							select {
							case <-release:
							case <-r.Context().Done():
								return nil, r.Context().Err()
							}
						}
						return next.RoundTrip(r)
					})
				}
				// Capture the actual handler's request context and completion, so a lost
				// socket has an observable cancellation boundary before releasing the write.
				handler := requests[method]
				requestStarted := make(chan context.Context, 1)
				requests[method] = func(ctx context.Context, srv *Server, raw json.RawMessage) (any, error) {
					requestStarted <- ctx
					result, err := handler(ctx, srv, raw)
					finished <- err
					return result, err
				}
				defer func() { requests[method] = handler }()
				c := mustDial(t, newEditServer(t, config, false))
				var params any = p
				if method == protocol.RequestResourceDelete.Name {
					params = protocol.DeleteParams{Cluster: p.Cluster, Type: p.Type, Namespace: p.Namespace, Name: p.Name, UID: p.UID}
				}
				sendRequest(t, c, 1, method, params)
				requestCtx := receiveChannel(t, requestStarted)
				writeCtx := receiveChannel(t, entered)
				if disconnect {
					if err := c.conn.CloseNow(); err != nil {
						t.Fatal(err)
					}
				} else {
					c.send(protocol.ClientMessage{ID: 1, Type: protocol.ClientTypeCancel})
				}
				select {
				case <-requestCtx.Done():
				case <-time.After(waitTimeout):
					t.Fatal("request context not cancelled")
				}
				if err := writeCtx.Err(); err != nil {
					t.Fatalf("write was cancelled: %v", err)
				}
				if _, ok := writeCtx.Deadline(); !ok {
					t.Fatal("write has no timeout")
				}
				release <- struct{}{}
				if err := receiveChannel(t, finished); err != nil {
					t.Fatal("write did not finish", err)
				}
				if !disconnect {
					reply := awaitReply(t, c, 1)
					if reply.Type != protocol.ServerTypeResult {
						t.Fatalf("cancelled write reported failure: %+v", reply)
					}
				}
				cm, err := kubernetes.NewForConfigOrDie(cfg).CoreV1().ConfigMaps(p.Namespace).Get(context.Background(), p.Name, metav1.GetOptions{})
				if method == protocol.RequestResourceDelete.Name {
					if !apierrors.IsNotFound(err) {
						t.Fatalf("delete did not finish: %v", err)
					}
				} else {
					if err != nil {
						t.Fatal(err)
					}
					if cm.Data["a"] != "new" {
						t.Fatalf("write did not land: %v", cm.Data)
					}
				}
			})
		}
	}
}

func TestControlMessageJustUnderLimit(t *testing.T) {
	c := mustDial(t, newTestServer(t))
	message := protocol.ClientMessage{ID: 1, Type: protocol.ClientTypeRequest, Method: "unknown", Params: json.RawMessage(`""`)}
	raw, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	message.Params = json.RawMessage(`"` + strings.Repeat("x", protocol.MaxClientMessageBytes-len(raw)-1) + `"`)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, c.conn, message); err != nil {
		t.Fatalf("message under the control limit could not be sent: %v", err)
	}
	reply := awaitReply(t, c, 1)
	if reply.Error == nil || reply.Error.Code != protocol.ErrorCodeBadRequest {
		t.Fatalf("large message not read: %+v", reply)
	}
	sendRequest(t, c, 2, protocol.RequestClustersList.Name, protocol.None{})
	if reply := awaitReply(t, c, 2); reply.Type != protocol.ServerTypeResult {
		t.Fatalf("socket closed: %+v", reply)
	}
}

func TestProtocolErrorMapping(t *testing.T) {
	group := schema.GroupResource{Resource: "deployments", Group: "apps"}
	tests := []struct {
		name string
		err  error
		code protocol.ErrorCode
	}{
		{"forbidden", apierrors.NewForbidden(group, "web", errors.New("denied")), protocol.ErrorCodeForbidden},
		{"unauthorized", apierrors.NewUnauthorized("denied"), protocol.ErrorCodeForbidden},
		{"missing", apierrors.NewNotFound(group, "web"), protocol.ErrorCodeNotFound},
		{"conflict", apierrors.NewConflict(group, "web", errors.New("changed")), protocol.ErrorCodeConflict},
		{"invalid", apierrors.NewInvalid(schema.GroupKind{Group: "apps", Kind: "Deployment"}, "web", field.ErrorList{field.Invalid(field.NewPath("spec", "replicas"), -1, "must be nonnegative")}), protocol.ErrorCodeInvalid},
		{"bad request", apierrors.NewBadRequest("bad"), protocol.ErrorCodeInvalid},
		{"other 4xx", &apierrors.StatusError{ErrStatus: metav1.Status{Code: 405, Message: "denied", Reason: metav1.StatusReasonMethodNotAllowed}}, protocol.ErrorCodeInvalid},
		{"large", apierrors.NewRequestEntityTooLargeError("large"), protocol.ErrorCodeTooLarge},
		{"timeout", apierrors.NewTimeoutError("slow", 1), protocol.ErrorCodeUnavailable},
		{"server timeout", apierrors.NewServerTimeout(group, "patch", 1), protocol.ErrorCodeUnavailable},
		{"throttled", apierrors.NewTooManyRequests("slow", 1), protocol.ErrorCodeUnavailable},
		{"5xx", apierrors.NewInternalError(errors.New("down")), protocol.ErrorCodeUnavailable},
		{"EOF", io.EOF, protocol.ErrorCodeUnavailable},
		{"network", &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("offline")}, protocol.ErrorCodeUnavailable},
		{"cancelled", context.Canceled, protocol.ErrorCodeCancelled},
		{"deadline", context.DeadlineExceeded, protocol.ErrorCodeUnavailable},
		{"internal", errors.New("broken"), protocol.ErrorCodeInternal},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			detail := toProtocolError(fmt.Errorf("wrapped: %w", tt.err))
			if detail.Code != tt.code {
				t.Fatalf("code = %s, want %s", detail.Code, tt.code)
			}
			var status apierrors.APIStatus
			if errors.As(tt.err, &status) {
				s := status.Status()
				if detail.Reason != string(s.Reason) || detail.Message != s.Message {
					t.Fatalf("lost status: %+v", detail)
				}
				if s.Details != nil {
					causes := []protocol.ErrorCause{}
					for _, cause := range s.Details.Causes {
						causes = append(causes, protocol.ErrorCause{Field: cause.Field, Reason: string(cause.Type), Message: cause.Message})
					}
					if !reflect.DeepEqual(detail.Causes, causes) {
						t.Fatalf("lost causes: %+v", detail)
					}
				}
			}
		})
	}
}

func TestRequestCancellationBeforeWrite(t *testing.T) {
	p := serverEdit(t)
	entered := make(chan struct{}, 1)
	var writes atomic.Int32
	config := rest.CopyConfig(cfg)
	config.WrapTransport = func(next http.RoundTripper) http.RoundTripper {
		return editTransport(func(r *http.Request) (*http.Response, error) {
			if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/configmaps/"+p.Name) {
				entered <- struct{}{}
				<-r.Context().Done()
				return nil, r.Context().Err()
			}
			if r.Method == http.MethodPatch {
				writes.Add(1)
			}
			return next.RoundTrip(r)
		})
	}
	c := mustDial(t, newEditServer(t, config, false))
	sendRequest(t, c, 1, protocol.RequestResourceApply.Name, p)
	receiveChannel(t, entered)
	c.send(protocol.ClientMessage{ID: 1, Type: protocol.ClientTypeCancel})
	reply := awaitReply(t, c, 1)
	if reply.Error == nil || reply.Error.Code != protocol.ErrorCodeCancelled {
		t.Fatalf("preflight cancel = %+v", reply)
	}
	if writes.Load() != 0 {
		t.Fatalf("cancelled preflight wrote %d times", writes.Load())
	}
}

func TestUnknownResourceRequest(t *testing.T) {
	c := mustDial(t, newEditServer(t, cfg, false))
	sendRequest(t, c, 1, protocol.RequestResourceReview.Name, protocol.ResourceEdit{Cluster: testenv.ClusterID, Type: "missing.example", Name: "no"})
	reply := awaitReply(t, c, 1)
	if reply.Error == nil || reply.Error.Code != protocol.ErrorCodeNotFound {
		t.Fatalf("unknown type = %+v", reply)
	}
}
