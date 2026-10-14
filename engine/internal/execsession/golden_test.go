package execsession

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var updateGolden = flag.Bool("update", false, "update Exec Session tracker golden files")

type restoreSample struct {
	At      int    `json:"at"`
	Restore string `json:"restore"`
}
type attachCase struct {
	Mark    string `json:"mark"`
	At      int    `json:"at"`
	Ring    int    `json:"ring"`
	Cut     int    `json:"cut"`
	Restore string `json:"restore"`
}
type trackerGolden struct {
	// Safe is a bitset of positions after bytes, least significant bit first.
	Safe        []byte          `json:"safe"`
	Samples     []restoreSample `json:"samples"`
	Attachments []attachCase    `json:"attachments"`
}
type recordingLine struct {
	Output string `json:"o"`
	Mark   string `json:"m"`
}

func recording(t *testing.T, file string) ([]byte, []restoreSample) {
	t.Helper()
	f, err := os.Open(file)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var data []byte
	marks := []restoreSample{}
	scanner := bufio.NewScanner(f)
	scanner.Buffer(nil, 1<<20)
	for scanner.Scan() {
		var line recordingLine
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
			t.Fatal(err)
		}
		if line.Output != "" {
			out, err := base64.StdEncoding.DecodeString(line.Output)
			if err != nil {
				t.Fatal(err)
			}
			data = append(data, out...)
		}
		if line.Mark != "" {
			marks = append(marks, restoreSample{At: len(data), Restore: line.Mark})
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return data, marks
}
func golden(data []byte, marks []restoreSample) []byte {
	g := trackerGolden{Safe: make([]byte, (len(data)+7)/8), Samples: []restoreSample{}, Attachments: []attachCase{}}
	t := newTracker()
	for i, b := range data {
		t.step(b)
		if t.ground() {
			g.Safe[i/8] |= 1 << uint(i%8)
			// Every safe cut is checked; modes are sampled at the first 20,
			// then approximately every 997 bytes, and at the final byte.
			if len(g.Samples) < 20 || i%997 == 0 || i == len(data)-1 {
				g.Samples = append(g.Samples, restoreSample{At: i + 1, Restore: t.restore()})
			}
		}
	}
	for _, mark := range marks {
		for _, size := range []int{512, 2048, 8192, 65536, len(data)} {
			r := newRing(max(size, 1))
			r.append(data[:mark.At])
			cut, tr, _ := r.cut()
			g.Attachments = append(g.Attachments, attachCase{Mark: mark.Restore, At: mark.At, Ring: size, Cut: int(cut), Restore: tr.restore()})
		}
	}
	out, _ := json.MarshalIndent(g, "", "  ")
	return append(out, '\n')
}
func checkGolden(t *testing.T, file string, actual []byte) {
	t.Helper()
	if *updateGolden {
		if err := os.WriteFile(file, actual, 0644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, want) {
		t.Fatalf("golden differs: %s (regenerate with -update)", file)
	}
}
func TestTrackerGolden(t *testing.T) {
	files, err := filepath.Glob("testdata/recordings/*.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		t.Run(filepath.Base(file), func(t *testing.T) {
			data, marks := recording(t, file)
			checkGolden(t, file+".golden.json", golden(data, marks))
		})
	}
	for _, seed := range []int64{1, 2, 3} {
		t.Run(string(rune('0'+seed)), func(t *testing.T) {
			data := adversarial(seed, 16384)
			file := filepath.Join("testdata", "adversarial-"+string(rune('0'+seed))+".bin")
			checkGolden(t, file, data)
			checkGolden(t, file+".golden.json", golden(data, nil))
		})
	}
	t.Run("collector", func(t *testing.T) {
		data := []byte("\x1b[" + strings.Repeat(" ", 4096) + "q\x1b[?2004hhello\x1b[?2004l")
		tracker := newTracker()
		tracker.write(data[:4098])
		if len(tracker.collect) > 3 {
			t.Fatalf("unbounded collect: %d", len(tracker.collect))
		}
		checkGolden(t, "testdata/adversarial-collector.bin", data)
		checkGolden(t, "testdata/adversarial-collector.bin.golden.json", golden(data, nil))
	})

}

// adversarial is the experiment's generator, with a bounded stream per seed.
func adversarial(seed int64, size int) []byte {
	r := rand.New(rand.NewSource(seed))
	pieces := []string{
		"\x1b[", "\x1b]", "\x1bP", "\x1b^", "\x1b_", "\x1bX", "\x1b\\", "\x07", "\x18", "\x1a", "\x1b", "\x0e", "\x0f",
		"\xc2\x9b", "\xc2\x9d", "\xc2\x90", "\xc2\x9c", "\xc2\x98", "\xc2\x9e", "\xc2\x9f", "\xc2\x85", "\xc2", "\xc2\xa0",
		"?1049h", "?1049l", "?47h", "?1047l", "?1h", "?1l", "?25l", "?25h", "?2004h", "?2004l", "?1000h", "?1002h", "?1003h", "?1000l", "?1006h", "?1006l", "?1015h", "?1016h", "?9h",
		"?7l", "?7h", "?6h", "?6l", "?45h", "?66h", "?66l", "?1004h", "?1004l", "?12h", "?1;25;2004h", "?1;1000;1006l",
		"4h", "4l", "20h", "20l", "1;10r", "r", "5;20r", "2 q", "0 q", "!p", "m", "1;31m", "38:2::1:2:3m", "H", "2J", "6n", "c", ">c", "?u", "0;0H",
		"(0", "(B", ")0", ")B", "*A", "+0", "=", ">", "c", "7", "8", "#8", " F", "M", "D",
		"0;title", "52;c;aGk=", "é", "漢", "😀", "\xe6", "\xf0\x9f", "\xff", "\x80", "hello", "\r\n", " ", ";", ":", "1", "0", "$q", "+q", "q", "p", "\x00", "\x7f", "~",
	}
	out := make([]byte, 0, size)
	for len(out) < size {
		out = append(out, pieces[r.Intn(len(pieces))]...)
	}
	return out
}
