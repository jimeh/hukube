package edit

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

func TestComparison(t *testing.T) {
	tests := []struct {
		name, base, mine, live, effective string
		edited, changed, overlaps         []protocol.FieldPath
	}{
		{name: "empty object", base: `{}`, mine: `{"data":{}}`, live: `{}`, effective: `{"data":{}}`, edited: []protocol.FieldPath{{"data"}}},
		{name: "untouched", base: `{"data":{"a":"old","b":"old"}}`, mine: `{"data":{"a":"new","b":"old"}}`, live: `{"data":{"a":"old","b":"theirs"}}`, effective: `{"data":{"a":"new"}}`, edited: []protocol.FieldPath{{"data", "a"}}, changed: []protocol.FieldPath{{"data", "b"}}},
		{name: "removed", base: `{"data":{"a":"old"}}`, mine: `{"data":{}}`, live: `{"data":{"a":"old"}}`, effective: `{"data":{"a":null}}`, edited: []protocol.FieldPath{{"data", "a"}}},
		{name: "list", base: `{"list":[1,2]}`, mine: `{"list":[1,3]}`, live: `{"list":[0,2]}`, effective: `{"list":[1,3]}`, edited: []protocol.FieldPath{{"list"}}, changed: []protocol.FieldPath{{"list"}}, overlaps: []protocol.FieldPath{{"list"}}},
		{name: "same value", base: `{"n":0}`, mine: `{"n":1}`, live: `{"n":1}`, effective: `{}`, changed: []protocol.FieldPath{{"n"}}},
		{name: "overlap above", base: `{"x":{"a":1}}`, mine: `{"x":{"a":2}}`, live: `{"x":null}`, effective: `{"x":{"a":2}}`, edited: []protocol.FieldPath{{"x", "a"}}, changed: []protocol.FieldPath{{"x"}}, overlaps: []protocol.FieldPath{{"x"}}},
		{name: "overlap below", base: `{"x":{"a":1}}`, mine: `{"x":2}`, live: `{"x":{"a":3}}`, effective: `{"x":2}`, edited: []protocol.FieldPath{{"x"}}, changed: []protocol.FieldPath{{"x", "a"}}, overlaps: []protocol.FieldPath{{"x", "a"}}},
		{name: "large exponent", base: `{"n":1e999999999}`, mine: `{"n":10e999999998}`, live: `{"n":1e999999999}`, effective: `{}`},
		{name: "number encoding", base: `{"n":1,"list":[1]}`, mine: `{"n":1.0,"list":[1e0]}`, live: `{"n":1,"list":[1]}`, effective: `{}`},
		{name: "large integer", base: `{"n":9007199254740993,"x":0}`, mine: `{"n":9007199254740993,"x":1}`, live: `{"n":9007199254740993,"x":0}`, effective: `{"x":1}`, edited: []protocol.FieldPath{{"x"}}},
		{name: "different large integers", base: `{"n":9007199254740992}`, mine: `{"n":9007199254740993}`, live: `{"n":9007199254740992}`, effective: `{"n":9007199254740993}`, edited: []protocol.FieldPath{{"n"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, err := Compare([]byte(tt.base), []byte(tt.mine), []byte(tt.live))
			if err != nil {
				t.Fatal(err)
			}
			if !equal(c.Effective, []byte(tt.effective)) {
				t.Fatalf("effective = %s, want %s", c.Effective, tt.effective)
			}
			for _, pair := range []struct {
				name      string
				got, want []protocol.FieldPath
			}{{"edited", c.Review.Edited, tt.edited}, {"changed", c.Review.ChangedOnCluster, tt.changed}, {"overlaps", c.Review.Overlaps, tt.overlaps}} {
				if pair.want == nil {
					pair.want = []protocol.FieldPath{}
				}
				if !reflect.DeepEqual(pair.got, pair.want) {
					t.Errorf("%s = %v, want %v", pair.name, pair.got, pair.want)
				}
			}
			if tt.name == "large integer" && !strings.Contains(string(c.Review.Desired), "9007199254740993") {
				t.Fatalf("untouched integer changed: %s", c.Review.Desired)
			}
		})
	}
}

func TestServerFieldsAndIdentity(t *testing.T) {
	base := []byte(`{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"web","namespace":"ns","uid":"uid","resourceVersion":"1","managedFields":[],"generation":1,"creationTimestamp":"before","deletionTimestamp":null,"deletionGracePeriodSeconds":30,"selfLink":"before"},"status":{"ready":false}}`)
	mine := []byte(strings.NewReplacer(`"uid":"uid"`, `"uid":"other"`, `"resourceVersion":"1"`, `"resourceVersion":"2"`, `"ready":false`, `"ready":true`).Replace(string(base)))
	live := []byte(strings.ReplaceAll(string(base), `"resourceVersion":"1"`, `"resourceVersion":"3"`))
	c, err := Compare(base, mine, live)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Review.Edited) != 0 || len(c.Review.ChangedOnCluster) != 0 || len(c.Review.Ignored) != 3 {
		t.Fatalf("server fields compared: %+v", c.Review)
	}
	var cleaned map[string]json.RawMessage
	if err := json.Unmarshal(c.Review.Before, &cleaned); err != nil {
		t.Fatal(err)
	}
	if _, ok := cleaned["status"]; ok {
		t.Fatal("status still editable")
	}
	var metadata map[string]json.RawMessage
	_ = json.Unmarshal(cleaned["metadata"], &metadata)
	if len(metadata) != 2 {
		t.Fatalf("server metadata still editable: %s", cleaned["metadata"])
	}
	for _, field := range []string{"apiVersion", "kind", "name", "namespace"} {
		t.Run(field, func(t *testing.T) {
			var obj map[string]any
			_ = json.Unmarshal(base, &obj)
			if field == "name" || field == "namespace" {
				obj["metadata"].(map[string]any)[field] = "other"
			} else {
				obj[field] = "other"
			}
			raw, _ := json.Marshal(obj)
			c, err := Compare(base, raw, base)
			if err != nil {
				t.Fatal(err)
			}
			if c.Review.Refusal == nil || c.Review.Refusal.Code != protocol.ErrorCodeInvalid || len(c.Review.Refusal.Causes) != 1 || !strings.HasSuffix(c.Review.Refusal.Causes[0].Field, field) {
				t.Fatalf("identity change not refused: %+v", c.Review.Refusal)
			}
		})
	}
}

func TestComparisonRejectsNonManifests(t *testing.T) {
	for _, raw := range []string{`null`, `[]`, `1`, `{"metadata":null}`, `{`} {
		t.Run(raw, func(t *testing.T) {
			if _, err := Compare([]byte(`{}`), []byte(raw), []byte(`{}`)); err == nil {
				t.Fatal("invalid Manifest accepted")
			}
		})
	}
}
