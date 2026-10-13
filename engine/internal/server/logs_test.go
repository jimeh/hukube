package server

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"slices"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/jimeh/hukube/engine/internal/cluster"
	"github.com/jimeh/hukube/engine/internal/protocol"
	"github.com/jimeh/hukube/engine/internal/settings"
	"github.com/jimeh/hukube/engine/internal/testenv"
)

func logNamespace(t *testing.T, cs kubernetes.Interface) string {
	t.Helper()
	ns, err := cs.CoreV1().Namespaces().Create(context.Background(), &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{GenerateName: "logs-"}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cs.CoreV1().Namespaces().Delete(context.Background(), ns.Name, metav1.DeleteOptions{}) })
	return ns.Name
}
func createLogPod(t *testing.T, cs kubernetes.Interface, ns, name string, owners ...metav1.OwnerReference) *corev1.Pod {
	t.Helper()
	p, err := cs.CoreV1().Pods(ns).Create(context.Background(), &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, OwnerReferences: owners}, Spec: corev1.PodSpec{NodeName: "node", Containers: []corev1.Container{{Name: "main", Image: "busybox:1.36"}}}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	p.Status.ContainerStatuses = []corev1.ContainerStatus{{Name: "main", ContainerID: "container-1", State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}}
	p, err = cs.CoreV1().Pods(ns).UpdateStatus(context.Background(), p, metav1.UpdateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func openLogs(c *streamClient, p protocol.LogStreamParams) {
	c.send(protocol.StreamClientMessage{Type: protocol.StreamClientTypeOpen, Method: protocol.StreamResourceLogs.Name, Params: params(p)})
}
func logParams(p *corev1.Pod) protocol.LogStreamParams {
	return protocol.LogStreamParams{Cluster: testenv.ClusterID, Type: "pods", Namespace: p.Namespace, Name: p.Name, UID: string(p.UID)}
}

type wireLog struct {
	source  int
	flags   byte
	time    int64
	content string
}

func logRecords(frame []byte) []wireLog {
	records := []wireLog{}
	if len(frame) == 0 || frame[0] != protocol.StreamChannelStdout {
		return records
	}
	for b := frame[1:]; len(b) >= protocol.LogRecordHeaderSize; {
		n := int(binary.BigEndian.Uint32(b[11:15]))
		records = append(records, wireLog{int(binary.BigEndian.Uint16(b)), b[2], int64(binary.BigEndian.Uint64(b[3:11])), string(b[15 : 15+n])})
		b = b[15+n:]
	}
	return records
}
func awaitLogStatus(c *streamClient, match func(protocol.LogStreamStatus) bool) protocol.LogStreamStatus {
	c.t.Helper()
	for {
		m, _ := c.read(true)
		if m.End != nil {
			c.t.Fatalf("ended before matching status: %+v", m.End)
		}
		if m.Type == protocol.StreamServerTypeEvent {
			b, _ := json.Marshal(m.Event)
			var s protocol.LogStreamStatus
			_ = json.Unmarshal(b, &s)
			if match(s) {
				return s
			}
		}
	}
}
func awaitLogEnd(c *streamClient) protocol.StreamEnd {
	c.t.Helper()
	for {
		m, _ := c.read(true)
		if m.End != nil {
			return *m.End
		}
	}
}
func replaceLogOpener(t *testing.T, open func(*cluster.Cluster, context.Context, string, string, *corev1.PodLogOptions) (io.ReadCloser, error)) {
	t.Helper()
	old := openPodLogs
	openPodLogs = open
	t.Cleanup(func() { openPodLogs = old })
}

func TestResourceLogsMergeAndRollout(t *testing.T) {
	cs := kubernetes.NewForConfigOrDie(cfg)
	ns := logNamespace(t, cs)
	ctx := context.Background()
	deployment, err := cs.AppsV1().Deployments(ns).Create(ctx, &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "workload"}, Spec: appsv1.DeploymentSpec{Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "logs"}}, Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "logs"}}, Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "main", Image: "busybox:1.36"}}}}}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	newRS := func(name string) *appsv1.ReplicaSet {
		t.Helper()
		rs, err := cs.AppsV1().ReplicaSets(ns).Create(ctx, &appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: name, OwnerReferences: []metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "Deployment", Name: deployment.Name, UID: deployment.UID}}}, Spec: appsv1.ReplicaSetSpec{Selector: deployment.Spec.Selector, Template: deployment.Spec.Template}}, metav1.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
		return rs
	}
	rs := newRS("old")
	owner := func(rs *appsv1.ReplicaSet) metav1.OwnerReference {
		return metav1.OwnerReference{APIVersion: "apps/v1", Kind: "ReplicaSet", Name: rs.Name, UID: rs.UID}
	}
	a := createLogPod(t, cs, ns, "a", owner(rs))
	createLogPod(t, cs, ns, "b", owner(rs))
	replaceLogOpener(t, func(_ *cluster.Cluster, ctx context.Context, _, name string, _ *corev1.PodLogOptions) (io.ReadCloser, error) {
		reader, writer := io.Pipe()
		go func() {
			n := 2
			if name == "a" {
				n = 3
			}
			_, _ = fmt.Fprintf(writer, "2026-01-01T00:00:00.%09dZ %s\n", n, name)
			<-ctx.Done()
			_ = writer.Close()
		}()
		return reader, nil
	})
	c := dialStream(t, newTestServer(t))
	p := protocol.LogStreamParams{Cluster: testenv.ClusterID, Type: "deployments.apps", Namespace: ns, Name: deployment.Name, UID: string(deployment.UID)}
	openLogs(c, p)
	seen := []wireLog{}
	for len(seen) < 2 {
		m, frame := c.read(true)
		if m.End != nil {
			t.Fatalf("merge ended: %+v", m.End)
		}
		if frame != nil {
			seen = append(seen, logRecords(frame)...)
		}
	}
	if seen[0].content != "b" || seen[1].content != "a" {
		t.Fatalf("workload records not merged by timestamp: %+v", seen)
	}
	newReplicaSet := newRS("new")
	createLogPod(t, cs, ns, "c", owner(newReplicaSet))
	zero := int64(0)
	if err := cs.CoreV1().Pods(ns).Delete(ctx, a.Name, metav1.DeleteOptions{GracePeriodSeconds: &zero, Preconditions: &metav1.Preconditions{UID: &a.UID}}); err != nil {
		t.Fatal(err)
	}
	s := awaitLogStatus(c, func(s protocol.LogStreamStatus) bool {
		names := []string{}
		for _, source := range s.Sources {
			names = append(names, source.Pod)
		}
		return s.Followed == 2 && s.Pods == 2 && slices.Contains(names, "c") && !slices.Contains(names, "a")
	})
	if len(s.Sources) != 2 {
		t.Fatalf("rollout sources=%+v", s)
	}
}

