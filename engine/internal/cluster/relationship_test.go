package cluster

import (
	"context"
	"fmt"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/jimeh/hukube/engine/internal/index"
	"github.com/jimeh/hukube/engine/internal/protocol"
	"github.com/jimeh/hukube/engine/internal/relationship"
	"github.com/jimeh/hukube/engine/internal/testenv"
)

func TestRelationshipFollowsOwnership(t *testing.T) {
	c := connect(t)
	cs := kubernetes.NewForConfigOrDie(cfg)
	ns := createNamespace(t, cs)
	ctx := context.Background()
	deployment, err := cs.AppsV1().Deployments(ns).Create(ctx, &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "web"}, Spec: appsv1.DeploymentSpec{Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "web"}}, Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "web"}}, Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "web", Image: "test"}}}}}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	createRS := func(name string) *appsv1.ReplicaSet {
		t.Helper()
		rs, err := cs.AppsV1().ReplicaSets(ns).Create(ctx, &appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: name, OwnerReferences: []metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "Deployment", Name: deployment.Name, UID: deployment.UID}}}, Spec: appsv1.ReplicaSetSpec{Selector: deployment.Spec.Selector, Template: deployment.Spec.Template}}, metav1.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
		return rs
	}
	createPod := func(name string, rs *appsv1.ReplicaSet) {
		t.Helper()
		_, err := cs.CoreV1().Pods(ns).Create(ctx, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, OwnerReferences: []metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "ReplicaSet", Name: rs.Name, UID: rs.UID}}}, Spec: deployment.Spec.Template.Spec}, metav1.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
	}
	descendants := func(want int) {
		t.Helper()
		eventually(t, func() (bool, string) {
			node, ok := c.Graph.Node("deployments.apps", ns, "web")
			got := c.Graph.AllOwned(node)
			return ok && len(got) == want, fmt.Sprintf("found %v descendants %+v", ok, got)
		})
	}
	first := createRS("first")
	createPod("first-pod", first)
	descendants(2)
	eventually(t, func() (bool, string) {
		pod, ok := c.Graph.Node("pods", ns, "first-pod")
		sections := c.Graph.Related(pod, relationship.DefaultLimits())
		if !ok || len(sections) == 0 {
			return false, "Pod or owners absent"
		}
		rows := sections[0].Rows
		return len(rows) == 3 && rows[0].Kind == "Deployment" && rows[1].Kind == "ReplicaSet" && rows[2].Status == protocol.RelatedStatusSelf, fmt.Sprintf("%+v", rows)
	})
	second := createRS("second")
	createPod("second-pod", second)
	descendants(4)
	if err := cs.AppsV1().ReplicaSets(ns).Delete(ctx, first.Name, metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	descendants(2)
	if err := cs.AppsV1().Deployments(ns).Delete(ctx, deployment.Name, metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() (bool, string) {
		_, ok := c.Graph.Node("deployments.apps", ns, "web")
		return !ok, "owner still indexed"
	})
	deployment.ResourceVersion = ""
	deployment.UID = ""
	deployment.CreationTimestamp = metav1.Time{}
	if _, err := cs.AppsV1().Deployments(ns).Create(ctx, deployment, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	descendants(0)
	eventually(t, func() (bool, string) {
		rs, ok := c.Graph.Node("replicasets.apps", ns, "second")
		owners := c.Graph.Owners(rs)
		return ok && len(owners) == 1 && owners[0].Status == protocol.RelatedStatusMissing, fmt.Sprintf("%+v", owners)
	})
}

func TestRelationshipUnresolvedOwners(t *testing.T) {
	ctx := context.Background()
	cs := kubernetes.NewForConfigOrDie(cfg)
	ns := createNamespace(t, cs)
	user := "relationship-limited"
	role, err := cs.RbacV1().ClusterRoles().Create(ctx, &rbacv1.ClusterRole{ObjectMeta: metav1.ObjectMeta{Name: user}, Rules: []rbacv1.PolicyRule{{APIGroups: []string{""}, Resources: []string{"configmaps"}, Verbs: []string{"list", "watch"}}}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	binding, err := cs.RbacV1().ClusterRoleBindings().Create(ctx, &rbacv1.ClusterRoleBinding{ObjectMeta: metav1.ObjectMeta{Name: user}, RoleRef: rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "ClusterRole", Name: role.Name}, Subjects: []rbacv1.Subject{{APIGroup: "rbac.authorization.k8s.io", Kind: "User", Name: user}}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cs.RbacV1().ClusterRoleBindings().Delete(ctx, binding.Name, metav1.DeleteOptions{})
		_ = cs.RbacV1().ClusterRoles().Delete(ctx, role.Name, metav1.DeleteOptions{})
	})
	c := connectAs(t, testenv.User(t, user), testTiming())
	_, err = cs.CoreV1().ConfigMaps(ns).Create(ctx, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "dependent", OwnerReferences: []metav1.OwnerReference{{APIVersion: "v1", Kind: "ConfigMap", Name: "gone", UID: "gone"}, {APIVersion: "legacy/v1", Kind: "Gadget", Name: "unknown", UID: "unknown"}, {APIVersion: "apps/v1", Kind: "Deployment", Name: "refused", UID: "refused"}}}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, func() (bool, string) {
		node, ok := c.Graph.Node("configmaps", ns, "dependent")
		owners := c.Graph.Owners(node)
		statuses := map[protocol.RelatedStatus]bool{}
		for _, o := range owners {
			statuses[o.Status] = true
		}
		return ok && len(owners) == 3 && statuses[protocol.RelatedStatusMissing] && statuses[protocol.RelatedStatusUnserved] && statuses[protocol.RelatedStatusForbidden], fmt.Sprintf("%+v", owners)
	})
}

func TestRelationshipKindLookup(t *testing.T) {
	c := &Cluster{types: map[protocol.TypeKey]*indexedType{"z.example": {info: protocol.ResourceType{Key: "z.example", Group: "example", Kind: "Thing"}}, "a.example": {info: protocol.ResourceType{Key: "a.example", Group: "example", Kind: "Thing"}}}}
	c.rebuildKinds()
	got, ok := c.TypeForKind("example", "Thing")
	if !ok || got.Key != "a.example" {
		t.Fatalf("kind lookup = %+v, %v", got, ok)
	}
	delete(c.types, "a.example")
	c.rebuildKinds()
	got, ok = c.TypeForKind("example", "Thing")
	if !ok || got.Key != "z.example" {
		t.Fatalf("rebuilt kind lookup = %+v, %v", got, ok)
	}
	delete(c.types, "z.example")
	c.rebuildKinds()
	if _, ok := c.TypeForKind("example", "Thing"); ok {
		t.Fatal("removed kind still served")
	}
}

func TestToMetaCopiesOwners(t *testing.T) {
	obj := &metav1.PartialObjectMetadata{ObjectMeta: metav1.ObjectMeta{OwnerReferences: []metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "ReplicaSet", Name: "owner", UID: "uid", Controller: ptr(true)}}}}
	m, err := toMeta(obj)
	if err != nil {
		t.Fatal(err)
	}
	obj.OwnerReferences[0].Name = "changed"
	if len(m.Owners) != 1 || m.Owners[0] != (index.OwnerRef{APIVersion: "apps/v1", Kind: "ReplicaSet", Name: "owner", UID: "uid", Controller: true}) {
		t.Fatalf("copied owners = %+v", m.Owners)
	}
	empty, err := toMeta(&metav1.PartialObjectMetadata{})
	if err != nil || empty.Owners != nil {
		t.Fatalf("empty owners = %+v, %v", empty.Owners, err)
	}
}
