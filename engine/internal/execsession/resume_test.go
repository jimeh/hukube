package execsession

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"k8s.io/client-go/tools/remotecommand"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

type liveFixture struct {
	r        *Registry
	a        *Attachment
	commands chan func(remotecommand.StreamOptions)
	p        protocol.ExecParams
	c        Cluster
	idx      Index
}

func live(t *testing.T) *liveFixture {
	t.Helper()
	commands := make(chan func(remotecommand.StreamOptions))
	c, idx := fixture(func(ctx context.Context, o remotecommand.StreamOptions) error {
		for {
			select {
			case f := <-commands:
				if f == nil {
					return nil
				}
				f(o)
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	})
	p := testParams
	p.Session, p.Window, p.Start = "session", "window", true
	r := NewRegistry(256<<10, 10*time.Minute)
	a, err := r.Open(p, c, idx, func() {}, func(uint64) {})
	if err != nil {
		t.Fatal(err)
	}
	synctest.Wait()
	t.Cleanup(func() {
		if err := r.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return &liveFixture{r, a, commands, p, c, idx}
}
func (f *liveFixture) do(fn func(remotecommand.StreamOptions)) {
	done := make(chan struct{})
	f.commands <- func(o remotecommand.StreamOptions) { fn(o); close(done) }
	<-done
}
func (f *liveFixture) write(data []byte) {
	f.do(func(o remotecommand.StreamOptions) { _, _ = o.Stdout.Write(data) })
}
func (f *liveFixture) attach(t *testing.T, p protocol.ExecParams) *Attachment {
	t.Helper()
	a, err := f.r.Open(p, f.c, f.idx, func() {}, func(uint64) {})
	if err != nil {
		t.Fatal(err)
	}
	return a
}
func syncOf(t *testing.T, a *Attachment) protocol.ExecSync {
	t.Helper()
	s, data, end, _ := a.Next(true, false)
	if s == nil || data != nil || end != nil {
		t.Fatalf("want sync, got %v %q %v", s, data, end)
	}
	return *s
}
func outputOf(t *testing.T, a *Attachment) []byte {
	t.Helper()
	var out []byte
	for {
		s, data, end, _ := a.Next(true, false)
		if s != nil || end != nil {
			t.Fatalf("unexpected sync/end %v %v", s, end)
		}
		if data == nil {
			return out
		}
		if len(data) > OutputFrame {
			t.Fatalf("frame too large: %d", len(data))
		}
		out = append(out, data[1:]...)
	}
}

func TestAttachmentReplayAndSkip(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := live(t)
		if s := syncOf(t, f.a); s.Offset != 0 || s.Replay != 0 || s.Reset {
			t.Fatal(s)
		}
		f.write([]byte("before"))
		if got := outputOf(t, f.a); string(got) != "before" {
			t.Fatalf("output=%q", got)
		}
		f.a.Detach()
		f.write([]byte("missed"))
		r := uint64(6)
		p := f.p
		p.Start = false
		p.Resume = &r
		a := f.attach(t, p)
		if s := syncOf(t, a); s.Offset != 6 || s.Replay != 6 || s.Reset {
			t.Fatal(s)
		}
		f.write([]byte("live"))
		_, frame, _, _ := a.Next(true, false)
		if string(frame[1:]) != "missed" {
			t.Fatalf("replay and live mixed: %q", frame)
		}
		if got := outputOf(t, a); string(got) != "live" {
			t.Fatalf("live=%q", got)
		}
		a.Detach()
		f.write(bytes.Repeat([]byte{'x'}, DefaultBuffer+100))
		p.Resume = &r
		a = f.attach(t, p)
		s := syncOf(t, a)
		if !s.Reset || s.Offset != 116 || s.Skipped != 110 || s.Replay != DefaultBuffer || s.Restore != "\x1b[?25h" {
			t.Fatalf("skip=%+v", s)
		}
		if got := outputOf(t, a); len(got) != DefaultBuffer || !bytes.Equal(got, bytes.Repeat([]byte{'x'}, DefaultBuffer)) {
			t.Fatalf("ring replay=%d", len(got))
		}
		// An attached window falls behind in exactly the same way.
		f.write(bytes.Repeat([]byte{'y'}, DefaultBuffer+10))
		if s := syncOf(t, a); !s.Reset || s.Skipped != 10 || s.Replay != DefaultBuffer {
			t.Fatal(s)
		}
		p.Resume = new(uint64)
		*p.Resume = a.session.ring.total + 1
		a = f.attach(t, p)
		if s := syncOf(t, a); !s.Reset || s.Skipped != s.Offset {
			t.Fatal(s)
		}
	})
}

func TestAttachmentNeverHoldsOutput(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := live(t)
		syncOf(t, f.a)
		for range 62 {
			time.Sleep(time.Second) // Fake elapsed stall, not synchronization.
			f.do(func(o remotecommand.StreamOptions) {
				before := time.Now()
				for range 32 {
					if n, err := o.Stdout.Write(bytes.Repeat([]byte{'x'}, 32<<10)); n != 32<<10 || err != nil {
						t.Errorf("write=%d %v", n, err)
					}
				}
				if !time.Now().Equal(before) {
					t.Error("writer waited for the attachment")
				}
			})
		}
		f.write(bytes.Repeat([]byte{'x'}, 2<<20))
		if f.a.session.end != nil || f.a.session.ring.total != 64<<20 || len(f.a.session.ring.data) != DefaultBuffer {
			t.Fatalf("session stopped or unbounded: total=%d", f.a.session.ring.total)
		}
		s := syncOf(t, f.a)
		if !s.Reset || s.Skipped != (64<<20)-DefaultBuffer {
			t.Fatal(s)
		}
	})
}

