package query

import (
	"cmp"
	"container/heap"
	"slices"
	"strings"

	"github.com/jimeh/hukube/engine/internal/index"
	"github.com/jimeh/hukube/engine/internal/protocol"
)

// MaxFindLimit caps the number of Rows in one find result.
const MaxFindLimit = 200

// word is one word of a find's text.
type word struct {
	// pattern is lowercase, as fzf expects for case-insensitive matching.
	pattern []rune
	// exact matches the pattern as a substring instead of fuzzily.
	exact bool
}

// parseWords splits find text into words. A word starting with "'" is exact;
// "'" alone is not a word.
func parseWords(text string) []word {
	var words []word
	for _, f := range strings.Fields(strings.ToLower(text)) {
		w := word{pattern: []rune(f)}
		if rest, ok := strings.CutPrefix(f, "'"); ok {
			w = word{pattern: []rune(rest), exact: true}
		}
		if len(w.pattern) > 0 {
			words = append(words, w)
		}
	}
	return words
}

type match struct {
	row   protocol.Row
	score int
}

// rank orders matches best first: higher score, then shorter name, then
// name, namespace, and type. It compares the cheap keys first and returns as
// soon as they differ, because it runs for every matching Resource.
func rank(a, b *match) int {
	if c := cmp.Compare(b.score, a.score); c != 0 {
		return c
	}
	if c := cmp.Compare(len(a.row.Name), len(b.row.Name)); c != 0 {
		return c
	}
	if c := strings.Compare(a.row.Name, b.row.Name); c != 0 {
		return c
	}
	if c := strings.Compare(a.row.Namespace, b.row.Namespace); c != 0 {
		return c
	}
	return strings.Compare(string(a.row.Type), string(b.row.Type))
}

// worstFirst is a heap of the best matches found so far, with the worst on
// top, so it can be replaced when a better match turns up.
type worstFirst []match

func (h worstFirst) Len() int           { return len(h) }
func (h worstFirst) Less(i, j int) bool { return rank(&h[i], &h[j]) > 0 }
func (h worstFirst) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *worstFirst) Push(x any)        { *h = append(*h, x.(match)) }
func (h *worstFirst) Pop() any {
	old := *h
	m := old[len(old)-1]
	*h = old[:len(old)-1]
	return m
}

// offer keeps m if it ranks among the best limit matches seen so far.
func (h *worstFirst) offer(m match, limit int) {
	switch {
	case len(*h) < limit:
		heap.Push(h, m)
	case limit > 0 && rank(&m, &(*h)[0]) < 0:
		(*h)[0] = m
		heap.Fix(h, 0)
	}
}

// Finder runs the finds of one subscription. It reuses its scratch space
// between runs, so it is not safe for concurrent use.
type Finder struct {
	matcher    *matcher
	candidates []protocol.Row
	// beforeScore, when set, runs after the candidates are collected and
	// before they are scored. Tests use it to observe the index unlocked.
	beforeScore func()
}

// NewFinder returns a Finder with empty scratch space.
func NewFinder() *Finder {
	return &Finder{matcher: newMatcher()}
}

// Find returns the Resources among those q selects whose names best match
// p.Text, best first, keeping at most p.Limit of them.
//
// Scoring is far slower than selecting, so Find copies the selected
// Resources while it holds the index's lock and scores them after releasing
// it, so that indexing never waits for a find.
func (f *Finder) Find(store *index.Store, q *Compiled, p protocol.FindParams) protocol.FindResult {
	// Non-nil so an empty result encodes as [] rather than null.
	result := protocol.FindResult{Text: p.Text, Where: p.Where, Rows: []protocol.Row{}}
	words := parseWords(p.Text)
	if len(words) == 0 {
		return result
	}
	limit := min(max(p.Limit, 0), MaxFindLimit)

	// Size the buffer first, so the copy below does not grow it while holding
	// the index's lock. Resources indexed in between are appended as usual.
	candidates := f.candidates[:0]
	if need := store.Total(q.types); cap(candidates) < need {
		candidates = make([]protocol.Row, 0, need)
	}
	store.Each(q.types, func(t protocol.TypeKey, meta index.Meta) {
		if q.match(t, meta) {
			candidates = append(candidates, protocol.Row{
				UID:       meta.UID,
				Type:      t,
				Namespace: meta.Namespace,
				Name:      meta.Name,
				CreatedAt: meta.CreatedAt,
			})
		}
	})
	// Keep the grown buffer for the next run, but not the rows it points to.
	defer func() {
		clear(candidates)
		f.candidates = candidates[:0]
	}()
	if f.beforeScore != nil {
		f.beforeScore()
	}

	best := make(worstFirst, 0, limit)
candidates:
	for _, row := range candidates {
		score := 0
		for _, w := range words {
			s, ok := f.matcher.match(row.Name, w)
			if !ok {
				continue candidates
			}
			score += s
		}
		result.Total++
		best.offer(match{score: score, row: row}, limit)
	}

	slices.SortFunc(best, func(a, b match) int { return rank(&a, &b) })
	for _, b := range best {
		result.Rows = append(result.Rows, b.row)
	}
	return result
}
