package execsession

import (
	"fmt"
	"strings"
)

// tracker follows a terminal's modes through a stream of output without
// keeping a screen. It reads the bytes that leave a session's ring.
//
// It reads bytes the way xterm.js 6.0.0 does, because xterm.js is what replays
// them: the same UTF-8 decoding (input/TextDecoder.ts), the same parser states
// and transitions (parser/EscapeSequenceParser.ts), and the same effect of
// each sequence on a mode (InputHandler.ts).
type tracker struct {
	// The UTF-8 character being read: its lead byte, the code point so far,
	// and the continuation bytes it still needs.
	lead byte
	cp   rune
	need int

	state    uint8
	collect  []byte
	params   []int
	subparam bool
	rejected bool

	modes
}

// modes is what a terminal that reads the rest of the stream must already have.
type modes struct {
	cursorKeys, keypad, bracketedPaste, origin, reverseWrap, sendFocus bool
	noWrap, cursorHidden, insert, alt                                  bool
	// mouse is the tracking mode's number, and mouseEncoding its encoding's.
	mouse, mouseEncoding int
	// cursorStyle is "", "block", "underline", or "bar". cursorBlink and the two
	// below are 0 while the stream has not set them, then 1 for off and 2 for on.
	cursorStyle string
	cursorBlink uint8
	// blink (mode 12) and newline (mode 20) set options of xterm.js, which a
	// reset of the terminal leaves alone.
	blink, newline uint8
	// region is each buffer's scroll region as the stream gave it, with 0 for
	// a bound it left out.
	region   [2][2]int
	charsets [4]byte
	glevel   int
}

const (
	sGround uint8 = iota
	sEscape
	sEscapeIntermediate
	sCsiEntry
	sCsiParam
	sCsiIntermediate
	sCsiIgnore
	sString
	sOsc
	sDcsEntry
	sDcsParam
	sDcsIgnore
	sDcsIntermediate
	sDcsPassthrough
	stateCount
)

const (
	aIgnore uint8 = iota
	aError
	aExecute
	aClear
	aCollect
	aParam
	aEscDispatch
	aCsiDispatch
)

// nonASCII is the code every character from U+00A0 up is parsed as.
const nonASCII = 0xa0

type transition struct{ action, next uint8 }