func TestRingSafeCut(t *testing.T) {
	for _, sequence := range []string{"\x1b[?2004h", "\x1b]0;title\x07", "\x1bP$qstuff\x1b\\", "é", "漢", "😀"} {
		t.Run(fmt.Sprintf("%q", sequence), func(t *testing.T) {
			for inside := 1; inside < len(sequence); inside++ {
				r := newRing(16)
				r.append(append([]byte(sequence), bytes.Repeat([]byte{'x'}, 16-len(sequence)+inside)...))
				cut, tr, safe := r.cut()
				if !safe || !tr.ground() || cut != uint64(len(sequence)) {
					t.Fatalf("inside=%d cut=%d ground=%v", inside, cut, safe)
				}
			}
		})
	}
	r := newRing(16)
	r.append([]byte("\x1b]" + string(bytes.Repeat([]byte{'x'}, 32))))
	if _, _, safe := r.cut(); safe {
		t.Fatal("cut inside unfinished OSC")
	}
	r.append([]byte{7})
	if at, _, safe := r.cut(); !safe || at != 35 {
		t.Fatalf("cut=%d safe=%v", at, safe)
	}
}

func TestAttachmentCharactersAndRepaint(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := live(t)
		syncOf(t, f.a)
		f.write(append(bytes.Repeat([]byte{'x'}, OutputFrame-2), 0xe2, 0x80))
		_, frame, _, _ := f.a.Next(true, false)
		if len(frame) != OutputFrame-1 {
			t.Fatalf("frame split character: %d", len(frame))
		}
		if got := outputOf(t, f.a); len(got) != 0 {
			t.Fatalf("partial character=%x", got)
		}
		f.write([]byte{0x94})
		if got := outputOf(t, f.a); !bytes.Equal(got, []byte{0xe2, 0x80, 0x94}) {
			t.Fatalf("character=%x", got)
		}
		// A replay ends before an unfinished character, which is sent live
		// when the rest of it arrives.
		f.write([]byte{0xe2, 0x80})
		f.a.Detach()
		p := f.p
		p.Start = false
		a := f.attach(t, p)
		total := a.session.ring.total
		if s := syncOf(t, a); s.Offset != 0 || s.Replay != total-2 {
			t.Fatalf("replay ends inside a character: %+v of %d", s, total)
		}
		if got := outputOf(t, a); uint64(len(got)) != total-2 {
			t.Fatalf("replayed %d of %d", len(got), total-2)
		}
		f.write([]byte{0x94})
		if got := outputOf(t, a); !bytes.Equal(got, []byte{0xe2, 0x80, 0x94}) {
			t.Fatalf("character after replay=%x", got)
		}
		f.write([]byte{0xe2, 0x80})
		f.commands <- nil
		synctest.Wait()
		outputOfEnd := func() []byte {
			var out []byte
			for {
				_, frame, end, _ := a.Next(true, false)
				if end != nil {
					return out
				}
				out = append(out, frame[1:]...)
			}
		}
		// A character that never finishes is sent at the session's end.
		if got := outputOfEnd(); !bytes.Equal(got, []byte{0xe2, 0x80}) {
			t.Fatalf("unfinished character at the end=%x", got)
		}
	})
	for _, alt := range []bool{false, true} {
		for _, rows := range []uint16{1, 24} {
			t.Run(fmt.Sprintf("alt=%v/rows=%d", alt, rows), func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					f := live(t)
					f.do(func(o remotecommand.StreamOptions) { o.TerminalSizeQueue.Next() })
					f.a.Resize(80, rows)
					if rows != 24 {
						f.do(func(o remotecommand.StreamOptions) { o.TerminalSizeQueue.Next() })
					}
					f.a.Resize(80, rows)
					if f.a.session.sizes.latest != nil {
						t.Fatal("equal resize reached process")
					}
					if alt {
						f.write([]byte("\x1b[?1049h"))
					}
					f.write(bytes.Repeat([]byte{'x'}, DefaultBuffer+1))
					sync := syncOf(t, f.a)
					if !sync.Reset {
						t.Fatal(sync)
					}
					if alt && rows > 1 {
						f.do(func(o remotecommand.StreamOptions) {
							got := []remotecommand.TerminalSize{*o.TerminalSizeQueue.Next(), *o.TerminalSizeQueue.Next()}
							if !slices.Equal(got, []remotecommand.TerminalSize{{Width: 80, Height: rows - 1}, {Width: 80, Height: rows}}) {
								t.Errorf("nudge=%v", got)
							}
						})
					} else if len(f.a.session.sizes.nudge) > 0 {
						t.Fatal("shell or one-row terminal was nudged")
					}
				})
			})
		}
	}
}

