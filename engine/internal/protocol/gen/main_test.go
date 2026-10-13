package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

func TestTypeName(t *testing.T) {
	for _, tt := range []struct {
		typ  reflect.Type
		want string
	}{
		{reflect.TypeFor[protocol.Cluster](), "Cluster"},
		{reflect.TypeFor[[]protocol.ResourceType](), "ResourceType[]"},
		{reflect.TypeFor[protocol.None](), "undefined"},
	} {
		got, err := typeName(tt.typ)
		if err != nil || got != tt.want {
			t.Errorf("typeName(%v) = %q, %v; want %q", tt.typ, got, err, tt.want)
		}
	}
	for _, typ := range []reflect.Type{reflect.TypeFor[string](), reflect.TypeFor[*protocol.Cluster](), reflect.TypeFor[map[string]protocol.Cluster]()} {
		if _, err := typeName(typ); err == nil {
			t.Errorf("accepted unsupported type %v", typ)
		}
	}
}

func TestProtocolHashIgnoresCommentsAndSpacing(t *testing.T) {
	dir := t.TempDir()
	write := func(source string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, "protocol.go"), []byte(source), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("package protocol\n// old\ntype Value struct { Name string `json:\"name\"` }\nconst Phase = \"ready\"\n")
	a, err := protocolHash(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name, source string
		equal        bool
	}{
		{"comments and spacing", "package protocol\n/* new */\ntype Value struct {   Name   string `json:\"name\"` }; const Phase = \"ready\"\n", true},
		{"field", "package protocol\ntype Value struct { Name int `json:\"name\"` }\nconst Phase = \"ready\"\n", false},
		{"tag", "package protocol\ntype Value struct { Name string `json:\"other\"` }\nconst Phase = \"ready\"\n", false},
		{"enum", "package protocol\ntype Value struct { Name string `json:\"name\"` }\nconst Phase = \"failed\"\n", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			write(tt.source)
			b, err := protocolHash(dir)
			if err != nil {
				t.Fatal(err)
			}
			if (a == b) != tt.equal {
				t.Errorf("equal hashes = %v, want %v", (a == b), tt.equal)
			}
		})
	}
}

func TestProtocolHashInputs(t *testing.T) {
	dir := t.TempDir()
	write := func(name, source string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(source), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("protocol.go", "package protocol\nimport \"time\"\ntype Value struct { At time.Time }\n")
	a, err := protocolHash(dir)
	if err != nil {
		t.Fatal(err)
	}
	write("hash.gen.go", "not valid Go")
	write("protocol_test.go", "not valid Go")
	b, err := protocolHash(dir)
	if err != nil || a != b || len(a) != 16 {
		t.Fatalf("hashes = %q, %q; error %v", a, b, err)
	}
	write("methods.go", "package protocol\nconst Method = \"value.get\"\n")
	c, err := protocolHash(dir)
	if err != nil || c == a {
		t.Fatalf("method declaration did not change hash: %q, %v", c, err)
	}
	write("protocol.go", "package protocol\nimport \"github.com/jimeh/hukube/engine/internal/query\"\n")
	if _, err := protocolHash(dir); err == nil {
		t.Fatal("accepted non-standard import")
	}
}