var transitions = func() (table [stateCount][nonASCII + 1]transition) {
	add := func(codes []int, state, action, next uint8) {
		for _, code := range codes {
			table[state][code] = transition{action, next}
		}
	}
	r := func(start, end int) []int {
		codes := make([]int, 0, end-start)
		for code := start; code < end; code++ {
			codes = append(codes, code)
		}
		return codes
	}
	printables := r(0x20, 0x7f)
	executables := append(append(r(0x00, 0x18), 0x19), r(0x1c, 0x20)...)
	for state := range table {
		for code := range table[state] {
			table[state][code] = transition{aError, sGround}
		}
	}
	add(printables, sGround, aIgnore, sGround)
	for s := range table {
		state := uint8(s)
		add([]int{0x18, 0x1a, 0x99, 0x9a}, state, aExecute, sGround)
		add(r(0x80, 0x90), state, aExecute, sGround)
		add(r(0x90, 0x98), state, aExecute, sGround)
		add([]int{0x9c}, state, aIgnore, sGround)
		add([]int{0x1b}, state, aClear, sEscape)
		add([]int{0x9d}, state, aIgnore, sOsc)
		add([]int{0x98, 0x9e, 0x9f}, state, aIgnore, sString)
		add([]int{0x9b}, state, aClear, sCsiEntry)
		add([]int{0x90}, state, aClear, sDcsEntry)
	}
	add(executables, sGround, aExecute, sGround)
	add(executables, sEscape, aExecute, sEscape)
	add([]int{0x7f}, sEscape, aIgnore, sEscape)
	add(executables, sOsc, aIgnore, sOsc)
	add(executables, sCsiEntry, aExecute, sCsiEntry)
	add([]int{0x7f}, sCsiEntry, aIgnore, sCsiEntry)
	add(executables, sCsiParam, aExecute, sCsiParam)
	add([]int{0x7f}, sCsiParam, aIgnore, sCsiParam)
	add(executables, sCsiIgnore, aExecute, sCsiIgnore)
	add(executables, sCsiIntermediate, aExecute, sCsiIntermediate)
	add([]int{0x7f}, sCsiIntermediate, aIgnore, sCsiIntermediate)
	add(executables, sEscapeIntermediate, aExecute, sEscapeIntermediate)
	add([]int{0x7f}, sEscapeIntermediate, aIgnore, sEscapeIntermediate)
	add([]int{0x5d}, sEscape, aIgnore, sOsc)
	add(printables, sOsc, aIgnore, sOsc)
	add([]int{0x7f}, sOsc, aIgnore, sOsc)
	add([]int{0x9c, 0x1b, 0x18, 0x1a, 0x07}, sOsc, aIgnore, sGround)
	add(r(0x1c, 0x20), sOsc, aIgnore, sOsc)
	add([]int{0x58, 0x5e, 0x5f}, sEscape, aIgnore, sString)
	add(printables, sString, aIgnore, sString)
	add(executables, sString, aIgnore, sString)
	add([]int{0x9c}, sString, aIgnore, sGround)
	add([]int{0x7f}, sString, aIgnore, sString)
	add([]int{0x5b}, sEscape, aClear, sCsiEntry)
	add(r(0x40, 0x7f), sCsiEntry, aCsiDispatch, sGround)
	add(r(0x30, 0x3c), sCsiEntry, aParam, sCsiParam)
	add([]int{0x3c, 0x3d, 0x3e, 0x3f}, sCsiEntry, aCollect, sCsiParam)
	add(r(0x30, 0x3c), sCsiParam, aParam, sCsiParam)
	add(r(0x40, 0x7f), sCsiParam, aCsiDispatch, sGround)
	add([]int{0x3c, 0x3d, 0x3e, 0x3f}, sCsiParam, aIgnore, sCsiIgnore)
	add(r(0x20, 0x40), sCsiIgnore, aIgnore, sCsiIgnore)
	add([]int{0x7f}, sCsiIgnore, aIgnore, sCsiIgnore)
	add(r(0x40, 0x7f), sCsiIgnore, aIgnore, sGround)
	add(r(0x20, 0x30), sCsiEntry, aCollect, sCsiIntermediate)
	add(r(0x20, 0x30), sCsiIntermediate, aCollect, sCsiIntermediate)
	add(r(0x30, 0x40), sCsiIntermediate, aIgnore, sCsiIgnore)
	add(r(0x40, 0x7f), sCsiIntermediate, aCsiDispatch, sGround)
	add(r(0x20, 0x30), sCsiParam, aCollect, sCsiIntermediate)
	add(r(0x20, 0x30), sEscape, aCollect, sEscapeIntermediate)
	add(r(0x20, 0x30), sEscapeIntermediate, aCollect, sEscapeIntermediate)
	add(r(0x30, 0x7f), sEscapeIntermediate, aEscDispatch, sGround)
	add(r(0x30, 0x50), sEscape, aEscDispatch, sGround)
	add(r(0x51, 0x58), sEscape, aEscDispatch, sGround)
	add([]int{0x59, 0x5a, 0x5c}, sEscape, aEscDispatch, sGround)
	add(r(0x60, 0x7f), sEscape, aEscDispatch, sGround)
	add([]int{0x50}, sEscape, aClear, sDcsEntry)
	add(executables, sDcsEntry, aIgnore, sDcsEntry)
	add([]int{0x7f}, sDcsEntry, aIgnore, sDcsEntry)
	add(r(0x1c, 0x20), sDcsEntry, aIgnore, sDcsEntry)
	add(r(0x20, 0x30), sDcsEntry, aIgnore, sDcsIntermediate)
	add(r(0x30, 0x3c), sDcsEntry, aIgnore, sDcsParam)
	add([]int{0x3c, 0x3d, 0x3e, 0x3f}, sDcsEntry, aIgnore, sDcsParam)
	add(executables, sDcsIgnore, aIgnore, sDcsIgnore)
	add(r(0x20, 0x80), sDcsIgnore, aIgnore, sDcsIgnore)
	add(r(0x1c, 0x20), sDcsIgnore, aIgnore, sDcsIgnore)
	add(executables, sDcsParam, aIgnore, sDcsParam)
	add([]int{0x7f}, sDcsParam, aIgnore, sDcsParam)
	add(r(0x1c, 0x20), sDcsParam, aIgnore, sDcsParam)
	add(r(0x30, 0x3c), sDcsParam, aIgnore, sDcsParam)
	add([]int{0x3c, 0x3d, 0x3e, 0x3f}, sDcsParam, aIgnore, sDcsIgnore)
	add(r(0x20, 0x30), sDcsParam, aIgnore, sDcsIntermediate)
	add(executables, sDcsIntermediate, aIgnore, sDcsIntermediate)
	add([]int{0x7f}, sDcsIntermediate, aIgnore, sDcsIntermediate)
	add(r(0x1c, 0x20), sDcsIntermediate, aIgnore, sDcsIntermediate)
	add(r(0x20, 0x30), sDcsIntermediate, aIgnore, sDcsIntermediate)
	add(r(0x30, 0x40), sDcsIntermediate, aIgnore, sDcsIgnore)
	add(r(0x40, 0x7f), sDcsIntermediate, aIgnore, sDcsPassthrough)
	add(r(0x40, 0x7f), sDcsParam, aIgnore, sDcsPassthrough)
	add(r(0x40, 0x7f), sDcsEntry, aIgnore, sDcsPassthrough)
	add(executables, sDcsPassthrough, aIgnore, sDcsPassthrough)
	add(printables, sDcsPassthrough, aIgnore, sDcsPassthrough)
	add([]int{0x7f}, sDcsPassthrough, aIgnore, sDcsPassthrough)
	add([]int{0x1b, 0x9c, 0x18, 0x1a}, sDcsPassthrough, aIgnore, sGround)
	// The parser's loop, not its table, sends an ESC that ends a string on to
	// the escape state, so that the backslash after it ends nothing else.
	add([]int{0x1b}, sOsc, aClear, sEscape)
	add([]int{0x1b}, sDcsPassthrough, aClear, sEscape)
	add([]int{nonASCII}, sGround, aIgnore, sGround)
	add([]int{nonASCII}, sOsc, aIgnore, sOsc)
	add([]int{nonASCII}, sCsiIgnore, aIgnore, sCsiIgnore)
	add([]int{nonASCII}, sDcsIgnore, aIgnore, sDcsIgnore)
	add([]int{nonASCII}, sDcsPassthrough, aIgnore, sDcsPassthrough)
	return table
}()