func TestAttachmentInputOwnership(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := live(t)
		f.a.Write([]byte("seen"))
		f.do(func(o remotecommand.StreamOptions) {
			data := make([]byte, 4)
			if _, err := io.ReadFull(o.Stdin, data); err != nil {
				t.Error(err)
			}
		})
		f.a.Write([]byte("old"))
		f.a.Detach()
		a := f.attach(t, f.p)
		if !f.a.Write([]byte("stale")) {
			t.Fatal("replaced stream input was refused")
		}
		if a.session.input.data.Len() != 0 {
			t.Fatal("detached input reached new attachment")
		}
		ack := make(chan uint64, 1)
		p := f.p
		b, err := f.r.Open(p, f.c, f.idx, func() {}, func(n uint64) { ack <- n })
		if err != nil {
			t.Fatal(err)
		}
		if !b.Write([]byte("new")) {
			t.Fatal("new input refused")
		}
		f.do(func(o remotecommand.StreamOptions) {
			data := make([]byte, 3)
			if _, err := io.ReadFull(o.Stdin, data); err != nil || string(data) != "new" {
				t.Errorf("input=%q err=%v", data, err)
			}
		})
		if total := <-ack; total != 3 {
			t.Fatalf("attachment input count=%d", total)
		}
	})
}

