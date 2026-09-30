// Package server exposes the Engine to UI clients over HTTP and WebSockets.
package server

import (
	"crypto/subtle"
	"errors"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"

	"github.com/coder/websocket"

	"github.com/jimeh/hukube/engine/internal/cluster"
	"github.com/jimeh/hukube/engine/internal/kubeconfig"
	"github.com/jimeh/hukube/engine/internal/protocol"
	"github.com/jimeh/hukube/engine/internal/settings"
)

// Config configures a Server.
type Config struct {
	// Token must be presented by every client on the control socket.
	Token string
	// AllowedOrigins lists exact browser origins, such as a dev server or the
	// desktop Host's app origin, allowed in addition to same-origin pages.
	AllowedOrigins []string
	// AllowedHosts lists hostnames, besides loopback names, that requests may
	// address, such as a dev server's tailnet name. Checking the Host header
	// stops DNS-rebinding pages from passing as same-origin.
	AllowedHosts []string
	// UIDir, when set, is a built UI bundle served at the root (web Host).
	UIDir string

	Source   kubeconfig.Source
	Clusters *cluster.Manager
	Settings *settings.Store
	Log      *slog.Logger
}

// Server handles HTTP requests and control socket sessions.
type Server struct {
	cfg Config
}

// New returns a Server. It panics if cfg has no Token, because the Engine must
// never accept unauthenticated clients.
func New(cfg Config) *Server {
	if cfg.Token == "" {
		panic("server: empty token")
	}
	return &Server{cfg: cfg}
}

// Handler returns the Server's HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /ws", s.serveControl)
	if s.cfg.UIDir != "" {
		mux.Handle("GET /", spaHandler(s.cfg.UIDir))
	}
	return s.requireKnownHost(mux)
}

// requireKnownHost refuses requests addressed to a hostname other than a
// loopback name or a configured host. A DNS-rebinding page sends its own name
// in both Host and Origin, so the Origin check alone would accept it.
func (s *Server) requireKnownHost(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.Host)
		if err != nil {
			host = r.Host
		}
		host = strings.ToLower(strings.Trim(host, "[]"))
		ip := net.ParseIP(host)
		if host != "localhost" && (ip == nil || !ip.IsLoopback()) && !slices.Contains(s.cfg.AllowedHosts, host) {
			http.Error(w, "host not allowed", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) serveControl(w http.ResponseWriter, r *http.Request) {
	if !s.originAllowed(r) {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	if !s.tokenValid(r) {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols: []string{protocol.Subprotocol},
		// Origins are checked above, including non-HTTP desktop origins.
		InsecureSkipVerify: true,
	})
	if err != nil {
		s.cfg.Log.Debug("accept control socket", "err", err)
		return
	}
	if conn.Subprotocol() != protocol.Subprotocol {
		conn.Close(websocket.StatusPolicyViolation, "client must offer "+protocol.Subprotocol)
		return
	}
	newSession(s, conn).run(r.Context())
}

// originAllowed accepts clients without an Origin header, which are not
// browsers and still need the token, same-origin pages, and configured
// origins.
func (s *Server) originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" || slices.Contains(s.cfg.AllowedOrigins, origin) {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host == r.Host
}

func (s *Server) tokenValid(r *http.Request) bool {
	for _, header := range r.Header.Values("Sec-WebSocket-Protocol") {
		for offered := range strings.SplitSeq(header, ",") {
			token, ok := strings.CutPrefix(strings.TrimSpace(offered), protocol.TokenSubprotocolPrefix)
			if ok && subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.Token)) == 1 {
				return true
			}
		}
	}
	return false
}

// spaHandler serves files from dir, falling back to index.html so client-side
// routes load the app.
func spaHandler(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := filepath.Join(dir, filepath.FromSlash(path.Clean("/"+r.URL.Path)))
		if _, err := os.Stat(name); errors.Is(err, fs.ErrNotExist) || r.URL.Path == "/" {
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFile(w, r, filepath.Join(dir, "index.html"))
			return
		}
		files.ServeHTTP(w, r)
	})
}