func newTracker() *tracker { return &tracker{} }

func (t *tracker) clone() *tracker {
	c := *t
	c.collect = append([]byte(nil), t.collect...)
	c.params = append([]int(nil), t.params...)
	return &c
}

// ground reports whether output may be cut before the next byte: no
// character and no sequence is part read.
func (t *tracker) ground() bool { return t.state == sGround && t.need == 0 }

func (t *tracker) write(data []byte) {
	for _, b := range data {
		t.step(b)
	}
}

// step decodes UTF-8 as xterm.js does: a character cut short by a byte that
// does not continue it is dropped and that byte is read again, and an
// overlong or otherwise illegal character is dropped whole.
func (t *tracker) step(b byte) {
	defer func() {
		if recover() != nil {
			*t = tracker{}
		}
	}()
	if t.need > 0 {
		if b&0xc0 != 0x80 {
			t.need = 0
		} else {
			t.cp = t.cp<<6 | rune(b&0x3f)
			t.need--
			if t.need > 0 {
				return
			}
			switch {
			case t.lead&0xe0 == 0xc0:
				if t.cp >= 0x80 {
					t.parse(t.cp)
				}
			case t.lead&0xf0 == 0xe0:
				if t.cp >= 0x800 && (t.cp < 0xd800 || t.cp > 0xdfff) && t.cp != 0xfeff {
					t.parse(t.cp)
				}
			default:
				if t.cp >= 0x10000 && t.cp <= 0x10ffff {
					t.parse(t.cp)
				}
			}
			return
		}
	}
	switch {
	case b < 0x80:
		t.parse(rune(b))
	case b&0xe0 == 0xc0:
		t.lead, t.cp, t.need = b, rune(b&0x1f), 1
	case b&0xf0 == 0xe0:
		t.lead, t.cp, t.need = b, rune(b&0x0f), 2
	case b&0xf8 == 0xf0:
		t.lead, t.cp, t.need = b, rune(b&0x07), 3
	}
}