func TestRegistryStartAndOwnership(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := live(t)
		p := f.p
		p.Start = false
		p.Session = "absent"
		if _, err := f.r.Open(p, f.c, f.idx, func() {}, nil); err == nil || errorDetail(t, err).Reason != protocol.ExecReasonSessionGone {
			t.Fatalf("attach started: %v", err)
		}
		p = f.p
		b := f.attach(t, p)
		if b.session != f.a.session {
			t.Fatal("repeated start ran twice")
		}
		if _, _, end, _ := f.a.Next(true, false); end == nil || end.Reason != protocol.StreamEndReasonDetached {
			t.Fatal("same window did not replace old stream")
		}
		p.Window = "other"
		p.Rows = 30
		c := f.attach(t, p)
		if _, _, end, _ := c.Next(true, false); end == nil || end.Reason != protocol.StreamEndReasonDetached || b.session.rows != 24 {
			t.Fatal("another window attached without takeover")
		}
		p.Takeover = true
		d := f.attach(t, p)
		if d.session.attachment != d || d.session.rows != 30 {
			t.Fatal("takeover did not own size")
		}
		if _, _, end, _ := b.Next(true, false); end == nil || end.Reason != protocol.StreamEndReasonDetached {
			t.Fatal("takeover did not detach old stream")
		}
		p.UID = "another"
		if _, err := f.r.Open(p, f.c, f.idx, func() {}, nil); err == nil || errorDetail(t, err).Code != protocol.ErrorCodeBadRequest {
			t.Fatal("identity mismatch accepted")
		}
		f.commands <- nil
		synctest.Wait()
		p = f.p
		p.Start = false
		over := f.attach(t, p)
		if over.session != d.session {
			t.Fatal("over attachment started another process")
		}
		p.Start = true
		p.Cols, p.Rows = 0, 0
		if _, err := f.r.Open(p, f.c, f.idx, func() {}, nil); err == nil || errorDetail(t, err).Code != protocol.ErrorCodeBadRequest || registryCount(f.r) != 1 {
			t.Fatalf("invalid start again removed the over session: %v", err)
		}
		p.Cols, p.Rows = 80, 24
		restarted := f.attach(t, p)
		if restarted.session == over.session {
			t.Fatal("start again reused over session")
		}
		for i := 1; i < 64; i++ {
			p.Session = fmt.Sprint(i)
			f.attach(t, p)
		}
		p.Session = "65"
		if _, err := f.r.Open(p, f.c, f.idx, func() {}, nil); err == nil || errorDetail(t, err).Reason != protocol.ExecReasonTooManySessions {
			t.Fatalf("65th start=%v", err)
		}
	})
}

func TestRegistryUnattachedAndEnd(t *testing.T) {
	for _, over := range []bool{false, true} {
		t.Run(fmt.Sprint(over), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				f := live(t)
				if over {
					f.commands <- nil
					synctest.Wait()
				}
				f.a.Detach()
				time.Sleep(9*time.Minute + 59*time.Second)
				p := f.p
				p.Start = false
				a := f.attach(t, p)
				if a.session != f.a.session {
					t.Fatal("reattaching restarted the session")
				}
				a.Detach()
				time.Sleep(time.Second)
				synctest.Wait()
				if registryCount(f.r) != 1 {
					t.Fatal("old unattached deadline removed reattached session")
				}
				time.Sleep(9*time.Minute + 59*time.Second)
				synctest.Wait()
				if registryCount(f.r) != 0 {
					t.Fatal("unattached session retained after 10 minutes")
				}
				<-a.session.done
			})
		})
	}
	synctest.Test(t, func(t *testing.T) {
		f := live(t)
		f.write([]byte("last"))
		f.a.Detach()
		f.commands <- nil
		synctest.Wait()
		p := f.p
		p.Start = false
		a := f.attach(t, p)
		if s := syncOf(t, a); s.Replay != 4 {
			t.Fatal(s)
		}
		_, frame, _, _ := a.Next(true, false)
		if string(frame[1:]) != "last" {
			t.Fatalf("last=%q", frame)
		}
		if _, _, end, _ := a.Next(true, false); end == nil || end.ExitCode == nil || *end.ExitCode != 0 {
			t.Fatalf("end=%v", end)
		}
		a.Detach()
		if registryCount(f.r) != 1 {
			t.Fatal("end removed without closing handshake")
		}
		a = f.attach(t, p)
		syncOf(t, a)
		a.ReceivedEnd()
		if registryCount(f.r) != 0 {
			t.Fatal("received end retained session")
		}
		if err := f.r.End(protocol.ExecEndParams{Cluster: "c", Session: "session"}); err != nil {
			t.Fatal(err)
		}
	})
}

func TestTrackerPanicKeepsSession(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := live(t)
		f.write([]byte("\x1b[?1049h"))
		f.a.session.ring.tracker.state = 255
		f.write(bytes.Repeat([]byte{'x'}, DefaultBuffer+20))
		f.write([]byte("later"))
		if f.a.session.end != nil {
			t.Fatal("tracker panic ended session")
		}
		s := syncOf(t, f.a)
		if !s.Reset || s.Restore != "\x1b[?25h" {
			t.Fatalf("panic restore=%+v", s)
		}
		if out := outputOf(t, f.a); !bytes.HasSuffix(out, []byte("later")) {
			t.Fatal("output after panic lost")
		}
	})
}

