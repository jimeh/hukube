package cluster

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/jimeh/hukube/engine/internal/apierror"
	"github.com/jimeh/hukube/engine/internal/edit"
	"github.com/jimeh/hukube/engine/internal/protocol"
	"github.com/jimeh/hukube/engine/internal/testenv"
)

func createEditResource(t *testing.T, namespace, resource string, manifest string) (dynamic.ResourceInterface, *unstructured.Unstructured) {
	t.Helper()
	group, version := "", "v1"
	if resource == "deployments" {
		group, version = "apps", "v1"
	}
	client := dynamic.NewForConfigOrDie(cfg).Resource(schema.GroupVersionResource{Group: group, Version: version, Resource: resource}).Namespace(namespace)
	var obj unstructured.Unstructured
	if err := json.Unmarshal([]byte(manifest), &obj.Object); err != nil {
		t.Fatal(err)
	}
	live, err := client.Create(context.Background(), &obj, metav1.CreateOptions{FieldManager: "creator"})
	if err != nil {
		t.Fatal(err)
	}
	return client, live
}

func resourceEdit(t *testing.T, key protocol.TypeKey, live *unstructured.Unstructured, modify func(map[string]any)) protocol.ResourceEdit {
	t.Helper()
	raw, err := json.Marshal(live.Object)
	if err != nil {
		t.Fatal(err)
	}
	obj := live.DeepCopy().Object
	modify(obj)
	manifest, err := json.Marshal(obj)
	if err != nil {
		t.Fatal(err)
	}
	return protocol.ResourceEdit{Cluster: testenv.ClusterID, Type: key, Namespace: live.GetNamespace(), Name: live.GetName(), UID: string(live.GetUID()), Base: raw, Manifest: manifest}
}
func expectCode(t *testing.T, err error, code protocol.ErrorCode) {
	t.Helper()
	if err == nil || apierror.Detail(err).Code != code {
		t.Fatalf("error = %v, want %s", err, code)
	}
}

