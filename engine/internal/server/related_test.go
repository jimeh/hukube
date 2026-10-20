package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/jimeh/hukube/engine/internal/cluster"
	"github.com/jimeh/hukube/engine/internal/notify"
	"github.com/jimeh/hukube/engine/internal/protocol"
	"github.com/jimeh/hukube/engine/internal/settings"
	"github.com/jimeh/hukube/engine/internal/testenv"
)

func TestRelatedTopicLimitsAndCells(t *testing.T) {
	ctx := context.Background()
	cs := kubernetes.NewForConfigOrDie(cfg)
	ns, err := cs.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{GenerateName: "related-"}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	owner, err := cs.CoreV1().ConfigMaps(ns.Name).Create(ctx, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "owner"}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var child *corev1.ConfigMap
	for i := 0; i < 101; i++ {
		cm, err := cs.CoreV1().ConfigMaps(ns.Name).Create(ctx, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("child-%03d", i), OwnerReferences: []metav1.OwnerReference{{APIVersion: "v1", Kind: "ConfigMap", Name: owner.Name, UID: owner.UID}}}, Data: map[string]string{"a": "1"}}, metav1.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if i == 50 {
			child = cm
		}
	}
	c := mustDial(t, newTestServer(t))
	p := protocol.RelatedParams{Cluster: testenv.ClusterID, Type: "configmaps", Namespace: ns.Name, Name: owner.Name}
	c.send(protocol.ClientMessage{ID: 1, Rev: 1, Type: protocol.ClientTypeSubscribe, Method: protocol.TopicResourceRelated.Name, Params: params(p)})
	await := func(rev uint64, cells bool, want any) {
		t.Helper()
		c.await(1, func(m protocol.ServerMessage, raw json.RawMessage) bool {
			if m.Type != protocol.ServerTypeData || m.Rev != rev {
				return false
			}
			var v protocol.Related
			if err := json.Unmarshal(raw, &v); err != nil {
				t.Fatal(err)
			}
			if v.Total != 101 {
				return false
			}
			if !v.Found || len(v.Sections) != 1 || v.Sections[0].Total != 101 || len(v.Sections[0].Rows) != 101 {
				t.Fatalf("Related shape = %+v", v)
			}
			rows := v.Sections[0].Rows
			last := rows[100]
			if last.Status != protocol.RelatedStatusMore || last.More != 1 {
				t.Fatalf("more row = %+v", last)
			}
			if !cells {
				if len(v.Types) != 0 {
					t.Fatalf("without cells: types %+v", v.Types)
				}
				for _, r := range rows {
					if len(r.Cells) != 0 {
						t.Fatal("cells present when not requested")
					}
				}
				if !strings.Contains(string(raw), `"types":[]`) {
					t.Fatalf("empty types encoded as null: %s", raw)
				}
				return true
			}
			if len(v.Types) != 1 || len(v.Types[0].Columns) != 1 {
				return false
			}
			if v.Types[0].Type != "configmaps" || v.Types[0].Columns[0].Name != "Data" || v.Types[0].Columns[0].Priority != 0 {
				t.Fatalf("columns = %+v", v.Types)
			}
			targetFound := false
			for _, r := range rows[:100] {
				if len(r.Cells) != 1 {
					return false
				}
				if r.Name == child.Name {
					targetFound = true
					if r.Cells[0] != want {
						return false
					}
				}
			}
			return targetFound
		})
	}
	await(1, false, nil)
	p.Cells = true
	c.send(protocol.ClientMessage{ID: 1, Rev: 2, Type: protocol.ClientTypeUpdate, Params: params(p)})
	await(2, true, float64(1))
	child.Data["b"] = "2"
	if _, err := cs.CoreV1().ConfigMaps(ns.Name).Update(ctx, child, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	await(2, true, float64(2))
	p.Cells = false
	c.send(protocol.ClientMessage{ID: 1, Rev: 3, Type: protocol.ClientTypeUpdate, Params: params(p)})
	await(3, false, nil)
	p.Name = "missing"
	c.send(protocol.ClientMessage{ID: 1, Rev: 4, Type: protocol.ClientTypeUpdate, Params: params(p)})
	c.await(1, func(m protocol.ServerMessage, raw json.RawMessage) bool {
		if m.Rev != 4 || m.Type != protocol.ServerTypeData {
			return false
		}
		var v protocol.Related
		_ = json.Unmarshal(raw, &v)
		if v.Found || v.Total != 0 || len(v.Sections) != 0 || len(v.Types) != 0 {
			t.Fatalf("missing = %+v", v)
		}
		if !strings.Contains(string(raw), `"sections":[]`) {
			t.Fatalf("empty sections encoded as null: %s", raw)
		}
		return true
	})
}

