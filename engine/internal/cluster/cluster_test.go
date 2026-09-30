package cluster

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apiextv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apiextclient "k8s.io/apiextensions-apiserver/pkg/client/clientset/clientset"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/jimeh/hukube/engine/internal/protocol"
	"github.com/jimeh/hukube/engine/internal/testenv"
)

var cfg *rest.Config

func TestMain(m *testing.M) {
	os.Exit(testenv.Run(m, &cfg))
}

// testTiming shortens delays that tests wait on.
func testTiming() Timing {
	t := DefaultTiming
	t.DiscoveryDelay = 100 * time.Millisecond
	t.ObjectRetry = 100 * time.Millisecond
	return t
}

const waitTimeout = 30 * time.Second

// eventually polls cond until it reports true, failing with the last observed
// state when the deadline passes.
func eventually(t *testing.T, cond func() (bool, string)) {
	t.Helper()
	deadline := time.Now().Add(waitTimeout)
	for {
		ok, state := cond()
		if ok {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("condition not met within %s; last state: %s", waitTimeout, state)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func connect(t *testing.T) *Cluster {
	t.Helper()
	return connectAs(t, cfg, testTiming())
}

// connectAs connects to the API server at restCfg and waits until ready.
func connectAs(t *testing.T, restCfg *rest.Config, timing Timing) *Cluster {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m := NewManagerWithTiming(ctx, testenv.Source{Config: restCfg}, slog.New(slog.DiscardHandler), timing)
	c, err := m.Get(testenv.ClusterID)
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, func() (bool, string) {
		s := c.Status()
		return s.Phase == protocol.ClusterPhaseReady, fmt.Sprintf("%+v", s)
	})
	return c
}

func typeState(c *Cluster, key protocol.TypeKey) (protocol.ResourceType, bool) {
	for _, rt := range c.Types() {
		if rt.Key == key {
			return rt, true
		}
	}
	return protocol.ResourceType{}, false
}

func createNamespace(t *testing.T, cs kubernetes.Interface) string {
	t.Helper()
	ns, err := cs.CoreV1().Namespaces().Create(context.Background(),
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{GenerateName: "test-"}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return ns.Name
}

func TestIndexFollowsResourceChanges(t *testing.T) {
	c := connect(t)
	cs := kubernetes.NewForConfigOrDie(cfg)
	ns := createNamespace(t, cs)
	ctx := context.Background()

	eventually(t, func() (bool, string) {
		rt, ok := typeState(c, "configmaps")
		return ok && rt.State == protocol.TypeStateReady, fmt.Sprintf("%+v", rt)
	})

	_, err := cs.CoreV1().ConfigMaps(ns).Create(ctx,
		&corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "indexed"}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, func() (bool, string) {
		_, ok := c.Index.Get("configmaps", ns+"/indexed")
		return ok, "configmap not in index"
	})

	if err := cs.CoreV1().ConfigMaps(ns).Delete(ctx, "indexed", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() (bool, string) {
		_, ok := c.Index.Get("configmaps", ns+"/indexed")
		return !ok, "configmap still in index"
	})
}

func TestDiscoversCustomResourceTypesAtRuntime(t *testing.T) {
	c := connect(t)
	ctx := context.Background()
	ext := apiextclient.NewForConfigOrDie(cfg)
	const key = protocol.TypeKey("widgets.example.hukube.dev")

	crd := &apiextv1.CustomResourceDefinition{
		ObjectMeta: metav1.ObjectMeta{Name: string(key)},
		Spec: apiextv1.CustomResourceDefinitionSpec{
			Group: "example.hukube.dev",
			Names: apiextv1.CustomResourceDefinitionNames{Plural: "widgets", Singular: "widget", Kind: "Widget", ListKind: "WidgetList"},
			Scope: apiextv1.ClusterScoped,
			Versions: []apiextv1.CustomResourceDefinitionVersion{{
				Name: "v1", Served: true, Storage: true,
				Schema: &apiextv1.CustomResourceValidation{OpenAPIV3Schema: &apiextv1.JSONSchemaProps{
					Type: "object", XPreserveUnknownFields: ptr(true),
				}},
			}},
		},
	}
	if _, err := ext.ApiextensionsV1().CustomResourceDefinitions().Create(ctx, crd, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = ext.ApiextensionsV1().CustomResourceDefinitions().Delete(context.Background(), string(key), metav1.DeleteOptions{})
	})

	eventually(t, func() (bool, string) {
		rt, ok := typeState(c, key)
		return ok && rt.State == protocol.TypeStateReady && rt.Kind == "Widget", fmt.Sprintf("%+v (found: %v)", rt, ok)
	})

	gvr := schema.GroupVersionResource{Group: "example.hukube.dev", Version: "v1", Resource: "widgets"}
	widget := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "example.hukube.dev/v1", "kind": "Widget", "metadata": map[string]any{"name": "sprocket"},
	}}
	if _, err := dynamic.NewForConfigOrDie(cfg).Resource(gvr).Create(ctx, widget, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() (bool, string) {
		rt, _ := typeState(c, key)
		return rt.Count == 1, fmt.Sprintf("count %d", rt.Count)
	})

	if err := ext.ApiextensionsV1().CustomResourceDefinitions().Delete(ctx, string(key), metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() (bool, string) {
		rt, ok := typeState(c, key)
		return !ok, fmt.Sprintf("type still indexed: %+v", rt)
	})
}

