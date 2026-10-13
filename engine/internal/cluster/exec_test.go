package cluster

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	authv1 "k8s.io/api/authorization/v1"
	"k8s.io/client-go/rest"

	"k8s.io/streaming/pkg/httpstream"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

func TestExecFallback(t *testing.T) {
	if !execFallback(&httpstream.UpgradeFailureError{Cause: errors.New("upgrade refused")}) {
		t.Fatal("streaming upgrade failure did not fall back")
	}
	if !execFallback(errors.New("proxy: unknown scheme: https")) {
		t.Fatal("HTTPS proxy error did not fall back")
	}
	if execFallback(errors.New("ordinary failure")) {
		t.Fatal("ordinary failure fell back")
	}
}

func TestExecAccess(t *testing.T) {
	var calls atomic.Int32
	config := rest.CopyConfig(cfg)
	config.ContentType = "application/json"
	config.AcceptContentTypes = "application/json"
	config.WrapTransport = func(next http.RoundTripper) http.RoundTripper {
		return mutationTransport(func(r *http.Request) (*http.Response, error) {
			if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/selfsubjectaccessreviews") {
				return next.RoundTrip(r)
			}
			var review authv1.SelfSubjectAccessReview
			if err := json.NewDecoder(r.Body).Decode(&review); err != nil {
				return nil, err
			}
			attrs := review.Spec.ResourceAttributes
			calls.Add(1)
			if attrs.Verb == "create" && (attrs.Subresource != "exec" || attrs.Resource != "pods" || attrs.Group != "" || attrs.Namespace != "ns" || attrs.Name != "web") {
				t.Errorf("exec attributes=%+v", attrs)
			}
			return statusResponse(t, map[string]any{"apiVersion": "authorization.k8s.io/v1", "kind": "SelfSubjectAccessReview", "status": map[string]any{"denied": true, "reason": "Policy denies this action."}}, 201), nil
		})
	}
	c := connectAs(t, config, testTiming())
	other, err := c.Access(context.Background(), protocol.ResourceRef{Type: "configmaps", Namespace: "ns", Name: "web"})
	if err != nil || other.Exec != (protocol.Access{}) || calls.Load() != 2 {
		t.Fatalf("non-Pod access=%+v calls=%d error=%v", other, calls.Load(), err)
	}
	pod, err := c.Access(context.Background(), protocol.ResourceRef{Type: "pods", Namespace: "ns", Name: "web"})
	if err != nil || pod.Exec.Allowed || !strings.Contains(pod.Exec.Reason, "Policy denies this action.") || calls.Load() != 5 {
		t.Fatalf("Pod exec=%+v calls=%d error=%v", pod.Exec, calls.Load(), err)
	}
	again, err := c.ExecAccess(context.Background(), "ns", "web")
	if err != nil || again != pod.Exec || calls.Load() != 5 {
		t.Fatalf("exec cache=%+v calls=%d error=%v", again, calls.Load(), err)
	}
	// An executor uses the same no-timeout config as the log client.
	if c.execConfig.Timeout != 0 {
		t.Fatalf("exec config timeout=%v", c.execConfig.Timeout)
	}
}
