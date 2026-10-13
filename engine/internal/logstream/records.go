package logstream

import (
	"bufio"
	"encoding/binary"
	"errors"
	"io"
	"time"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

const maxLine = 64 << 10

// responseText is what a response ended with when that was neither a line
// nor part of one: the kubelet's error, written into a successful response.
type responseText struct{ text string }

func (e *responseText) Error() string { return e.text }

type record struct {
	source  int
	flags   byte
	time    int64
	content []byte
}

func appendRecord(frame []byte, r record) []byte {
	frame = binary.BigEndian.AppendUint16(frame, uint16(r.source))
	frame = append(frame, r.flags)
	frame = binary.BigEndian.AppendUint64(frame, uint64(r.time))
	frame = binary.BigEndian.AppendUint32(frame, uint32(len(r.content)))
	return append(frame, r.content...)
}

// readLines retains only a bounded prefix, including space for the timestamp.
// ReadSlice also lets an overlong line drain without allocating its remainder.
func readLines(input io.Reader, traffic func(int), emit func(record)) error {
	reader := bufio.NewReaderSize(input, maxLine)
	line := make([]byte, 0, maxLine+64)
	total := 0
	for {
		part, err := reader.ReadSlice('\n')
		traffic(len(part))
		total += len(part)
		if space := maxLine + 64 - len(line); space > 0 {
			line = append(line, part[:min(space, len(part))]...)
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		if total > 0 {
			newline := len(part) > 0 && part[len(part)-1] == '\n'
			length := total
			if newline {
				length--
				if length < len(line) {
					line = line[:length]
				}
			}
			r := record{}
			prefix := 0
			for i, b := range line {
				if b == ' ' {
					prefix = i + 1
					break
				}
			}
			if prefix > 0 {
				if stamp, parseErr := time.Parse(time.RFC3339Nano, string(line[:prefix-1])); parseErr == nil {
					r.time = stamp.UnixNano()
				} else {
					prefix = 0
				}
			}
			if !newline && prefix == 0 {
				return &responseText{string(line)}
			}
			content := line[prefix:]
			if length-prefix > maxLine {
				r.flags |= protocol.LogRecordFlagCut
			}
			r.content = append([]byte(nil), content[:min(len(content), maxLine)]...)
			emit(r)
		}
		line = line[:0]
		total = 0
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

// merge chooses only among the heads of the per-source queues. This preserves
// a container's order even if its runtime stamps lines out of order.
func merge(records []record) []record {
	queues := make(map[int][]record)
	order := []int{}
	for _, r := range records {
		if _, ok := queues[r.source]; !ok {
			order = append(order, r.source)
		}
		queues[r.source] = append(queues[r.source], r)
	}
	out := make([]record, 0, len(records))
	var last int
	for len(out) < len(records) {
		chosen := -1
		if len(out) > 0 && len(queues[last]) > 0 && queues[last][0].time == 0 {
			chosen = last
		}
		if chosen < 0 {
			for _, id := range order {
				q := queues[id]
				if len(q) == 0 {
					continue
				}
				if chosen < 0 || q[0].time < queues[chosen][0].time {
					chosen = id
				}
			}
		}
		out = append(out, queues[chosen][0])
		queues[chosen] = queues[chosen][1:]
		last = chosen
	}
	return out
}
