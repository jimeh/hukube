package main

import (
	"flag"
	"io"
	"testing"
)

func TestReadOnlyFlag(t *testing.T) {
	old := flag.CommandLine
	defer func() { flag.CommandLine = old }()
	for _, args := range [][]string{nil, {"--read-only"}} {
		flag.CommandLine = flag.NewFlagSet("hukube-engine", flag.ContinueOnError)
		flag.CommandLine.SetOutput(io.Discard)
		var o options
		registerOptions(&o)
		if err := flag.CommandLine.Parse(args); err != nil {
			t.Fatal(err)
		}
		if o.readOnly != (len(args) > 0) {
			t.Fatalf("--read-only = %v, args %v", o.readOnly, args)
		}
	}
}
