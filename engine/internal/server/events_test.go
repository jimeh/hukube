package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket/wsjson"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes"

	"github.com/jimeh/hukube/engine/internal/cluster"
	"github.com/jimeh/hukube/engine/internal/protocol"
	"github.com/jimeh/hukube/engine/internal/settings"
	"github.com/jimeh/hukube/engine/internal/testenv"
)

func TestResourceEventsForbiddenRecovers(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	source := testenv.Source{Config: testenv.User(t, "events-limited")}
	store, err := settings.Open("")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.DiscardHandler)
	srv := New(Config{
		Token:    testToken,
		Source:   source,
		Clusters: cluster.NewManager(ctx, source, log),
		Settings: store,
		Log:      log,
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	cs := kubernetes.NewForConfigOrDie(cfg)
	ns, err := cs.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{
			GenerateName: "events-",
		},
	}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	ev, err := cs.CoreV1().Events(ns.Name).Create(ctx, &corev1.Event{
		ObjectMeta: metav1.ObjectMeta{
			Name: "test",
		},
		InvolvedObject: corev1.ObjectReference{
			APIVersion: "v1",
			Kind:       "ConfigMap",
			Namespace:  ns.Name,
			Name:       "target",
		},
		Reason: "Test",
		Type:   "Warning",
	}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	c := mustDial(t, ts)
	c.send(protocol.ClientMessage{
		ID:     1,
		Rev:    1,
		Type:   protocol.ClientTypeSubscribe,
		Method: protocol.TopicResourceEvents.Name,
		Params: params(protocol.ResourceEventsParams{
			Cluster:   testenv.ClusterID,
			Type:      "configmaps",
			Namespace: ns.Name,
			Name:      "target",
		}),
	})
	c.await(1, func(msg protocol.ServerMessage, _ json.RawMessage) bool {
		return msg.Type == protocol.ServerTypeError && msg.Error.Code == protocol.ErrorCodeForbidden
	})
	role, err := cs.RbacV1().ClusterRoles().Create(ctx, &rbacv1.ClusterRole{
		ObjectMeta: metav1.ObjectMeta{
			Name: "read-resource-events",
		},
		Rules: []rbacv1.PolicyRule{
			{
				APIGroups: []string{
					"",
				},
				Resources: []string{
					"events",
				},
				Verbs: []string{
					"list",
					"watch",
				},
			},
		},
	}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	binding, err := cs.RbacV1().ClusterRoleBindings().Create(ctx, &rbacv1.ClusterRoleBinding{
		ObjectMeta: metav1.ObjectMeta{
			Name: "events-limited-read",
		},
		RoleRef: rbacv1.RoleRef{
			APIGroup: "rbac.authorization.k8s.io",
			Kind:     "ClusterRole",
			Name:     role.Name,
		},
		Subjects: []rbacv1.Subject{
			{
				APIGroup: "rbac.authorization.k8s.io",
				Kind:     "User",
				Name:     "events-limited",
			},
		},
	}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cs.RbacV1().ClusterRoleBindings().Delete(context.Background(), binding.Name, metav1.DeleteOptions{})
		_ = cs.RbacV1().ClusterRoles().Delete(context.Background(), role.Name, metav1.DeleteOptions{})
	})
	// Permission changes are observed on the next Events list retry.
	readCtx, readCancel := context.WithTimeout(ctx, 30*time.Second)
	defer readCancel()
	for {
		var msg struct {
			protocol.ServerMessage
			Data json.RawMessage `json:"data"`
		}
		if err := wsjson.Read(readCtx, c.conn, &msg); err != nil {
			t.Fatalf("no recovery data: %v", err)
		}
		if msg.ID != 1 || msg.Type != protocol.ServerTypeData {
			continue
		}
		var d protocol.ResourceEvents
		if err := json.Unmarshal(msg.Data, &d); err != nil {
			t.Fatal(err)
		}
		if d.Total != 1 || d.Warnings != 1 || len(d.Events) != 1 || d.Events[0].UID != string(ev.UID) {
			t.Fatalf("recovery data = %+v", d)
		}
		break
	}
}

func TestKubernetesPermissionErrors(t *testing.T) {
	for _, err := range []error{
		apierrors.NewForbidden(schema.GroupResource{
			Resource: "events",
		}, "", nil),
		apierrors.NewUnauthorized("denied"),
	} {
		if got := toProtocolError(err); got.Code != protocol.ErrorCodeForbidden {
			t.Fatalf("permission error = %+v", got)
		}
	}
}
