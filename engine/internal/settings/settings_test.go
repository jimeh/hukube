package settings

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLongKeyRoundTrip(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	key := "columns/" + strings.Repeat("a", 250-len("columns/"))
	value := json.RawMessage(`{"version":1,"columns":[]}`)
	if err := store.Put(key, value); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(key)
	if err != nil || string(got) != string(value) {
		t.Fatalf("Get = %s, %v; want %s", got, err, value)
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	got, err = reopened.Get(key)
	if err != nil || string(got) != string(value) {
		t.Fatalf("reopened Get = %s, %v; want %s", got, err, value)
	}
}

func TestLongKeysWithSharedPrefix(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	prefix := strings.Repeat("a", 240)
	values := map[string]json.RawMessage{
		prefix + strings.Repeat("b", 20): json.RawMessage(`"first"`),
		prefix + strings.Repeat("c", 20): json.RawMessage(`"second"`),
	}
	for key, value := range values {
		if err := store.Put(key, value); err != nil {
			t.Fatal(err)
		}
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	for key, value := range values {
		got, err := reopened.Get(key)
		if err != nil || string(got) != string(value) {
			t.Fatalf("Get(%q) = %s, %v; want %s", key, got, err, value)
		}
	}
}

func TestShortKeyKeepsFileName(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "columns%2Fpods.json")
	value := json.RawMessage(`{"version":1,"columns":[]}`)
	if err := os.WriteFile(file, value, 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	got, err := store.Get("columns/pods")
	if err != nil || string(got) != string(value) {
		t.Fatalf("existing Get = %s, %v; want %s", got, err, value)
	}
	if err := store.Put("columns/pods", json.RawMessage(`null`)); err != nil {
		t.Fatal(err)
	}
	got, err = os.ReadFile(file)
	if err != nil || string(got) != "null" {
		t.Fatalf("ReadFile = %s, %v; want null", got, err)
	}
}

func TestCompareAndPutInitialAndConcurrent(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	value, rev, err := store.Snapshot("overview/definitions")
	if err != nil || value != nil || rev != "" {
		t.Fatalf("unset snapshot = %s %q %v", value, rev, err)
	}
	changed, stop := store.Watch("overview/definitions")
	defer stop()
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, body := range []string{`{"a":1}`, `{"b":2}`} {
		go func() { <-start; results <- store.CompareAndPut("overview/definitions", json.RawMessage(body), &rev) }()
	}
	close(start)
	successes, conflicts := 0, 0
	for range 2 {
		switch err := <-results; {
		case err == nil:
			successes++
		case errors.Is(err, ErrConflict):
			conflicts++
		default:
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}
	<-changed
	value, revision, err := store.Snapshot("overview/definitions")
	expected := fmt.Sprintf("%x", sha256.Sum256(value))
	if err != nil || revision != expected {
		t.Fatalf("snapshot revision = %q, want %q: %v", revision, expected, err)
	}
	// A refused write neither notifies nor changes the exact byte snapshot.
	next, stopNext := store.Watch("overview/definitions")
	defer stopNext()
	if err := store.CompareAndPut("overview/definitions", json.RawMessage(`null`), &rev); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	select {
	case <-next:
		t.Fatal("conflict notified watchers")
	default:
	}
	value[0] = 'x'
	stored, _, _ := store.Snapshot("overview/definitions")
	if !json.Valid(stored) {
		t.Fatal("snapshot allowed caller to mutate stored bytes")
	}
	if err := store.Put("overview/definitions", json.RawMessage(`null`)); err != nil {
		t.Fatal(err)
	}
	<-next
}
