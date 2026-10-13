package settings

import (
	"encoding/json"
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