func (t *tracker) parse(cp rune) {
	code := int(cp)
	if code > nonASCII {
		code = nonASCII
	}
	tr := transitions[t.state][code]
	switch tr.action {
	case aExecute:
		switch code {
		case 0x0e:
			t.glevel = 1
		case 0x0f:
			t.glevel = 0
		}
	case aClear:
		t.collect, t.params = t.collect[:0], append(t.params[:0], 0)
		t.subparam, t.rejected = false, false
	case aCollect:
		// xterm.js shifts collect into a 32-bit identifier with the final
		// byte. Only the last three collected bytes can affect dispatch.
		if len(t.collect) == 3 {
			copy(t.collect, t.collect[1:])
			t.collect = t.collect[:2]
		}
		t.collect = append(t.collect, byte(code))
	case aParam:
		t.param(byte(code))
	case aEscDispatch:
		t.esc(byte(code))
	case aCsiDispatch:
		t.csi(byte(code))
	}
	t.state = tr.next
}

// param reads one byte of a sequence's parameters as xterm.js's Params does:
// a sequence starts with one parameter of 0, at most 32 are kept, and a
// sub-parameter, after a colon, is not one.
func (t *tracker) param(b byte) {
	switch {
	case b == ';':
		t.subparam = false
		if len(t.params) >= 32 {
			t.rejected = true
			return
		}
		t.params = append(t.params, 0)
	case b == ':':
		t.subparam = true
	case t.subparam || t.rejected:
	default:
		last := len(t.params) - 1
		t.params[last] = min(t.params[last]*10+int(b-'0'), 0x7fffffff)
	}
}

func (t *tracker) esc(final byte) {
	switch string(t.collect) {
	case "":
		switch final {
		case '=':
			t.keypad = true
		case '>':
			t.keypad = false
		case 'c':
			// A full reset leaves a hidden cursor hidden, and the options that
			// modes 12 and 20 set.
			t.modes = modes{cursorHidden: t.cursorHidden, blink: t.blink, newline: t.newline}
		case 'n', '}':
			t.glevel = 2
		case 'o', '|':
			t.glevel = 3
		case '~':
			t.glevel = 1
		}
	case "%":
		if final == '@' || final == 'G' {
			t.glevel, t.charsets[0] = 0, 0
		}
	case "(", ")", "*", "+", "-", ".":
		g := strings.IndexByte("()*+-.", t.collect[0])
		if g > 3 {
			g -= 3
		}
		if !strings.ContainsRune(charsetFlags, rune(final)) {
			return
		}
		t.charsets[g] = final
		if final == 'B' {
			t.charsets[g] = 0
		}
	}
}

// charsetFlags are the character sets xterm.js has, by their final byte.
const charsetFlags = "0AB4C5RQKYE6ZH7="

