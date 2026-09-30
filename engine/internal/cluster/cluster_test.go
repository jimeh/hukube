package cluster

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
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
	discoveryDelay = 100 * time.Millisecond
	objectRetry = 100 * time.Millisecond
	os.Exit(testenv.Run(m, &cfg))
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
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m := NewManager(ctx, testenv.Source{Config: cfg}, slog.New(slog.DiscardHandler))
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
	err := c.WatchObject(ctx, ref, func(d protocol.ResourceData) { emits <- d }, func(err error) { t.Log("watch error:", err) })
	if err != nil {
		t.Fatal(err)
	}

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

func ptr[T any](v T) *T { return &v }