func TestWatchObjectFollowsOneResource(t *testing.T) {
	c := connect(t)
	cs := kubernetes.NewForConfigOrDie(cfg)
	ns := createNamespace(t, cs)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	eventually(t, func() (bool, string) {
		rt, ok := typeState(c, "configmaps")
		return ok && rt.State == protocol.TypeStateReady, fmt.Sprintf("%+v", rt)
	})

	emits := make(chan protocol.ResourceData, 16)
	ref := protocol.ResourceRef{Cluster: testenv.ClusterID, Type: "configmaps", Namespace: ns, Name: "watched"}
	c.WatchObject(ctx, ref, func(d protocol.ResourceData) { emits <- d }, func(err error) { t.Log("watch error:", err) })

	next := func(want string, match func(protocol.ResourceData) bool) {
		t.Helper()
		timeout := time.After(waitTimeout)
		for {
			select {
			case d := <-emits:
				if match(d) {
					return
				}
			case <-timeout:
				t.Fatalf("no emit matching %q within %s", want, waitTimeout)
			}
		}
	}
	dataValue := func(d protocol.ResourceData) string {
		var obj struct {
			Data map[string]string `json:"data"`
		}
		_ = json.Unmarshal(d.Object, &obj)
		return obj.Data["v"]
	}

	next("missing resource reported as deleted", func(d protocol.ResourceData) bool { return d.Deleted })

	cm := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "watched"}, Data: map[string]string{"v": "1"}}
	if _, err := cs.CoreV1().ConfigMaps(ns).Create(ctx, cm, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	next("created object", func(d protocol.ResourceData) bool { return dataValue(d) == "1" })

	cm.Data["v"] = "2"
	if _, err := cs.CoreV1().ConfigMaps(ns).Update(ctx, cm, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	next("updated object", func(d protocol.ResourceData) bool { return dataValue(d) == "2" })

	if err := cs.CoreV1().ConfigMaps(ns).Delete(ctx, "watched", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	next("deletion", func(d protocol.ResourceData) bool { return d.Deleted })
}

// Types the Cluster refuses to list are marked forbidden instead of being
// retried forever, and are indexed once access is granted.
func TestForbiddenTypesRecoverWhenGranted(t *testing.T) {
	// Refused types are retried by the periodic refresh only.
	timing := testTiming()
	timing.DiscoveryPeriod = time.Second
	c := connectAs(t, testenv.User(t, "limited"), timing)
	eventually(t, func() (bool, string) {
		rt, ok := typeState(c, "configmaps")
		return ok && rt.State == protocol.TypeStateForbidden, fmt.Sprintf("%+v", rt)
	})

	ctx := context.Background()
	rbac := kubernetes.NewForConfigOrDie(cfg).RbacV1()
	role := &rbacv1.ClusterRole{
		ObjectMeta: metav1.ObjectMeta{Name: "read-configmaps"},
		Rules: []rbacv1.PolicyRule{{
			APIGroups: []string{""}, Resources: []string{"configmaps"}, Verbs: []string{"list", "watch"},
		}},
	}
	if _, err := rbac.ClusterRoles().Create(ctx, role, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	binding := &rbacv1.ClusterRoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: "limited-read-configmaps"},
		RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "ClusterRole", Name: role.Name},
		Subjects:   []rbacv1.Subject{{APIGroup: "rbac.authorization.k8s.io", Kind: "User", Name: "limited"}},
	}
	if _, err := rbac.ClusterRoleBindings().Create(ctx, binding, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = rbac.ClusterRoleBindings().Delete(context.Background(), binding.Name, metav1.DeleteOptions{})
		_ = rbac.ClusterRoles().Delete(context.Background(), role.Name, metav1.DeleteOptions{})
	})

	eventually(t, func() (bool, string) {
		rt, _ := typeState(c, "configmaps")
		return rt.State == protocol.TypeStateReady && rt.Count > 0, fmt.Sprintf("%+v", rt)
	})
	if rt, _ := typeState(c, "secrets"); rt.State != protocol.TypeStateForbidden {
		t.Errorf("secrets state = %q, want forbidden", rt.State)
	}
}

// After the first connection, losing and regaining the API server shows in
// the Cluster's status, so clients do not present stale lists as live.
func TestStatusFollowsAPIServerReachability(t *testing.T) {
	timing := testTiming()
	timing.HealthPeriod = 50 * time.Millisecond

	var down atomic.Bool
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if down.Load() {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/version":
			_, _ = w.Write([]byte(`{"gitVersion":"v1.99.0"}`))
		case "/api":
			_, _ = w.Write([]byte(`{"kind":"APIVersions","versions":[]}`))
		case "/apis":
			_, _ = w.Write([]byte(`{"kind":"APIGroupList","apiVersion":"v1","groups":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(api.Close)

	c := connectAs(t, &rest.Config{Host: api.URL}, timing)
	down.Store(true)
	eventually(t, func() (bool, string) {
		s := c.Status()
		return s.Phase == protocol.ClusterPhaseFailed && strings.HasPrefix(s.Message, "Lost connection"), fmt.Sprintf("%+v", s)
	})
	down.Store(false)
	eventually(t, func() (bool, string) {
		s := c.Status()
		return s.Phase == protocol.ClusterPhaseReady && s.ServerVersion == "v1.99.0", fmt.Sprintf("%+v", s)
	})
}

func ptr[T any](v T) *T { return &v }
