// Command hukube-engine runs the hukube Engine: it connects to Clusters and
// serves UI clients over a local control socket.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"k8s.io/klog/v2"

	"github.com/jimeh/hukube/engine/internal/cluster"
	"github.com/jimeh/hukube/engine/internal/kubeconfig"
	"github.com/jimeh/hukube/engine/internal/server"
	"github.com/jimeh/hukube/engine/internal/settings"
)

type stringList []string

func (l *stringList) String() string     { return strings.Join(*l, ",") }
func (l *stringList) Set(v string) error { *l = append(*l, v); return nil }

type options struct {
	listen           string
	token            string
	allowOrigins     stringList
	web              bool
	uiDir            string
	kubeconfig       string
	dataDir          string
	exitOnStdinClose bool
	logLevel         string
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "hukube-engine:", err)
		os.Exit(1)
	}
}

func run() error {
	var o options
	flag.StringVar(&o.listen, "listen", "127.0.0.1:0", "loopback `address` to listen on; port 0 picks a free port")
	flag.StringVar(&o.token, "token", os.Getenv("HUKUBE_TOKEN"), "token clients must present (default $HUKUBE_TOKEN, or random)")
	flag.Var(&o.allowOrigins, "allow-origin", "additional browser `origin` allowed to connect (repeatable)")
	flag.BoolVar(&o.web, "web", false, "serve the UI from --ui-dir and print a URL to open it")
	flag.StringVar(&o.uiDir, "ui-dir", "", "`directory` of the built UI bundle, served when --web is set")
	flag.StringVar(&o.kubeconfig, "kubeconfig", "", "kubeconfig `path` (default $KUBECONFIG or ~/.kube/config)")
	flag.StringVar(&o.dataDir, "data-dir", "", "`directory` for stored settings (default: user config dir)")
	flag.BoolVar(&o.exitOnStdinClose, "exit-on-stdin-close", false, "exit when stdin closes, so the Engine dies with its parent")
	flag.StringVar(&o.logLevel, "log-level", "info", "log `level`: debug, info, warn, or error")
	flag.Parse()

	var level slog.Level
	if err := level.UnmarshalText([]byte(o.logLevel)); err != nil {
		return fmt.Errorf("invalid --log-level: %w", err)
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	klog.SetSlogLogger(log.With("component", "client-go"))

	if o.web && o.uiDir == "" {
		return errors.New("--web requires --ui-dir")
	}
	if o.token == "" {
		token, err := randomToken()
		if err != nil {
			return err
		}
		o.token = token
	}
	if o.dataDir == "" {
		dir, err := os.UserConfigDir()
		if err != nil {
			return fmt.Errorf("find user config dir: %w", err)
		}
		o.dataDir = filepath.Join(dir, "hukube", "engine")
	}

	ln, err := listenLoopback(o.listen)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if o.exitOnStdinClose {
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			stop()
		}()
	}

	store, err := settings.Open(filepath.Join(o.dataDir, "settings"))
	if err != nil {
		return err
	}
	uiDir := ""
	if o.web {
		uiDir = o.uiDir
	}
	source := kubeconfig.NewFileSource(o.kubeconfig)
	srv := server.New(server.Config{
		Token:          o.token,
		AllowedOrigins: o.allowOrigins,
		UIDir:          uiDir,
		Source:         source,
		Clusters:       cluster.NewManager(ctx, source, log),
		Settings:       store,
		Log:            log,
	})
	httpSrv := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}

	url := "http://" + ln.Addr().String()
	// The desktop Host reads this line to learn where the Engine listens.
	if err := json.NewEncoder(os.Stdout).Encode(map[string]string{"event": "ready", "url": url}); err != nil {
		return err
	}
	if o.web {
		log.Info("serving web UI", "open", url+"/#token="+o.token)
	} else {
		log.Info("listening", "url", url)
	}

	errc := make(chan error, 1)
	go func() { errc <- httpSrv.Serve(ln) }()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return httpSrv.Shutdown(shutdownCtx)
}

// listenLoopback listens on addr, refusing non-loopback addresses because the
// Engine has no real authentication yet (see ADR-0007).
func listenLoopback(addr string) (net.Listener, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("invalid --listen: %w", err)
	}
	if host != "localhost" {
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return nil, fmt.Errorf("--listen must be a loopback address, got %q", host)
		}
	}
	return net.Listen("tcp", addr)
}

func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return hex.EncodeToString(b), nil
}
