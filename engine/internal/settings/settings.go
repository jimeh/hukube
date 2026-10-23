// Package settings stores Workspace layouts and other user state as JSON
// values keyed by name, shared by every UI client (see ADR-0009).
package settings

import (
	"crypto/sha256"
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
	v, _, err := s.Snapshot(key)
	return v, err
}

// Snapshot reads the value and its content revision atomically.
func (s *Store) Snapshot(key string) (json.RawMessage, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, err := s.get(key)
	return append(json.RawMessage(nil), v...), revision(v), err
}

func revision(v json.RawMessage) string {
	if v == nil {
		return ""
	}
	return fmt.Sprintf("%x", sha256.Sum256(v))
}

func (s *Store) get(key string) (json.RawMessage, error) {
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
var ErrConflict = errors.New("setting changed since it was read")

func (s *Store) Put(key string, value json.RawMessage) error {
	return s.CompareAndPut(key, value, nil)
}

// CompareAndPut checks even an explicitly empty revision under the write mutex.
func (s *Store) CompareAndPut(key string, value json.RawMessage, expected *string) error {
	if !json.Valid(value) {
		return fmt.Errorf("setting %q is not valid JSON", key)
	}
	s.mu.Lock()
	if expected != nil {
		current, err := s.get(key)
		if err != nil {
			s.mu.Unlock()
			return err
		}
		if revision(current) != *expected {
			s.mu.Unlock()
			return ErrConflict
		}
	}
	if s.dir != "" {
		if err := writeAtomic(s.path(key), value); err != nil {
			s.mu.Unlock()
			return fmt.Errorf("write setting %q: %w", key, err)
		}
	}
	s.values[key] = append(json.RawMessage(nil), value...)
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
	name := url.PathEscape(key) + ".json"
	if len(name) > 255 {
		// %sha256- cannot occur in an escaped key, so short keys cannot collide.
		name = fmt.Sprintf("%%sha256-%x.json", sha256.Sum256([]byte(key)))
	}
	return filepath.Join(s.dir, name)
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
