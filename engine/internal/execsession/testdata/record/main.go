// Command record makes the recordings in ../recordings: it runs scripted Exec
// Sessions against the e2e cluster through client-go's executor, as the Engine
// does, and writes what each one printed. It lives under testdata so that it
// is not built with the Engine. README.md beside the recordings says how to
// run it.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/remotecommand"
	"k8s.io/streaming/pkg/httpstream"
)

type step struct {
	send   string
	wait   time.Duration
	resize [2]uint16
	mark   string
	// quiet waits until no output has arrived for this long.
	quiet time.Duration
}

type scenario struct {
	name, pod string
	command   []string
	steps     []step
}

type recorder struct {
	mu    sync.Mutex
	start time.Time
	file  *os.File
	last  time.Time
	bytes int
}

func (r *recorder) line(v map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v["t"] = time.Since(r.start).Milliseconds()
	data, _ := json.Marshal(v)
	_, _ = r.file.Write(append(data, '\n'))
}

func (r *recorder) Write(p []byte) (int, error) {
	r.line(map[string]any{"o": base64.StdEncoding.EncodeToString(p)})
	r.mu.Lock()
	r.last = time.Now()
	r.bytes += len(p)
	r.mu.Unlock()
	return len(p), nil
}

func (r *recorder) quiet(d time.Duration) {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		idle := time.Since(r.last)
		r.mu.Unlock()
		if idle >= d {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

type sizes chan remotecommand.TerminalSize

func (s sizes) Next() *remotecommand.TerminalSize {
	size, ok := <-s
	if !ok {
		return nil
	}
	return &size
}

type input struct{ ch chan []byte }

func (i *input) Read(p []byte) (int, error) {
	data, ok := <-i.ch
	if !ok {
		return 0, fmt.Errorf("closed")
	}
	return copy(p, data), nil
}

// nudges measures what a resize does: one to the same size, then one row
// fewer, then back.
func nudges(cols, rows uint16) []step {
	return []step{
		{quiet: 400 * time.Millisecond},
		{mark: "before-same"},
		{resize: [2]uint16{cols, rows}},
		{wait: 1200 * time.Millisecond},
		{mark: "after-same"},
		{resize: [2]uint16{cols, rows - 1}},
		{wait: 1200 * time.Millisecond},
		{mark: "after-shrink"},
		{resize: [2]uint16{cols, rows}},
		{wait: 1200 * time.Millisecond},
		{mark: "after-restore"},
		// Both at once, as the Engine would send a nudge.
		{resize: [2]uint16{cols, rows - 1}},
		{resize: [2]uint16{cols, rows}},
		{wait: 1500 * time.Millisecond},
		{mark: "after-nudge"},
	}
}

func scenarios() []scenario {
	const cols, rows = 80, 24
	var out []scenario
	shells := []struct{ pod, name string }{{"bb", "busybox"}, {"full", "alpine"}}
	for _, s := range shells {
		shell := []string{"sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"}
		prep := step{send: "seq 1 300 | sed 's/$/ the quick brown fox jumps over the lazy dog/' > /tmp/n.txt\r", wait: 400 * time.Millisecond}
		add := func(name string, steps ...step) {
			out = append(out, scenario{name: s.name + "-" + name, pod: s.pod, command: shell, steps: append([]step{{quiet: 500 * time.Millisecond}, prep}, steps...)})
		}
		vi := []step{{send: "vi /tmp/n.txt\r", wait: 800 * time.Millisecond}, {mark: "painted"}}
		// Cursor movement that paints nothing new: left and right on one line.
		for i := 0; i < 40; i++ {
			vi = append(vi, step{send: strings.Repeat("l", 20) + strings.Repeat("h", 20), wait: 30 * time.Millisecond})
		}
		vi = append(vi, nudges(cols, rows)...)
		vi = append(vi, step{send: "\x1b", wait: 300 * time.Millisecond}, step{send: ":q!\r", wait: 500 * time.Millisecond}, step{mark: "left"}, step{send: "exit\r", wait: 300 * time.Millisecond})
		// The alpine image's vi is busybox's too. Its vim is recorded below.
		if s.pod == "bb" {
			add("vi", vi...)
		}

		less := []step{{send: "less /tmp/n.txt\r", wait: 800 * time.Millisecond}, {mark: "painted"}}
		for i := 0; i < 30; i++ {
			less = append(less, step{send: "j", wait: 30 * time.Millisecond})
		}
		less = append(less, nudges(cols, rows)...)
		less = append(less, step{send: "q", wait: 400 * time.Millisecond}, step{mark: "left"}, step{send: "exit\r", wait: 300 * time.Millisecond})
		add("less", less...)

		top := []step{{send: "top -d 1\r", wait: 2500 * time.Millisecond}, {mark: "painted"}}
		top = append(top, nudges(cols, rows)...)
		top = append(top, step{send: "q", wait: 400 * time.Millisecond}, step{mark: "left"}, step{send: "exit\r", wait: 300 * time.Millisecond})
		add("top", top...)

		line := []step{{send: "echo one; echo two\r", wait: 300 * time.Millisecond}, {send: "echo hello wor", wait: 300 * time.Millisecond}, {mark: "painted"}}
		line = append(line, nudges(cols, rows)...)
		line = append(line, step{send: "ld\r", wait: 400 * time.Millisecond}, step{mark: "left"}, step{send: "exit\r", wait: 300 * time.Millisecond})
		add("midline", line...)

		add("progress",
			step{send: "i=0; while [ $i -le 400 ]; do printf '\\r[%-40s] %3d%%' \"$(printf '%*s' $((i/10)) '' | tr ' ' '#')\" $((i/4)); i=$((i+1)); sleep 0.005; done; echo\r", wait: 500 * time.Millisecond},
			step{quiet: 800 * time.Millisecond},
			step{mark: "painted"},
			step{send: "exit\r", wait: 300 * time.Millisecond})
	}
	htop := []step{{quiet: 500 * time.Millisecond}, {send: "htop\r", wait: 2500 * time.Millisecond}, {mark: "painted"}}
	htop = append(htop, nudges(cols, rows)...)
	htop = append(htop, step{send: "q", wait: 400 * time.Millisecond}, step{mark: "left"}, step{send: "exit\r", wait: 300 * time.Millisecond})
	out = append(out, scenario{name: "alpine-htop", pod: "full", command: []string{"bash"}, steps: htop})
	vim := []step{{quiet: 500 * time.Millisecond}, {send: "seq 1 300 | sed 's/$/ the quick brown fox jumps over the lazy dog/' > /tmp/n.txt\r", wait: 400 * time.Millisecond}, {send: "vim /tmp/n.txt\r", wait: 1200 * time.Millisecond}, {mark: "painted"}}
	for i := 0; i < 40; i++ {
		vim = append(vim, step{send: strings.Repeat("l", 20) + strings.Repeat("h", 20), wait: 30 * time.Millisecond})
	}
	vim = append(vim, nudges(cols, rows)...)
	vim = append(vim, step{send: "\x1b", wait: 300 * time.Millisecond}, step{send: ":q!\r", wait: 500 * time.Millisecond}, step{mark: "left"}, step{send: "exit\r", wait: 300 * time.Millisecond})
	out = append(out, scenario{name: "alpine-vim", pod: "full", command: []string{"bash"}, steps: vim})
	for _, s := range shells {
		out = append(out, scenario{name: s.name + "-flood-midline", pod: s.pod, command: []string{"sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"}, steps: []step{
			{quiet: 500 * time.Millisecond},
			{send: "seq 1 20000\r", wait: 500 * time.Millisecond},
			{quiet: 800 * time.Millisecond},
			{send: "echo hello wor", wait: 400 * time.Millisecond},
			{mark: "painted"},
			{send: "ld\r", wait: 400 * time.Millisecond},
			{mark: "left"},
			{send: "exit\r", wait: 300 * time.Millisecond},
		}})
	}
	return out
}

func main() {
	kubeconfig := flag.String("kubeconfig", "", "kubeconfig path")
	namespace := flag.String("namespace", "exec-resume-probe", "namespace")
	dir := flag.String("out", "", "output directory")
	only := flag.String("only", "", "run scenarios whose name contains this")
	flag.Parse()
	config, err := clientcmd.BuildConfigFromFlags("", *kubeconfig)
	if err != nil {
		panic(err)
	}
	client, err := kubernetes.NewForConfig(config)
	if err != nil {
		panic(err)
	}
	for _, sc := range scenarios() {
		if !strings.Contains(sc.name, *only) {
			continue
		}
		url := client.CoreV1().RESTClient().Post().Resource("pods").Namespace(*namespace).Name(sc.pod).SubResource("exec").VersionedParams(&corev1.PodExecOptions{Command: sc.command, Stdin: true, Stdout: true, TTY: true}, scheme.ParameterCodec).URL()
		primary, err := remotecommand.NewWebSocketExecutor(config, http.MethodGet, url.String())
		if err != nil {
			panic(err)
		}
		secondary, err := remotecommand.NewSPDYExecutor(config, http.MethodPost, url)
		if err != nil {
			panic(err)
		}
		executor, err := remotecommand.NewFallbackExecutor(primary, secondary, func(err error) bool {
			return httpstream.IsUpgradeFailure(err) || httpstream.IsHTTPSProxyError(err)
		})
		if err != nil {
			panic(err)
		}
		file, err := os.Create(filepath.Join(*dir, sc.name+".jsonl"))
		if err != nil {
			panic(err)
		}
		rec := &recorder{start: time.Now(), file: file, last: time.Now()}
		size := make(sizes, 16)
		in := &input{ch: make(chan []byte, 16)}
		size <- remotecommand.TerminalSize{Width: 80, Height: 24}
		rec.line(map[string]any{"r": []uint16{80, 24}})
		done := make(chan error, 1)
		ctx, cancel := context.WithCancel(context.Background())
		go func() {
			done <- executor.StreamWithContext(ctx, remotecommand.StreamOptions{Stdin: in, Stdout: rec, Tty: true, TerminalSizeQueue: size})
		}()
		for _, st := range sc.steps {
			switch {
			case st.mark != "":
				rec.line(map[string]any{"m": st.mark})
			case st.resize[0] != 0:
				rec.line(map[string]any{"r": st.resize[:]})
				size <- remotecommand.TerminalSize{Width: st.resize[0], Height: st.resize[1]}
			case st.send != "":
				in.ch <- []byte(st.send)
			}
			if st.quiet > 0 {
				rec.quiet(st.quiet)
			}
			time.Sleep(st.wait)
		}
		select {
		case err := <-done:
			fmt.Printf("%-18s %7d bytes, ended: %v\n", sc.name, rec.bytes, err)
		case <-time.After(3 * time.Second):
			fmt.Printf("%-18s %7d bytes, did not end\n", sc.name, rec.bytes)
		}
		cancel()
		close(size)
		_ = file.Close()
	}
}