func TestRelatedTopicForbidden(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	source := testenv.Source{Config: testenv.User(t, "related-topic-limited")}
	store, err := settings.Open("")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.DiscardHandler)
	srv := New(Config{Token: testToken, Source: source, Clusters: cluster.NewManager(ctx, source, log), Settings: store, Log: log})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	c := mustDial(t, ts)
	c.send(protocol.ClientMessage{ID: 1, Type: protocol.ClientTypeSubscribe, Method: protocol.TopicResourceRelated.Name, Params: params(protocol.RelatedParams{Cluster: testenv.ClusterID, Type: "configmaps", Namespace: "default", Name: "anything", Cells: true})})
	c.await(1, func(m protocol.ServerMessage, _ json.RawMessage) bool {
		return m.Type == protocol.ServerTypeError && m.Error.Code == protocol.ErrorCodeForbidden
	})
}

type relatedStateFixture struct {
	typ   protocol.ResourceType
	known bool
	phase protocol.ClusterPhase
}

func (f relatedStateFixture) Type(protocol.TypeKey) (protocol.ResourceType, bool) {
	return f.typ, f.known
}
func (f relatedStateFixture) Status() protocol.ClusterStatus {
	return protocol.ClusterStatus{Phase: f.phase}
}
func TestRelatedTopicStates(t *testing.T) {
	for _, tc := range []struct {
		name         string
		known, found bool
		phase        protocol.ClusterPhase
		state        protocol.TypeState
		send         bool
		code         protocol.ErrorCode
	}{
		{name: "unknown connecting", phase: protocol.ClusterPhaseConnecting},
		{name: "unknown failed", phase: protocol.ClusterPhaseFailed},
		{name: "unknown ready", phase: protocol.ClusterPhaseReady, code: protocol.ErrorCodeNotFound},
		{name: "forbidden", known: true, state: protocol.TypeStateForbidden, code: protocol.ErrorCodeForbidden},
		{name: "failed", known: true, state: protocol.TypeStateFailed, code: protocol.ErrorCodeInternal},
		{name: "syncing absent", known: true, state: protocol.TypeStateSyncing},
		{name: "syncing present", known: true, found: true, state: protocol.TypeStateSyncing, send: true},
		{name: "ready absent", known: true, state: protocol.TypeStateReady, send: true},
		{name: "ready present", known: true, found: true, state: protocol.TypeStateReady, send: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ok, err := relatedState(relatedStateFixture{typ: protocol.ResourceType{State: tc.state}, known: tc.known, phase: tc.phase}, protocol.RelatedParams{Type: "pods"}, tc.found)
			if ok != tc.send {
				t.Fatalf("send = %v, want %v", ok, tc.send)
			}
			if tc.code == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				if err == nil || toProtocolError(err).Code != tc.code {
					t.Fatalf("error = %v, want %s", err, tc.code)
				}
				if tc.state == protocol.TypeStateFailed && !strings.Contains(err.Error(), "pods") {
					t.Fatal("failure does not name type")
				}
			}
		})
	}
}