func registryCount(r *Registry) int { r.mu.Lock(); defer r.mu.Unlock(); return len(r.sessions) }

func errorDetail(t *testing.T, err error) *protocol.ErrorDetail {
	t.Helper()
	var detail *protocol.ErrorDetail
	if !errors.As(err, &detail) {
		t.Fatalf("expected protocol error, got %v", err)
	}
	return detail
}

// An invalid cut-short sequence must not prevent replay from finishing.
func TestAttachmentReplayEndsAfterInvalidSequence(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := live(t)
		syncOf(t, f.a)
		// "ok", a 4-byte lead with one continuation (invalid: cut short by
		// the next lead), then the first byte of an em dash still being written.
		f.write([]byte{'o', 'k', 0xf0, 0x9f, 0xe2})
		f.a.Detach()
		p := f.p
		p.Start = false
		a := f.attach(t, p)
		s := syncOf(t, a)
		t.Logf("sync=%+v total=%d", s, a.session.ring.total)
		got := outputOf(t, a)
		if !bytes.Equal(got, []byte{'o', 'k', 0xf0, 0x9f}) {
			t.Errorf("replayed=%x", got)
		}
		t.Logf("replayed=%x position=%d replayEnd=%d", got, a.position, a.replayEnd)
		// The rest of the em dash, and then a prompt, arrive.
		f.write([]byte{0x80, 0x94, '$', ' '})
		more := outputOf(t, a)
		if !bytes.Equal(more, []byte{0xe2, 0x80, 0x94, '$', ' '}) {
			t.Errorf("live output=%x", more)
		}
		t.Logf("after more output=%x position=%d replayEnd=%d total=%d", more, a.position, a.replayEnd, a.session.ring.total)
		if a.position < a.replayEnd {
			t.Errorf("replay stalled at %d of %d; live output after it is never sent", a.position, a.replayEnd)
		}
	})
}

func TestAttachmentNoRepaintAfterReturningToShell(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := live(t)
		f.do(func(o remotecommand.StreamOptions) { o.TerminalSizeQueue.Next() })
		f.write([]byte("\x1b[?1049h"))
		f.write(bytes.Repeat([]byte{'x'}, DefaultBuffer+32))
		f.write([]byte("\x1b[?1049l/ # echo half-typed"))
		current := f.a.session.ring.tracker.clone()
		current.write(f.a.session.ring.bytes(f.a.session.ring.start, DefaultBuffer))
		if current.alt {
			t.Fatal("setup did not return to the normal screen")
		}
		s := syncOf(t, f.a)
		if !s.Reset {
			t.Fatal("setup did not require catch-up")
		}
		if len(f.a.session.sizes.nudge) != 0 {
			t.Fatalf("normal-screen shell was nudged from historical cut modes: restore=%q sizes=%v", s.Restore, f.a.session.sizes.nudge)
		}
	})
}

func TestTrackerRejectedScrollRegionKeepsPrevious(t *testing.T) {
	tr := newTracker(24)
	tr.write([]byte("\x1b[2;10r\x1b[999;1000r"))
	if tr.restore() != "\x1b[2;10r\x1b[?25h" {
		t.Fatalf("restore=%q, want previously valid region 2;10 at a 24-row terminal", tr.restore())
	}
}

func TestTrackerScrollRegionRows(t *testing.T) {
	for _, tc := range []struct {
		sequence string
		want     [2]int
	}{
		{"\x1b[2;10r\x1b[999;1000r", [2]int{2, 10}},
		{"\x1b[2;10r\x1b[24r", [2]int{2, 10}},
		{"\x1b[2;10r\x1b[10;10r", [2]int{2, 10}},
		{"\x1b[2;0r", [2]int{2, 24}},
		{"\x1b[2;1000r", [2]int{2, 24}},
		{"\x1b[0;0r", [2]int{}},
	} {
		tr := newTracker(24)
		tr.write([]byte(tc.sequence))
		if tr.region[0] != tc.want {
			t.Errorf("%q: region=%v want %v", tc.sequence, tr.region[0], tc.want)
		}
	}
}

