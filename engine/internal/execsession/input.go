package execsession

import (
	"bytes"
	"io"
	"sync"

	"k8s.io/client-go/tools/remotecommand"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

// Input queues stdin without holding up the socket's reader.
type Input struct {
	mu             sync.Mutex
	data           bytes.Buffer
	read           uint64
	ended, hanging bool
	changed        chan struct{}
	ack            func(uint64)
}

func NewInput(ack func(uint64)) *Input {
	return &Input{changed: make(chan struct{}), ack: ack}
}
func (i *Input) signal() { close(i.changed); i.changed = make(chan struct{}) }

// Write accepts only input within the outstanding window. Input that arrives
// during a hang-up is dropped, not refused: its sender did nothing wrong.
func (i *Input) Write(data []byte) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.ended || len(data) > protocol.ExecInputFrame {
		return false
	}
	if i.hanging {
		return true
	}
	if i.data.Len()+len(data) > protocol.ExecInputWindow {
		return false
	}
	_, _ = i.data.Write(data)
	i.signal()
	return true
}
func (i *Input) Read(data []byte) (int, error) {
	if len(data) == 0 {
		return 0, nil
	}
	i.mu.Lock()
	for i.data.Len() == 0 && !i.ended {
		changed := i.changed
		i.mu.Unlock()
		<-changed
		i.mu.Lock()
	}
	if i.ended {
		i.mu.Unlock()
		return 0, io.EOF
	}
	n, _ := i.data.Read(data)
	i.read += uint64(n)
	total, hanging := i.read, i.hanging
	i.mu.Unlock()
	if !hanging && i.ack != nil {
		i.ack(total)
	}
	return n, nil
}

// Hangup replaces pending input with end-of-transmission.
func (i *Input) Hangup() {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.ended || i.hanging {
		return
	}
	i.hanging = true
	i.data.Reset()
	_ = i.data.WriteByte(4)
	i.signal()
}
func (i *Input) Close() {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.ended = true
	i.data.Reset()
	i.signal()
}

// Sizes returns the first size before the latest pending resize.
type Sizes struct {
	mu              sync.Mutex
	initial, latest *remotecommand.TerminalSize
	ended           bool
	changed         chan struct{}
}

func NewSizes() *Sizes   { return &Sizes{changed: make(chan struct{})} }
func (s *Sizes) signal() { close(s.changed); s.changed = make(chan struct{}) }
func (s *Sizes) Initial(cols, rows uint16) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.initial = &remotecommand.TerminalSize{Width: cols, Height: rows}
	s.signal()
}
func (s *Sizes) Resize(cols, rows uint16) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended {
		return
	}
	s.latest = &remotecommand.TerminalSize{Width: cols, Height: rows}
	s.signal()
}
func (s *Sizes) Next() *remotecommand.TerminalSize {
	s.mu.Lock()
	defer s.mu.Unlock()
	for !s.ended && s.initial == nil && s.latest == nil {
		changed := s.changed
		s.mu.Unlock()
		<-changed
		s.mu.Lock()
	}
	if s.ended {
		return nil
	}
	if s.initial != nil {
		size := s.initial
		s.initial = nil
		return size
	}
	size := s.latest
	s.latest = nil
	return size
}
func (s *Sizes) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ended = true
	s.signal()
}
