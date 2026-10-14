package main

import (
	"flag"
	"io"
	"testing"
	"time"
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

func TestExecFlags(t *testing.T) {
	old := flag.CommandLine
	defer func() { flag.CommandLine = old }()
	for _, tc := range []struct {
		args  []string
		valid bool
	}{
		{nil, true},
		{[]string{"--exec-buffer=16384", "--exec-unattached-timeout=10s"}, true},
		{[]string{"--exec-buffer=4194304"}, true},
		{[]string{"--exec-buffer=16383"}, false},
		{[]string{"--exec-buffer=4194305"}, false},
		{[]string{"--exec-unattached-timeout=9s"}, false},
	} {
		flag.CommandLine = flag.NewFlagSet("hukube-engine", flag.ContinueOnError)
		var o options
		registerOptions(&o)
		if err := flag.CommandLine.Parse(tc.args); err != nil {
			t.Fatal(err)
		}
		if tc.args == nil && (o.execBuffer != 262144 || o.execUnattachedTimeout != 10*time.Minute) {
			t.Fatalf("defaults=%+v", o)
		}
		if err := validateExecOptions(o); (err == nil) != tc.valid {
			t.Fatalf("args=%v valid=%v err=%v", tc.args, tc.valid, err)
		}
	}
}
