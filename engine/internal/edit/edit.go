// Package edit compares Manifests without contacting a Cluster.
package edit

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"
	"slices"
	"strings"

	jsonpatch "github.com/evanphx/json-patch/v5"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

var serverFields = []protocol.FieldPath{
	{"status"}, {"metadata", "managedFields"}, {"metadata", "resourceVersion"},
	{"metadata", "uid"}, {"metadata", "generation"}, {"metadata", "creationTimestamp"},
	{"metadata", "deletionTimestamp"}, {"metadata", "deletionGracePeriodSeconds"}, {"metadata", "selfLink"},
}
var identityFields = []protocol.FieldPath{{"apiVersion"}, {"kind"}, {"metadata", "name"}, {"metadata", "namespace"}}

// Comparison holds the review and the merge patch to send, without its version guard.
type Comparison struct {
	Review    protocol.EditReview
	Effective json.RawMessage
}

// Editable removes fields set by the API server, keeping values as JSON bytes.
func Editable(raw []byte) (json.RawMessage, error) {
	obj, err := object(raw)
	if err != nil {
		return nil, err
	}
	delete(obj, "status")
	if metadata, ok := obj["metadata"]; ok {
		m, err := object(metadata)
		if err != nil {
			return nil, fmt.Errorf("metadata must be an object: %w", err)
		}
		for _, p := range serverFields[1:] {
			delete(m, p[1])
		}
		obj["metadata"], err = json.Marshal(m)
		if err != nil {
			return nil, err
		}
	}
	return json.Marshal(obj)
}

// Compare applies only the user's changes to live and reports concurrent changes.
func Compare(base, manifest, live []byte) (Comparison, error) {
	r := protocol.EditReview{
		Edited: []protocol.FieldPath{}, ChangedOnCluster: []protocol.FieldPath{}, Overlaps: []protocol.FieldPath{},
		SetByCluster: []protocol.FieldPath{}, Ignored: []protocol.FieldPath{}, Warnings: []string{},
	}
	b, err := Editable(base)
	if err != nil {
		return Comparison{}, err
	}
	m, err := Editable(manifest)
	if err != nil {
		return Comparison{}, err
	}
	l, err := Editable(live)
	if err != nil {
		return Comparison{}, err
	}
	mine, err := Diff(b, m)
	if err != nil {
		return Comparison{}, err
	}
	theirs, err := Diff(b, l)
	if err != nil {
		return Comparison{}, err
	}
	desired, err := jsonpatch.MergePatch(l, mine)
	if err != nil {
		return Comparison{}, err
	}
	effective, err := Diff(l, desired)
	if err != nil {
		return Comparison{}, err
	}
	r.Before, r.Desired = l, desired
	r.Edited, r.ChangedOnCluster = Paths(effective), Paths(theirs)
	for _, theirs := range r.ChangedOnCluster {
		for _, mine := range r.Edited {
			if prefix(theirs, mine) || prefix(mine, theirs) {
				r.Overlaps = append(r.Overlaps, theirs)
				break
			}
		}
	}
	for _, p := range serverFields {
		if !equal(at(base, p), at(manifest, p)) {
			r.Ignored = append(r.Ignored, p)
		}
	}
	causes := []protocol.ErrorCause{}
	for _, p := range identityFields {
		if !equal(at(manifest, p), at(live, p)) {
			causes = append(causes, protocol.ErrorCause{Field: strings.Join(p, "."), Reason: "FieldValueInvalid", Message: "This field identifies the Resource and cannot be changed by editing it."})
		}
	}
	if len(causes) > 0 {
		r.Refusal = &protocol.ErrorDetail{Code: protocol.ErrorCodeInvalid, Message: "An edit cannot rename a Resource, move it, or change its kind or API version.", Causes: causes}
	}
	return Comparison{Review: r, Effective: effective}, nil
}

// Diff uses RFC 7386, treating equal numbers with different encodings as equal.
func Diff(before, after []byte) (json.RawMessage, error) {
	normalized := align(before, after)
	return jsonpatch.CreateMergePatch(before, normalized)
}