func TestResourceLogsDeletionAndUID(t *testing.T) {
	cs := kubernetes.NewForConfigOrDie(cfg)
	ns := logNamespace(t, cs)
	p := createLogPod(t, cs, ns, "target")
	replaceLogOpener(t, func(_ *cluster.Cluster, ctx context.Context, _, _ string, _ *corev1.PodLogOptions) (io.ReadCloser, error) {
		r, w := io.Pipe()
		go func() { <-ctx.Done(); _ = w.Close() }()
		return r, nil
	})
	c := dialStream(t, newTestServer(t))
	openLogs(c, logParams(p))
	awaitLogStatus(c, func(s protocol.LogStreamStatus) bool { return len(s.Sources) == 1 && s.Sources[0].Instance != "" })
	zero := int64(0)
	if err := cs.CoreV1().Pods(ns).Delete(context.Background(), p.Name, metav1.DeleteOptions{GracePeriodSeconds: &zero}); err != nil {
		t.Fatal(err)
	}
	if e := awaitLogEnd(c); e.Reason != protocol.StreamEndReasonDeleted {
		t.Fatalf("deleted Pod end=%+v", e)
	}
	replacement := createLogPod(t, cs, ns, "target")
	wrong := logParams(replacement)
	wrong.UID = string(types.UID("old-incarnation"))
	c = dialStream(t, newTestServer(t))
	openLogs(c, wrong)
	if e := awaitLogEnd(c); e.Reason != protocol.StreamEndReasonDeleted {
		t.Fatalf("wrong UID end=%+v", e)
	}
}

func testLogServer(t *testing.T, config *rest.Config) *httptest.Server {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	source := testenv.Source{Config: config}
	store, err := settings.Open("")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.DiscardHandler)
	srv := New(Config{Token: testToken, Source: source, Clusters: cluster.NewManager(ctx, source, log), Settings: store, Log: log})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func TestResourceLogsForbidden(t *testing.T) {
	cs := kubernetes.NewForConfigOrDie(cfg)
	ns := logNamespace(t, cs)
	p := createLogPod(t, cs, ns, "target")
	for _, allowPods := range []bool{true, false} {
		t.Run(fmt.Sprint(allowPods), func(t *testing.T) {
			user := fmt.Sprintf("logs-user-%t", allowPods)
			config := testenv.User(t, user)
			if allowPods {
				role, err := cs.RbacV1().ClusterRoles().Create(context.Background(), &rbacv1.ClusterRole{ObjectMeta: metav1.ObjectMeta{GenerateName: "logs-pods-"}, Rules: []rbacv1.PolicyRule{{APIGroups: []string{""}, Resources: []string{"pods"}, Verbs: []string{"get", "list", "watch"}}}}, metav1.CreateOptions{})
				if err != nil {
					t.Fatal(err)
				}
				binding, err := cs.RbacV1().ClusterRoleBindings().Create(context.Background(), &rbacv1.ClusterRoleBinding{ObjectMeta: metav1.ObjectMeta{GenerateName: "logs-pods-"}, RoleRef: rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "ClusterRole", Name: role.Name}, Subjects: []rbacv1.Subject{{Kind: "User", APIGroup: rbacv1.GroupName, Name: user}}}, metav1.CreateOptions{})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					_ = cs.RbacV1().ClusterRoleBindings().Delete(context.Background(), binding.Name, metav1.DeleteOptions{})
					_ = cs.RbacV1().ClusterRoles().Delete(context.Background(), role.Name, metav1.DeleteOptions{})
				})
			}
			// This test uses the real dedicated log client. envtest's API server
			// rejects pods/log authorization before it would contact a kubelet.
			c := dialStream(t, testLogServer(t, config))
			openLogs(c, logParams(p))
			e := awaitLogEnd(c)
			if e.Reason != protocol.StreamEndReasonError || e.Error == nil || e.Error.Code != protocol.ErrorCodeForbidden {
				t.Fatalf("log permission refusal=%+v", e)
			}
			if want := "Your credentials cannot read Pod logs in the " + ns + " Namespace."; allowPods && e.Error.Message != want {
				t.Fatalf("refusal message=%q, want %q", e.Error.Message, want)
			}
		})
	}
}