func TestEditApplyAndRepeat(t *testing.T) {
	c := connect(t)
	ctx := context.Background()
	ns := createNamespace(t, kubernetes.NewForConfigOrDie(cfg))
	client, live := createEditResource(t, ns, "configmaps", `{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"apply"},"data":{"mine":"old","other":"old","gone":"old"}}`)
	p := resourceEdit(t, "configmaps", live, func(obj map[string]any) {
		data := obj["data"].(map[string]any)
		data["mine"] = "new"
		delete(data, "gone")
	})
	updated := live.DeepCopy()
	updated.Object["data"].(map[string]any)["other"] = "theirs"
	if _, err := client.Update(ctx, updated, metav1.UpdateOptions{FieldManager: "other"}); err != nil {
		t.Fatal(err)
	}
	review, err := c.Review(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if len(review.Overlaps) != 0 || !reflect.DeepEqual(review.ChangedOnCluster, []protocol.FieldPath{{"data", "other"}}) {
		t.Fatalf("unrelated change: %+v", review)
	}
	result, err := c.Apply(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	after, err := client.Get(ctx, p.Name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	data := after.Object["data"].(map[string]any)
	if _, kept := data["gone"]; data["mine"] != "new" || data["other"] != "theirs" || kept {
		t.Fatalf("applied data = %v", data)
	}
	found := false
	for _, manager := range after.GetManagedFields() {
		if manager.Manager == "hukube" {
			found = true
			if manager.FieldsV1.GetRawString() != `{"f:data":{"f:mine":{}}}` {
				t.Errorf("hukube took fields outside the edit: %s", manager.FieldsV1.GetRawString())
			}
		}
	}
	if !found {
		t.Fatal("hukube missing from managedFields")
	}
	again, err := c.Apply(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if !again.Unchanged || again.ResourceVersion != result.ResourceVersion {
		t.Fatalf("repeat wrote again: first %+v, repeat %+v", result, again)
	}
}

func TestEditRepeatWithExpectedDefaults(t *testing.T) {
	c := connect(t)
	ctx := context.Background()
	ns := createNamespace(t, kubernetes.NewForConfigOrDie(cfg))
	client, live := createEditResource(t, ns, "services", `{"apiVersion":"v1","kind":"Service","metadata":{"name":"expected"},"spec":{"ports":[{"port":80}]}}`)
	p := resourceEdit(t, "services", live, func(obj map[string]any) {
		spec := obj["spec"].(map[string]any)
		spec["ports"] = append(spec["ports"].([]any), map[string]any{"port": int64(81), "name": "extra"})
		spec["ports"].([]any)[0].(map[string]any)["name"] = "original"
	})
	r, err := c.Review(ctx, p)
	if err != nil || r.Refusal != nil {
		t.Fatalf("review: %+v, error: %v", r, err)
	}
	if edit.Equal(r.After, r.Desired) {
		t.Fatal("dry run did not default the edited list")
	}
	p.Base, p.Manifest, p.Expected = r.Before, r.Desired, r.After
	p.Expected = json.RawMessage(strings.ReplaceAll(string(p.Expected), `"port":81`, `"port":81.0`))
	first, err := c.Apply(ctx, p)
	if err != nil || first.Unchanged {
		t.Fatalf("first apply: %+v, error: %v", first, err)
	}
	repeated, err := c.Apply(ctx, p)
	if err != nil || !repeated.Unchanged || repeated.ResourceVersion != first.ResourceVersion {
		t.Fatalf("repeat with expected: %+v, error: %v, first: %+v", repeated, err, first)
	}
	after, err := client.Get(ctx, p.Name, metav1.GetOptions{})
	if err != nil || after.GetResourceVersion() != first.ResourceVersion {
		t.Fatalf("repeat moved resourceVersion: %v, error: %v", after, err)
	}
	// Review ignores Expected, even when it is not a Manifest.
	p.Expected = json.RawMessage(`false`)
	if _, err := c.Review(ctx, p); err != nil {
		t.Fatal("review used Expected", err)
	}
	p.Expected = nil
	_, err = c.Apply(ctx, p)
	expectCode(t, err, protocol.ErrorCodeConflict)
}

func TestSentWriteResponseFailure(t *testing.T) {
	for _, method := range []string{http.MethodPatch, http.MethodDelete} {
		failures := []string{"read"}
		// client-go does not decode the body of a successful DELETE response.
		if method == http.MethodPatch {
			failures = append(failures, "decode")
		}
		for _, failure := range failures {
			t.Run(method+"/"+failure, func(t *testing.T) {
				ctx := context.Background()
				ns := createNamespace(t, kubernetes.NewForConfigOrDie(cfg))
				client, live := createEditResource(t, ns, "configmaps", `{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"lost-answer"},"data":{"a":"old"}}`)
				p := resourceEdit(t, "configmaps", live, func(obj map[string]any) { obj["data"].(map[string]any)["a"] = "new" })
				var sent atomic.Bool
				config := rest.CopyConfig(cfg)
				config.WrapTransport = func(next http.RoundTripper) http.RoundTripper {
					return mutationTransport(func(request *http.Request) (*http.Response, error) {
						response, err := next.RoundTrip(request)
						if err == nil && request.Method == method {
							sent.Store(true)
							_ = response.Body.Close()
							if failure == "read" {
								response.Body = failedResponseBody{}
							} else {
								response.Body = io.NopCloser(strings.NewReader(`{"broken":`))
							}
						}
						return response, err
					})
				}
				c := connectAs(t, config, testTiming())
				var err error
				if method == http.MethodPatch {
					_, err = c.Apply(ctx, p)
				} else {
					err = c.Delete(ctx, protocol.DeleteParams{Type: p.Type, Namespace: ns, Name: p.Name, UID: p.UID})
				}
				expectCode(t, err, protocol.ErrorCodeUnavailable)
				if !sent.Load() {
					t.Fatal("write did not reach the API server")
				}
				after, err := client.Get(ctx, p.Name, metav1.GetOptions{})
				if method == http.MethodDelete {
					if !apierrors.IsNotFound(err) {
						t.Fatalf("delete did not land: %v", err)
					}
				} else if err != nil || after.Object["data"].(map[string]any)["a"] != "new" {
					t.Fatalf("apply did not land: %v, error: %v", after, err)
				}
			})
		}
	}
}

type failedResponseBody struct{}

func (failedResponseBody) Read([]byte) (int, error) { return 0, errors.New("response body failed") }
func (failedResponseBody) Close() error             { return nil }

func TestEditReviewDefaultingAndRefusal(t *testing.T) {
	c := connect(t)
	ctx := context.Background()
	ns := createNamespace(t, kubernetes.NewForConfigOrDie(cfg))
	client, live := createEditResource(t, ns, "deployments", `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"review"},"spec":{"replicas":1,"selector":{"matchLabels":{"app":"web"}},"template":{"metadata":{"labels":{"app":"web"}},"spec":{"containers":[{"name":"web","image":"nginx:1"}]}}}}`)
	p := resourceEdit(t, "deployments.apps", live, func(obj map[string]any) {
		spec := obj["spec"].(map[string]any)["template"].(map[string]any)["spec"].(map[string]any)
		spec["containers"] = append(spec["containers"].([]any), map[string]any{"name": "sidecar", "image": "busybox:latest"})
	})
	r, err := c.Review(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if r.Refusal != nil || len(r.After) == 0 || !slices.ContainsFunc(r.SetByCluster, func(p protocol.FieldPath) bool {
		return reflect.DeepEqual(p, protocol.FieldPath{"spec", "template", "spec", "containers"})
	}) {
		t.Fatalf("defaulting missing: %+v", r)
	}
	after, err := client.Get(ctx, p.Name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if after.GetResourceVersion() != live.GetResourceVersion() {
		t.Fatal("dry run wrote the Resource")
	}
	var preview map[string]any
	_ = json.Unmarshal(r.After, &preview)
	containers := preview["spec"].(map[string]any)["template"].(map[string]any)["spec"].(map[string]any)["containers"].([]any)
	if containers[1].(map[string]any)["imagePullPolicy"] != "Always" {
		t.Fatalf("default not returned: %s", r.After)
	}
	for _, tt := range []struct {
		name, field string
		modify      func(map[string]any)
	}{
		{"negative replicas", "spec.replicas", func(obj map[string]any) { obj["spec"].(map[string]any)["replicas"] = int64(-1) }},
		{"wrong type", "spec.replicas", func(obj map[string]any) { obj["spec"].(map[string]any)["replicas"] = "3 [" }},
		{"unknown field", "spec.mystery", func(obj map[string]any) { obj["spec"].(map[string]any)["mystery"] = "unknown" }},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p := resourceEdit(t, "deployments.apps", live, tt.modify)
			r, err := c.Review(ctx, p)
			if err != nil {
				t.Fatal(err)
			}
			if r.Refusal == nil || r.Refusal.Code != protocol.ErrorCodeInvalid || !slices.ContainsFunc(r.Refusal.Causes, func(c protocol.ErrorCause) bool { return c.Field == tt.field }) {
				t.Fatalf("refusal lost field: %+v", r.Refusal)
			}
			t.Logf("refusal: %+v causes: %+v", r.Refusal, r.Refusal.Causes)
			if len(r.Refusal.Message) > 1000 {
				t.Fatalf("unbounded message: %s", r.Refusal.Message)
			}
			for _, cause := range r.Refusal.Causes {
				if len(cause.Message) > 200 {
					t.Fatalf("unreadable cause: %s", cause.Message)
				}
			}
			_, err = c.Apply(ctx, p)
			expectCode(t, err, protocol.ErrorCodeInvalid)
			if !reflect.DeepEqual(apierror.Detail(err).Causes, r.Refusal.Causes) {
				t.Fatalf("apply lost causes: %v, review %+v", err, r.Refusal)
			}
		})
	}
}

func TestEditConcurrentAndServerChanges(t *testing.T) {
	c := connect(t)
	ctx := context.Background()
	ns := createNamespace(t, kubernetes.NewForConfigOrDie(cfg))
	client, live := createEditResource(t, ns, "deployments", `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"concurrent"},"spec":{"replicas":1,"selector":{"matchLabels":{"app":"web"}},"template":{"metadata":{"labels":{"app":"web"}},"spec":{"containers":[{"name":"web","image":"nginx:1"}]}}}}`)
	p := resourceEdit(t, "deployments.apps", live, func(obj map[string]any) { obj["spec"].(map[string]any)["replicas"] = int64(2) })
	status := live.DeepCopy()
	status.Object["status"] = map[string]any{"replicas": int64(1)}
	if _, err := client.UpdateStatus(ctx, status, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	r, err := c.Review(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.ChangedOnCluster) != 0 || len(r.Overlaps) != 0 {
		t.Fatalf("status reported: %+v", r)
	}
	if _, err := client.Patch(ctx, p.Name, types.MergePatchType, []byte(`{"spec":{"replicas":3}}`), metav1.PatchOptions{}); err != nil {
		t.Fatal(err)
	}
	r, err = c.Review(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(r.Overlaps, []protocol.FieldPath{{"spec", "replicas"}}) {
		t.Fatalf("overlap missing: %+v", r)
	}
	_, err = c.Apply(ctx, p)
	expectCode(t, err, protocol.ErrorCodeConflict)
	current, err := client.Get(ctx, p.Name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if current.Object["spec"].(map[string]any)["replicas"] != int64(3) {
		t.Fatalf("conflict overwrote value: %v", current.Object["spec"])
	}
	// Applying the review's own pair explicitly accepts the value it showed.
	p.Base, p.Manifest = r.Before, r.Desired
	if _, err := c.Apply(ctx, p); err != nil {
		t.Fatal(err)
	}
}

func TestEditDeletedAndReplaced(t *testing.T) {
	c := connect(t)
	ctx := context.Background()
	ns := createNamespace(t, kubernetes.NewForConfigOrDie(cfg))
	client, live := createEditResource(t, ns, "configmaps", `{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"gone"},"data":{"a":"old"}}`)
	p := resourceEdit(t, "configmaps", live, func(obj map[string]any) { obj["data"].(map[string]any)["a"] = "new" })
	if err := client.Delete(ctx, p.Name, metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	for _, replaced := range []bool{false, true} {
		if replaced {
			createEditResource(t, ns, "configmaps", `{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"gone"},"data":{"a":"replacement"}}`)
		}
		_, err := c.Review(ctx, p)
		expectCode(t, err, protocol.ErrorCodeNotFound)
		word := "deleted"
		if replaced {
			word = "replaced"
		}
		if !strings.Contains(err.Error(), word) {
			t.Fatalf("missing %s explanation: %v", word, err)
		}
		_, err = c.Apply(ctx, p)
		expectCode(t, err, protocol.ErrorCodeNotFound)
	}
	_, err := c.Review(ctx, protocol.ResourceEdit{Type: "missing.example", Name: "no"})
	if err == nil || !strings.Contains(err.Error(), ErrUnknownType.Error()) {
		t.Fatalf("unknown type waited: %v", err)
	}
}

func TestEditPermissions(t *testing.T) {
	c := connectAs(t, testenv.User(t, "edit-no-permissions"), testTiming())
	ctx := context.Background()
	ns := createNamespace(t, kubernetes.NewForConfigOrDie(cfg))
	_, live := createEditResource(t, ns, "configmaps", `{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"permission"},"data":{"a":"old"}}`)
	p := resourceEdit(t, "configmaps", live, func(obj map[string]any) { obj["data"].(map[string]any)["a"] = "new" })
	access, err := c.Access(ctx, protocol.ResourceRef{Type: p.Type, Namespace: ns, Name: p.Name})
	if err != nil {
		t.Fatal(err)
	}
	if access.Edit.Allowed || access.Delete.Allowed || access.Edit.Reason == "" || access.Delete.Reason == "" {
		t.Fatalf("permission denied without reason: %+v", access)
	}
	// Permit reads only, so the forbidden dry run can retain the comparison.
	grantEditRead(t, "edit-no-permissions", ns)
	r, err := c.Review(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if r.Refusal == nil || r.Refusal.Code != protocol.ErrorCodeForbidden || len(r.Desired) == 0 {
		t.Fatalf("forbidden review lost comparison: %+v", r)
	}
	err = c.Delete(ctx, protocol.DeleteParams{Type: p.Type, Namespace: ns, Name: p.Name, UID: p.UID})
	expectCode(t, err, protocol.ErrorCodeForbidden)
}

func TestDeleteOptions(t *testing.T) {
	c := connect(t)
	ctx := context.Background()
	cs := kubernetes.NewForConfigOrDie(cfg)
	ns := createNamespace(t, cs)
	for _, policy := range []protocol.DeletePropagation{protocol.DeletePropagationBackground, protocol.DeletePropagationForeground, protocol.DeletePropagationOrphan} {
		t.Run(string(policy), func(t *testing.T) {
			client, live := createEditResource(t, ns, "configmaps", fmt.Sprintf(`{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":%q}}`, policy))
			p := protocol.DeleteParams{Type: "configmaps", Namespace: ns, Name: live.GetName(), UID: string(live.GetUID()), Propagation: policy, Immediate: true}
			if err := c.Delete(ctx, p); err != nil {
				t.Fatal(err)
			}
			after, err := client.Get(ctx, p.Name, metav1.GetOptions{})
			if policy == protocol.DeletePropagationBackground {
				if !apierrors.IsNotFound(err) {
					t.Fatalf("background did not remove Resource: %v", err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				finalizer := metav1.FinalizerDeleteDependents
				if policy == protocol.DeletePropagationOrphan {
					finalizer = metav1.FinalizerOrphanDependents
				}
				if after.GetDeletionTimestamp() == nil || !slices.Contains(after.GetFinalizers(), finalizer) {
					t.Fatalf("delete option missing: %+v", after.Object["metadata"])
				}
			}
		})
	}
	_, live := createEditResource(t, ns, "configmaps", `{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"uid"}}`)
	p := protocol.DeleteParams{Type: "configmaps", Namespace: ns, Name: live.GetName(), UID: "stale"}
	err := c.Delete(ctx, p)
	expectCode(t, err, protocol.ErrorCodeConflict)
	if !strings.Contains(err.Error(), "Nothing was deleted") {
		t.Fatalf("UID explanation lost: %v", err)
	}
	if _, err := cs.CoreV1().ConfigMaps(ns).Get(ctx, p.Name, metav1.GetOptions{}); err != nil {
		t.Fatal("stale UID deleted Resource", err)
	}
	p.UID = string(live.GetUID())
	if err := c.Delete(ctx, p); err != nil {
		t.Fatal(err)
	}
	if err := c.Delete(ctx, p); err != nil {
		t.Fatal("repeat delete", err)
	}
	for _, immediate := range []bool{false, true} {
		t.Run(fmt.Sprintf("pod immediate=%v", immediate), func(t *testing.T) {
			pod, err := cs.CoreV1().Pods(ns).Create(ctx, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{GenerateName: "grace-"}, Spec: corev1.PodSpec{NodeName: "node", Containers: []corev1.Container{{Name: "web", Image: "nginx"}}}}, metav1.CreateOptions{})
			if err != nil {
				t.Fatal(err)
			}
			err = c.Delete(ctx, protocol.DeleteParams{Type: "pods", Namespace: ns, Name: pod.Name, UID: string(pod.UID), Immediate: immediate})
			if err != nil {
				t.Fatal(err)
			}
			after, err := cs.CoreV1().Pods(ns).Get(ctx, pod.Name, metav1.GetOptions{})
			if immediate {
				if !apierrors.IsNotFound(err) {
					t.Fatalf("immediate Pod still present: %v", err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				if after.DeletionTimestamp == nil {
					t.Fatal("Pod has no deletionTimestamp")
				}
			}
		})
	}
}

func grantEditRead(t *testing.T, user, ns string) {
	t.Helper()
	cs := kubernetes.NewForConfigOrDie(cfg)
	role, err := cs.RbacV1().Roles(ns).Create(context.Background(), &rbacv1.Role{ObjectMeta: metav1.ObjectMeta{Name: "edit-reader"}, Rules: []rbacv1.PolicyRule{{APIGroups: []string{""}, Resources: []string{"configmaps"}, Verbs: []string{"get"}}}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = cs.RbacV1().RoleBindings(ns).Create(context.Background(), &rbacv1.RoleBinding{ObjectMeta: metav1.ObjectMeta{Name: "edit-reader"}, RoleRef: rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "Role", Name: role.Name}, Subjects: []rbacv1.Subject{{Kind: "User", Name: user}}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	reader := kubernetes.NewForConfigOrDie(testenv.User(t, user))
	eventually(t, func() (bool, string) {
		_, err := reader.CoreV1().ConfigMaps(ns).Get(context.Background(), "permission", metav1.GetOptions{})
		return err == nil, fmt.Sprint(err)
	})
}

type mutationTransport func(*http.Request) (*http.Response, error)

func (f mutationTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func statusResponse(t *testing.T, status any, code int) *http.Response {
	t.Helper()
	if s, ok := status.(metav1.Status); ok {
		s.APIVersion = "v1"
		s.Kind = "Status"
		status = s
	}
	body, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(string(body)))}
}

func TestEditRetriesAndWarnings(t *testing.T) {
	ctx := context.Background()
	ns := createNamespace(t, kubernetes.NewForConfigOrDie(cfg))
	_, live := createEditResource(t, ns, "configmaps", `{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"retry"},"data":{"a":"old"}}`)
	p := resourceEdit(t, "configmaps", live, func(obj map[string]any) { obj["data"].(map[string]any)["a"] = "new" })
	var attempts atomic.Int32
	var conflicts atomic.Int32
	conflicts.Store(4)
	config := rest.CopyConfig(cfg)
	config.WrapTransport = func(next http.RoundTripper) http.RoundTripper {
		return mutationTransport(func(r *http.Request) (*http.Response, error) {
			if r.Method == http.MethodPatch {
				attempt := attempts.Add(1)
				if attempt <= conflicts.Load() {
					return statusResponse(t, metav1.Status{Status: "Failure", Code: 409, Reason: metav1.StatusReasonConflict, Message: "concurrent change"}, 409), nil
				}
				response, err := next.RoundTrip(r)
				if response != nil {
					response.Header.Add("Warning", `299 apiserver "admission warning"`)
				}
				return response, err
			}
			return next.RoundTrip(r)
		})
	}
	c := connectAs(t, config, testTiming())
	review, err := c.Review(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if attempts.Load() != 5 || !reflect.DeepEqual(review.Warnings, []string{"admission warning"}) {
		t.Fatalf("retry or warnings missing: attempts %d, review %+v", attempts.Load(), review)
	}
	attempts.Store(0)
	result, err := c.Apply(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if attempts.Load() != 5 || !reflect.DeepEqual(result.Warnings, []string{"admission warning"}) {
		t.Fatalf("retry or warnings missing: attempts %d, result %+v", attempts.Load(), result)
	}
	// Use a new edit, so neither exhaustion nor the dry-run refusal is bypassed as unchanged.
	p.Base, p.Manifest = p.Manifest, p.Base
	for _, apply := range []bool{false, true} {
		attempts.Store(0)
		conflicts.Store(5)
		if apply {
			_, err = c.Apply(ctx, p)
			expectCode(t, err, protocol.ErrorCodeConflict)
		} else {
			_, err = c.Review(ctx, p)
			expectCode(t, err, protocol.ErrorCodeUnavailable)
		}
		if attempts.Load() != 5 {
			t.Fatalf("unbounded retries: %d", attempts.Load())
		}
	}
}

func TestEditDryRunUnsupported(t *testing.T) {
	ctx := context.Background()
	ns := createNamespace(t, kubernetes.NewForConfigOrDie(cfg))
	_, live := createEditResource(t, ns, "configmaps", `{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"unsupported"},"data":{"a":"old"}}`)
	p := resourceEdit(t, "configmaps", live, func(obj map[string]any) { obj["data"].(map[string]any)["a"] = "new" })
	config := rest.CopyConfig(cfg)
	config.WrapTransport = func(next http.RoundTripper) http.RoundTripper {
		return mutationTransport(func(r *http.Request) (*http.Response, error) {
			if r.Method == http.MethodPatch && r.URL.Query().Get("dryRun") == "All" {
				return statusResponse(t, metav1.Status{Status: "Failure", Code: 400, Reason: metav1.StatusReasonBadRequest, Message: "webhook does not support dry run"}, 400), nil
			}
			return next.RoundTrip(r)
		})
	}
	c := connectAs(t, config, testTiming())
	review, err := c.Review(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if !review.DryRunUnsupported || review.Refusal == nil || review.Refusal.Code != protocol.ErrorCodeInvalid || len(review.After) != 0 {
		t.Fatalf("unsupported dry run = %+v", review)
	}
	if _, err := c.Apply(ctx, p); err != nil {
		t.Fatal("real apply refused after unsupported dry run", err)
	}
}

func TestEditAccessCacheAndFallback(t *testing.T) {
	var calls atomic.Int32
	var mode atomic.Int32
	config := rest.CopyConfig(cfg)
	config.WrapTransport = func(next http.RoundTripper) http.RoundTripper {
		return mutationTransport(func(r *http.Request) (*http.Response, error) {
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/selfsubjectaccessreviews") {
				calls.Add(1)
				switch mode.Load() {
				case 1:
					return statusResponse(t, map[string]any{"apiVersion": "authorization.k8s.io/v1", "kind": "SelfSubjectAccessReview", "status": map[string]any{"evaluationError": "cannot evaluate"}}, 201), nil
				case 2:
					return statusResponse(t, metav1.Status{Status: "Failure", Code: 403, Reason: metav1.StatusReasonForbidden, Message: "reviews forbidden"}, 403), nil
				default:
					return statusResponse(t, map[string]any{"apiVersion": "authorization.k8s.io/v1", "kind": "SelfSubjectAccessReview", "status": map[string]any{"denied": true, "reason": "Policy denies this action."}}, 201), nil
				}
			}
			return next.RoundTrip(r)
		})
	}
	c := connectAs(t, config, testTiming())
	ref := protocol.ResourceRef{Type: "configmaps", Namespace: "ns", Name: "web"}
	denied, err := c.Access(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	if denied.Edit.Allowed || denied.Delete.Allowed || !strings.Contains(denied.Edit.Reason, "Policy denies this action.") {
		t.Fatalf("denial = %+v", denied)
	}
	again, err := c.Access(context.Background(), ref)
	if err != nil || again != denied || calls.Load() != 2 {
		t.Fatalf("cache missed: calls=%d, access=%+v, error=%v", calls.Load(), again, err)
	}
	ref.Name = "other"
	if _, err := c.Access(context.Background(), ref); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 4 {
		t.Fatalf("cache not per named Resource: %d", calls.Load())
	}
	for _, value := range []int32{1, 2} {
		mode.Store(value)
		// Expire at an observable boundary rather than sleeping for the TTL.
		c.accessMu.Lock()
		for key, cached := range c.access {
			cached.until = time.Time{}
			c.access[key] = cached
		}
		c.accessMu.Unlock()
		access, err := c.Access(context.Background(), ref)
		if err != nil {
			t.Fatal(err)
		}
		if !access.Edit.Allowed || !access.Delete.Allowed {
			t.Fatalf("indeterminate review locked out user: %+v", access)
		}
	}
	if calls.Load() != 8 {
		t.Fatalf("expired cache reused: %d", calls.Load())
	}
	c.mu.Lock()
	c.types["configmaps"].info.Verbs = []string{"get"}
	c.mu.Unlock()
	access, err := c.Access(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	if access.Edit.Allowed || access.Delete.Allowed || !strings.Contains(access.Edit.Reason, "does not support") || calls.Load() != 8 {
		t.Fatalf("discovered verbs not checked first: %+v, calls %d", access, calls.Load())
	}
}

func TestEditWriteTimeout(t *testing.T) {
	ns := createNamespace(t, kubernetes.NewForConfigOrDie(cfg))
	_, live := createEditResource(t, ns, "configmaps", `{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"timeout"},"data":{"a":"old"}}`)
	p := resourceEdit(t, "configmaps", live, func(obj map[string]any) { obj["data"].(map[string]any)["a"] = "new" })
	timing := testTiming()
	timing.WriteTimeout = 20 * time.Millisecond
	var started atomic.Bool
	config := rest.CopyConfig(cfg)
	config.WrapTransport = func(next http.RoundTripper) http.RoundTripper {
		return mutationTransport(func(r *http.Request) (*http.Response, error) {
			if r.Method == http.MethodPatch {
				started.Store(true)
				deadline, ok := r.Context().Deadline()
				if !ok || time.Until(deadline) > timing.WriteTimeout {
					t.Errorf("write deadline does not use Timing.WriteTimeout: %v, present %v", deadline, ok)
					return nil, context.DeadlineExceeded
				}
				<-r.Context().Done()
				return nil, r.Context().Err()
			}
			return next.RoundTrip(r)
		})
	}
	c := connectAs(t, config, timing)
	_, err := c.Apply(context.Background(), p)
	expectCode(t, err, protocol.ErrorCodeUnavailable)
	if !started.Load() {
		t.Fatal("write never reached the transport")
	}
}
