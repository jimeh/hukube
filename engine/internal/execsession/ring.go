package execsession

// ring keeps recent output. Its tracker has read exactly the bytes before start.
// The session holds its lock for every operation on the ring.
type ring struct {
	data         []byte
	limit, head  int
	start, total uint64
	tracker      *tracker
}

func newRing(limit int) *ring { return &ring{limit: limit, tracker: newTracker()} }

func (r *ring) append(data []byte) {
	if len(data) == 0 {
		return
	}
	// Grow only as output arrives, before the ring first fills.
	if len(r.data) < r.limit {
		n := min(len(data), r.limit-len(r.data))
		if len(r.data)+n > cap(r.data) {
			grown := make([]byte, len(r.data), min(r.limit, max(len(r.data)+n, 2*cap(r.data))))
			copy(grown, r.data)
			r.data = grown
		}
		r.data = append(r.data, data[:n]...)
		r.total += uint64(n)
		data = data[n:]
	}
	if len(data) == 0 {
		return
	}
	if len(data) >= r.limit {
		r.tracker.write(r.data[r.head:])
		r.tracker.write(r.data[:r.head])
		r.tracker.write(data[:len(data)-r.limit])
		copy(r.data, data[len(data)-r.limit:])
		r.head = 0
	} else {
		n := min(len(data), r.limit-r.head)
		r.tracker.write(r.data[r.head : r.head+n])
		r.tracker.write(r.data[:len(data)-n])
		copy(r.data[r.head:], data[:n])
		copy(r.data, data[n:])
		r.head = (r.head + len(data)) % r.limit
	}
	r.total += uint64(len(data))
	r.start = r.total - uint64(len(r.data))
}

func (r *ring) bytes(at uint64, n int) []byte {
	n = min(n, int(r.total-at))
	out := make([]byte, n)
	if n == 0 {
		return out
	}
	i := (r.head + int(at-r.start)) % len(r.data)
	first := min(n, len(r.data)-i)
	copy(out, r.data[i:i+first])
	copy(out[first:], r.data[:n-first])
	return out
}

// cut returns the first position at or after start where output may be cut,
// with the tracker as it is there. A tracker that fails must not end a
// session, so a failure cuts at start with a reset terminal's modes.
func (r *ring) cut() (at uint64, t *tracker, safe bool) {
	defer func() {
		if recover() != nil {
			at, t, safe = r.start, newTracker(), true
		}
	}()
	t = r.tracker.clone()
	at = r.start
	for at < r.total && !t.ground() {
		i := (r.head + int(at-r.start)) % len(r.data)
		t.step(r.data[i])
		at++
	}
	return at, t, t.ground()
}

// characterEnd leaves an unfinished UTF-8 character for the next frame. Invalid
// bytes are kept, since the terminal decides how to read them.
func characterEnd(data []byte) int {
	for i := len(data) - 1; i >= max(0, len(data)-4); i-- {
		b := data[i]
		if b&0xc0 == 0x80 {
			continue
		}
		need := 1
		switch {
		case b&0xe0 == 0xc0:
			need = 2
		case b&0xf0 == 0xe0:
			need = 3
		case b&0xf8 == 0xf0:
			need = 4
		}
		if len(data)-i < need {
			return i
		}
		break
	}
	return len(data)
}