func TestTrackerSynchronizedOutput(t *testing.T) {
	tr := newTracker(24)
	tr.write([]byte("\x1b[?2026h"))
	if !strings.Contains(tr.restore(), "\x1b[?2026h") {
		t.Fatalf("synchronized output not restored: %q", tr.restore())
	}
	tr.write([]byte("\x1b[?2026l"))
	if strings.Contains(tr.restore(), "2026") {
		t.Fatalf("synchronized output not cleared: %q", tr.restore())
	}
}

func TestRegistryEndBeforeStart(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := live(t)
		p := f.p
		p.Session = "pending"
		end := protocol.ExecEndParams{Cluster: p.Cluster, Session: p.Session}
		if err := f.r.End(end); err != nil {
			t.Fatal(err)
		}
		if _, err := f.r.Open(p, f.c, f.idx, func() {}, nil); err == nil || errorDetail(t, err).Reason != protocol.ExecReasonSessionGone || errorDetail(t, err).Code != protocol.ErrorCodeNotFound {
			t.Fatalf("ended pending start=%v", err)
		}
		if registryCount(f.r) != 1 {
			t.Fatal("pending start created a session")
		}
		a := f.attach(t, p)
		if err := f.r.End(end); err != nil {
			t.Fatal(err)
		}
		<-a.session.done
		if err := f.r.End(end); err != nil {
			t.Fatal(err)
		}
		time.Sleep(time.Minute) // Fake clock advances past the remembered end's lifetime.
		f.attach(t, p)
	})
}

func TestRegistryHangingUpCountsTowardLimit(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := live(t)
		sessions := []*Session{f.a.session}
		p := f.p
		for i := 1; i < MaxSessions; i++ {
			p.Session = fmt.Sprint(i)
			sessions = append(sessions, f.attach(t, p).session)
		}
		synctest.Wait()
		for _, s := range sessions {
			if err := f.r.End(protocol.ExecEndParams{Cluster: p.Cluster, Session: s.params.Session}); err != nil {
				t.Fatal(err)
			}
		}
		synctest.Wait() // Every executor is now hanging up, before its fake deadline.
		p.Session = "extra"
		if _, err := f.r.Open(p, f.c, f.idx, func() {}, nil); err == nil || errorDetail(t, err).Reason != protocol.ExecReasonTooManySessions {
			t.Fatalf("start during hang-up=%v", err)
		}
		for _, s := range sessions {
			<-s.done
		}
		f.attach(t, p)
	})
}

func TestTrackerUsesResizedRows(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := live(t)
		f.a.Resize(80, 40)
		f.write([]byte("\x1b[35;1000r"))
		f.write(bytes.Repeat([]byte{'x'}, DefaultBuffer+1))
		if s := syncOf(t, f.a); !strings.Contains(s.Restore, "\x1b[35;40r") {
			t.Fatalf("resized scroll region=%q", s.Restore)
		}
	})
}

func TestRegistryEndedBoundAndRefresh(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := live(t)
		p := f.p
		for i := range 256 {
			if err := f.r.End(protocol.ExecEndParams{Cluster: p.Cluster, Session: fmt.Sprint(i)}); err != nil {
				t.Fatal(err)
			}
		}
		time.Sleep(30 * time.Second) // Fake clock separates the refreshed entry's age.
		if err := f.r.End(protocol.ExecEndParams{Cluster: p.Cluster, Session: "0"}); err != nil {
			t.Fatal(err)
		}
		if err := f.r.End(protocol.ExecEndParams{Cluster: p.Cluster, Session: "new"}); err != nil {
			t.Fatal(err)
		}
		p.Session = "1"
		f.attach(t, p) // The oldest entry, rather than the refreshed one, was dropped.
		p.Session = "0"
		if _, err := f.r.Open(p, f.c, f.idx, func() {}, nil); err == nil || errorDetail(t, err).Reason != protocol.ExecReasonSessionGone {
			t.Fatalf("refreshed end=%v", err)
		}
		if len(f.r.ended) > 256 {
			t.Fatalf("unbounded remembered ends: %d", len(f.r.ended))
		}
		time.Sleep(30 * time.Second) // The initial entries expire at exactly one minute.
		p.Session = "2"
		f.attach(t, p)
		p.Session = "new"
		if _, err := f.r.Open(p, f.c, f.idx, func() {}, nil); err == nil || errorDetail(t, err).Reason != protocol.ExecReasonSessionGone {
			t.Fatalf("newer entry expired too early: %v", err)
		}
	})
}
