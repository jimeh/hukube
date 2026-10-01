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

// Find returns the Resources among those q selects whose names best match
// p.Text, best first, keeping at most p.Limit of them.
func Find(store *index.Store, q *Compiled, p protocol.FindParams) protocol.FindResult {
	// Non-nil so an empty result encodes as [] rather than null.
	result := protocol.FindResult{Text: p.Text, Where: p.Where, Rows: []protocol.Row{}}
	words := parseWords(p.Text)
	if len(words) == 0 {
		return result
	}
	limit := min(max(p.Limit, 0), MaxFindLimit)

	m := newMatcher()
	best := make(worstFirst, 0, limit)
	store.Each(q.types, func(t protocol.TypeKey, meta index.Meta) {
		if !q.match(t, meta) {
			return
		}
		score := 0
		for _, w := range words {
			s, ok := m.match(meta.Name, w)
			if !ok {
				return
			}
			score += s
		}
		result.Total++
		candidate := match{score: score, row: protocol.Row{
			UID:       meta.UID,
			Type:      t,
			Namespace: meta.Namespace,
			Name:      meta.Name,
			CreatedAt: meta.CreatedAt,
		}}
		switch {
		case len(best) < limit:
			heap.Push(&best, candidate)
		case limit > 0 && rank(&candidate, &best[0]) < 0:
			best[0] = candidate
			heap.Fix(&best, 0)
		}
	})

	slices.SortFunc(best, func(a, b match) int { return rank(&a, &b) })
	for _, b := range best {
		result.Rows = append(result.Rows, b.row)
	}
	return result
}