// align keeps the original encoding of equal values. json-patch compares number
// literals, while a Manifest's 1 and 1.0 describe the same value.
func align(before, after []byte) []byte {
	if equal(before, after) {
		return before
	}
	b, be := object(before)
	a, ae := object(after)
	if be == nil && ae == nil {
		for k, v := range a {
			if old, ok := b[k]; ok {
				a[k] = align(old, v)
			}
		}
		raw, _ := json.Marshal(a)
		return raw
	}
	return after
}

func equal(a, b []byte) bool {
	if len(a) == 0 || len(b) == 0 {
		return len(a) == len(b)
	}
	if bytes.Equal(bytes.TrimSpace(a), bytes.TrimSpace(b)) {
		return true
	}
	var av, bv any
	da, db := json.NewDecoder(bytes.NewReader(a)), json.NewDecoder(bytes.NewReader(b))
	da.UseNumber()
	db.UseNumber()
	if da.Decode(&av) != nil || db.Decode(&bv) != nil {
		return false
	}
	return same(av, bv)
}

func same(a, b any) bool {
	switch a := a.(type) {
	case json.Number:
		b, ok := b.(json.Number)
		if !ok {
			return false
		}
		return number(string(a)) == number(string(b))
	case map[string]any:
		b, ok := b.(map[string]any)
		if !ok || len(a) != len(b) {
			return false
		}
		for k, v := range a {
			other, ok := b[k]
			if !ok || !same(v, other) {
				return false
			}
		}
		return true
	case []any:
		b, ok := b.([]any)
		if !ok || len(a) != len(b) {
			return false
		}
		for i, v := range a {
			if !same(v, b[i]) {
				return false
			}
		}
		return true
	default:
		return a == b
	}
}

// number compares exact decimals without allocating a value as large as its
// exponent. Its input has already been validated by the JSON decoder.
func number(raw string) string {
	sign := ""
	if strings.HasPrefix(raw, "-") {
		sign, raw = "-", raw[1:]
	}
	mantissa, exponent, found := strings.Cut(strings.ToLower(raw), "e")
	scale := new(big.Int)
	if found {
		scale.SetString(exponent, 10)
	}
	whole, fraction, _ := strings.Cut(mantissa, ".")
	digits := strings.TrimLeft(whole+fraction, "0")
	if digits == "" {
		return "0"
	}
	trimmed := strings.TrimRight(digits, "0")
	scale.Add(scale, big.NewInt(int64(len(digits)-len(trimmed)-len(fraction))))
	return sign + trimmed + "e" + scale.String()
}

func object(raw []byte) (map[string]json.RawMessage, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, err
	}
	if obj == nil {
		return nil, fmt.Errorf("manifest must be an object")
	}
	return obj, nil
}

func at(raw []byte, p protocol.FieldPath) []byte {
	for _, k := range p {
		obj, err := object(raw)
		if err != nil {
			return nil
		}
		raw = obj[k]
	}
	return raw
}

// Paths returns sorted leaf paths, treating a list or a removal as one field.
func Paths(patch []byte) []protocol.FieldPath {
	paths := []protocol.FieldPath{}
	var walk func([]byte, protocol.FieldPath)
	walk = func(raw []byte, p protocol.FieldPath) {
		obj, err := object(raw)
		if err != nil {
			paths = append(paths, p)
			return
		}
		if len(obj) == 0 && len(p) > 0 {
			paths = append(paths, p)
			return
		}
		keys := make([]string, 0, len(obj))
		for k := range obj {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		for _, k := range keys {
			walk(obj[k], append(slices.Clone(p), k))
		}
	}
	walk(patch, protocol.FieldPath{})
	return paths
}

func prefix(a, b protocol.FieldPath) bool { return len(a) <= len(b) && slices.Equal(a, b[:len(a)]) }

// WithVersion adds the optimistic concurrency guard to a patch.
func WithVersion(patch []byte, version string) (json.RawMessage, error) {
	guard, err := json.Marshal(map[string]any{"metadata": map[string]string{"resourceVersion": version}})
	if err != nil {
		return nil, err
	}
	return jsonpatch.MergePatch(patch, guard)
}
