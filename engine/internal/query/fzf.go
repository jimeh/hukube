package query

import (
	"unsafe"

	"github.com/junegunn/fzf/src/algo"
	"github.com/junegunn/fzf/src/util"
)

// This file is the only one that uses fzf, whose matcher is internal to the
// fzf application rather than a library with a stable API.

func init() {
	// fzf's scoring tables stay empty until a scheme is chosen.
	algo.Init("default")
}

// fzf's own slab sizes; a slab holds the scratch space of one match at a time.
const (
	slab16Size = 100 * 1024
	slab32Size = 2048
)

// matcher scores names against find words. It is not safe for concurrent
// use, because its slab is reused across matches.
type matcher struct {
	slab *util.Slab
}

func newMatcher() *matcher {
	return &matcher{slab: util.MakeSlab(slab16Size, slab32Size)}
}

// match reports whether name matches w, ignoring case, and with what score;
// higher is better.
func (m *matcher) match(name string, w word) (int, bool) {
	// fzf only reads the bytes, so they can share the string's memory instead
	// of copying every name the index holds.
	chars := util.ToChars(unsafe.Slice(unsafe.StringData(name), len(name)))
	fn := algo.FuzzyMatchV2
	if w.exact {
		fn = algo.ExactMatchNaive
	}
	res, _ := fn(false, false, true, &chars, w.pattern, false, m.slab)
	return res.Score, res.Start >= 0
}
