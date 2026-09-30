// Package settings stores Workspace layouts and other user state as JSON
// values keyed by name, shared by every UI client (see ADR-0009).
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sync"

	"github.com/jimeh/hukube/engine/internal/notify"
)

// Store persists settings as one JSON file per key. A Store with no directory
// keeps settings in memory only. It is safe for concurrent use.
type Store struct {
	dir string

	mu      sync.Mutex
	values  map[string]json.RawMessage
	signals map[string]*notify.Signal
}

// Open returns a Store persisting to dir, creating it if needed. An empty dir
// keeps settings in memory.
func Open(dir string) (*Store, error) {
	if dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("create settings dir: %w", err)
		}
	}
	return &Store{
		dir:     dir,
		values:  make(map[string]json.RawMessage),
		signals: make(map[string]*notify.Signal),
	}, nil
}

// Get returns the value for key, or nil when it is not set.
func (s *Store) Get(key string) (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.values[key]; ok {
		return v, nil
	}
	if s.dir == "" {
		return nil, nil
	}
	v, err := os.ReadFile(s.path(key))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read setting %q: %w", key, err)
	}
	s.values[key] = v
	return v, nil
}

// Put stores a JSON value for key and notifies its watchers.
func (s *Store) Put(key string, value json.RawMessage) error {
	if !json.Valid(value) {
		return fmt.Errorf("setting %q is not valid JSON", key)
	}
	s.mu.Lock()
	if s.dir != "" {
		if err := writeAtomic(s.path(key), value); err != nil {
			s.mu.Unlock()
			return fmt.Errorf("write setting %q: %w", key, err)
		}
	}
	s.values[key] = value
	sig := s.signal(key)
	s.mu.Unlock()
	sig.Notify()
	return nil
}

// Watch signals after key's value changes.
func (s *Store) Watch(key string) (<-chan struct{}, func()) {
	s.mu.Lock()
	sig := s.signal(key)
	s.mu.Unlock()
	return sig.Subscribe()
}

func (s *Store) signal(key string) *notify.Signal {
	sig, ok := s.signals[key]
	if !ok {
		sig = &notify.Signal{}
		s.signals[key] = sig
	}
	return sig
}

func (s *Store) path(key string) string {
	return filepath.Join(s.dir, url.PathEscape(key)+".json")
}

func writeAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