func TestRelatedTableChoice(t *testing.T) {
	rows := []protocol.RelatedRow{}
	for i := 0; i < 8; i++ {
		for j := 0; j < i+1; j++ {
			rows = append(rows, protocol.RelatedRow{Type: protocol.TypeKey(fmt.Sprint(i)), Status: protocol.RelatedStatusFound})
		}
	}
	for i := 0; i < 100; i++ {
		rows = append(rows, protocol.RelatedRow{Type: "ignore", Status: protocol.RelatedStatusMore})
	}
	got := relatedTableTypes([]protocol.RelatedSection{{Rows: rows}})
	if !slices.Equal(got, []protocol.TypeKey{"2", "3", "4", "5", "6", "7"}) {
		t.Fatalf("most rows: %v", got)
	}
	rows = []protocol.RelatedRow{}
	for _, key := range []protocol.TypeKey{"z", "a", "c", "b", "d", "e", "f"} {
		rows = append(rows, protocol.RelatedRow{Type: key, Status: protocol.RelatedStatusSelf})
	}
	got = relatedTableTypes([]protocol.RelatedSection{{Rows: rows}})
	if !slices.Equal(got, []protocol.TypeKey{"a", "b", "c", "d", "e", "f"}) {
		t.Fatalf("tie by type key: %v", got)
	}
}

type fakeRelatedTable struct{ changed notify.Signal }

func (f *fakeRelatedTable) Changed() (<-chan struct{}, func()) { return f.changed.Subscribe() }
func (f *fakeRelatedTable) Read(fn func([]protocol.Column, func(string) []any)) {
	fn([]protocol.Column{{Name: "Wide", Priority: 1}, {Name: "Data", Priority: 0}}, func(key string) []any {
		if key == "ns/child" {
			return []any{"wide", 3}
		}
		return nil
	})
}
func TestRelatedTablesLifecycle(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		changes := make(chan struct{}, 20)
		acquired, released := map[protocol.TypeKey]int{}, map[protocol.TypeKey]int{}
		fake := &fakeRelatedTable{}
		ts := relatedTables{ctx: t.Context(), notify: func() { changes <- struct{}{} }, held: make(map[protocol.TypeKey]relatedTable), acquire: func(key protocol.TypeKey) (relatedWatch, func()) {
			acquired[key]++
			return fake, func() { released[key]++ }
		}}
		value := func(key protocol.TypeKey) protocol.Related {
			return protocol.Related{Types: []protocol.RelatedType{}, Sections: []protocol.RelatedSection{{Rows: []protocol.RelatedRow{{Type: key, Namespace: "ns", Name: "child", Status: protocol.RelatedStatusFound}, {Type: key, Name: "missing", Status: protocol.RelatedStatusMissing}, {Type: key, Name: "no-cells", Status: protocol.RelatedStatusSelf}}}}}
		}
		first := value("pods")
		ts.attach(&first)
		if len(first.Types) != 1 || !slices.Equal(first.Types[0].Columns, []protocol.Column{{Name: "Data"}}) || !slices.Equal(first.Sections[0].Rows[0].Cells, []any{3}) || first.Sections[0].Rows[1].Cells != nil || first.Sections[0].Rows[2].Cells != nil {
			t.Fatalf("filtered cells = %+v", first)
		}
		fake.changed.Notify()
		select {
		case <-changes:
		case <-time.After(time.Second):
			t.Fatal("Table change not forwarded")
		}
		again := value("pods")
		ts.attach(&again)
		if acquired["pods"] != 1 {
			t.Fatal("unchanged rows reacquired Table")
		}
		next := value("configmaps")
		ts.attach(&next)
		if released["pods"] != 1 || acquired["configmaps"] != 1 {
			t.Fatalf("rows changed: acquired %v released %v", acquired, released)
		}
		ts.stop()
		ts.stop()
		if released["configmaps"] != 1 || len(ts.held) != 0 {
			t.Fatalf("stop: held %v released %v", ts.held, released)
		}
		synctest.Wait()
		for len(changes) > 0 {
			<-changes
		}
		fake.changed.Notify()
		synctest.Wait()
		if len(changes) > 0 {
			t.Fatal("stopped Tables still forward changes")
		}
	})
}