func (t *tracker) csi(final byte) {
	buffer := 0
	if t.alt {
		buffer = 1
	}
	switch string(t.collect) + string(final) {
	case "?h", "?l":
		for _, mode := range t.params {
			t.private(mode, final == 'h')
		}
	case "h", "l":
		for _, mode := range t.params {
			switch mode {
			case 4:
				t.insert = final == 'h'
			case 20:
				t.newline = tri(final == 'h')
			}
		}
	case "r":
		top, bottom := max(t.params[0], 1), 0
		if len(t.params) > 1 {
			bottom = t.params[1]
		}
		// xterm.js takes a region whose bottom is below its top. A bottom
		// left out is the last row, which only the terminal knows.
		switch {
		case top == 1 && bottom == 0:
			t.region[buffer] = [2]int{}
		case bottom == 0 || bottom > top:
			t.region[buffer] = [2]int{top, bottom}
		}
	case " q":
		param := t.params[0]
		if param == 0 {
			t.cursorStyle, t.cursorBlink = "", 0
			return
		}
		switch param {
		case 1, 2:
			t.cursorStyle = "block"
		case 3, 4:
			t.cursorStyle = "underline"
		case 5, 6:
			t.cursorStyle = "bar"
		}
		t.cursorBlink = tri(param%2 == 1)
	case "!p":
		// A soft reset leaves the mouse, the alternate screen, and the options.
		kept := t.modes
		t.modes = modes{mouse: kept.mouse, mouseEncoding: kept.mouseEncoding, alt: kept.alt, blink: kept.blink, newline: kept.newline, region: kept.region}
		t.region[buffer] = [2]int{}
	}
}

func tri(on bool) uint8 {
	if on {
		return 2
	}
	return 1
}

func (t *tracker) private(mode int, set bool) {
	switch mode {
	case 1:
		t.cursorKeys = set
	case 2:
		if set {
			t.charsets = [4]byte{}
		}
	case 6:
		t.origin = set
	case 7:
		t.noWrap = !set
	case 12:
		t.blink = tri(set)
	case 25:
		t.cursorHidden = !set
	case 45:
		t.reverseWrap = set
	case 66:
		t.keypad = set
	case 9, 1000, 1002, 1003:
		t.mouse = 0
		if set {
			t.mouse = mode
		}
	case 1004:
		t.sendFocus = set
	case 1006, 1016:
		t.mouseEncoding = 0
		if set {
			t.mouseEncoding = mode
		}
	case 47, 1047, 1049:
		// Leaving the alternate screen clears it, and its scroll region.
		if !set {
			t.region[1] = [2]int{}
		}
		t.alt = set
	case 2004:
		t.bracketedPaste = set
	}
}

// restore returns what brings a reset terminal to the tracked modes.
func (t *tracker) restore() string {
	var out strings.Builder
	region := func(r [2]int) {
		switch {
		case r == [2]int{}:
		case r[1] == 0:
			fmt.Fprintf(&out, "\x1b[%dr", r[0])
		default:
			fmt.Fprintf(&out, "\x1b[%d;%dr", r[0], r[1])
		}
	}
	region(t.region[0])
	if t.alt {
		out.WriteString("\x1b[?1049h")
		region(t.region[1])
	}
	for g, set := range t.charsets {
		if set != 0 {
			out.WriteString("\x1b" + string("()*+"[g]) + string(set))
		}
	}
	out.WriteString([]string{"", "\x0e", "\x1bn", "\x1bo"}[t.glevel])
	private := func(mode int, on, set bool) {
		switch {
		case !set:
		case on:
			fmt.Fprintf(&out, "\x1b[?%dh", mode)
		default:
			fmt.Fprintf(&out, "\x1b[?%dl", mode)
		}
	}
	private(1, true, t.cursorKeys)
	private(7, false, t.noWrap)
	private(12, t.blink == 2, t.blink != 0)
	// A reset terminal keeps its cursor as it was, shown or hidden.
	private(25, !t.cursorHidden, true)
	private(45, true, t.reverseWrap)
	private(66, true, t.keypad)
	private(1004, true, t.sendFocus)
	private(2004, true, t.bracketedPaste)
	private(t.mouse, true, t.mouse != 0)
	private(t.mouseEncoding, true, t.mouseEncoding != 0)
	if t.insert {
		out.WriteString("\x1b[4h")
	}
	if t.newline != 0 {
		out.WriteString(map[uint8]string{1: "\x1b[20l", 2: "\x1b[20h"}[t.newline])
	}
	if t.cursorBlink != 0 {
		style := map[string]int{"": 7, "block": 1, "underline": 3, "bar": 5}[t.cursorStyle]
		if t.cursorBlink == 1 {
			style++
		}
		fmt.Fprintf(&out, "\x1b[%d q", style)
	}
	// Setting the origin mode moves the cursor home, where a reset left it.
	private(6, true, t.origin)
	return out.String()
}
