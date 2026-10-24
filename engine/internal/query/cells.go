package query

import (
	"cmp"
	"fmt"
	"time"
)

// A cell is ordered by what it holds rather than by its Column's declared
// type, because the Cluster's built-in types declare most columns as strings:
// a count arrives as a number or as "3", and an age as "5m". Cells of
// different kinds are ordered by kind, so that any mix of cells still has one
// consistent order.
const (
	// kindAbsent is the zero value: a cell that holds nothing.
	kindAbsent = iota
	kindNumber
	kindBool
	kindAge
	// kindTime is a time the Engine read from a Resource (ADR-0027).
	kindTime
	kindText
)

// sortKey is the value a cell is ordered by.
type sortKey struct {
	kind   int
	number float64
	time   time.Time
	text   string
}

func cellKey(cell any) sortKey {
	switch v := cell.(type) {
	case nil:
		return sortKey{}
	case int64:
		return sortKey{kind: kindNumber, number: float64(v)}
	case float64:
		return sortKey{kind: kindNumber, number: v}
	case bool:
		if v {
			return sortKey{kind: kindBool, number: 1}
		}
		return sortKey{kind: kindBool}
	case string:
		if age, ok := parseAge(v); ok {
			return sortKey{kind: kindAge, number: age}
		}
		return sortKey{kind: kindText, text: v}
	case time.Time:
		return sortKey{kind: kindTime, time: v}
	default:
		return sortKey{kind: kindText, text: fmt.Sprint(v)}
	}
}

// compareKeys orders the keys of two cells: numbers by value, false before
// true, ages by length, times newest first, as the ages since them would be,
// and any other text in natural order.
func compareKeys(a, b sortKey) int {
	return cmp.Or(
		cmp.Compare(a.kind, b.kind),
		cmp.Compare(a.number, b.number),
		b.time.Compare(a.time),
		compareNatural(a.text, b.text),
	)
}

// parseAge reads a duration as the API server renders one, such as "45s",
// "2m30s", "5d", or "2y45d", and returns it in seconds.
func parseAge(s string) (float64, bool) {
	if s == "" {
		return 0, false
	}
	var total float64
	for len(s) > 0 {
		n := digits(s)
		if n == 0 || n == len(s) {
			return 0, false
		}
		var value float64
		for _, d := range []byte(s[:n]) {
			value = value*10 + float64(d-'0')
		}
		switch s[n] {
		case 's':
		case 'm':
			value *= 60
		case 'h':
			value *= 60 * 60
		case 'd':
			value *= 24 * 60 * 60
		case 'y':
			value *= 365 * 24 * 60 * 60
		default:
			return 0, false
		}
		total += value
		s = s[n+1:]
	}
	return total, true
}

// compareNatural orders text so that runs of digits compare as numbers:
// "3 (5m ago)" comes before "12", and "9/10" before "10/10".
func compareNatural(a, b string) int {
	for len(a) > 0 && len(b) > 0 {
		na, nb := digits(a), digits(b)
		if na > 0 && nb > 0 {
			if c := compareDigits(a[:na], b[:nb]); c != 0 {
				return c
			}
			a, b = a[na:], b[nb:]
			continue
		}
		if a[0] != b[0] {
			return cmp.Compare(a[0], b[0])
		}
		a, b = a[1:], b[1:]
	}
	return cmp.Compare(len(a), len(b))
}

// digits returns the length of the run of digits s starts with.
func digits(s string) int {
	n := 0
	for n < len(s) && s[n] >= '0' && s[n] <= '9' {
		n++
	}
	return n
}

// compareDigits orders two runs of digits by the numbers they spell.
func compareDigits(a, b string) int {
	for len(a) > 1 && a[0] == '0' {
		a = a[1:]
	}
	for len(b) > 1 && b[0] == '0' {
		b = b[1:]
	}
	return cmp.Or(cmp.Compare(len(a), len(b)), cmp.Compare(a, b))
}
