# The window owns typed Commands and conditional keybindings

One runtime at the root owns command invocation, keyboard arbitration and the
Command palette. Workspace registrations hold live capability references and
per-mount tokens. Captured origins retain the actual Dockview panel, Pane,
params, Resource UID, terminal and focus owner. Resolving the same ID again
cannot redirect an invocation to a replacement. Delayed close confirmations
recheck that identity before using the existing guard and session owners.

The existing modal-inert hook exposes a subscribed modal count while preserving
its original inert restoration. Arbitration subtracts the palette's known
registration to detect unrelated dialogs. CommandDialog forwards initial and
return-focus ownership: search gets initial focus, and the runtime waits for
release or explicitly hands focus to Review, Settings or a close confirmation.

The catalog validates named arguments with Zod. Missing prompted fields open a
form in the palette; invalid supplied arguments never run. Review retains the
existing edit owner. Navigation, menus and controls use the same path, while
owner operations remain separate to avoid dispatch recursion. Pane zoom and
Log Stream filtering registrations remain bounded follow-ups: their actions
are local to feature components and need new owner adapters before the runtime
can call them directly. Their merged behavior remains intact.

Headless @tanstack/hotkeys 0.18.0 supplies logical and physical normalization,
per-stroke matching, labels and recording. One arbiter chooses the last eligible
rule. App rules cannot take live terminal input. Explicit terminal rules can;
Mod+J cannot be bound. xterm reads the arbiter's event verdict and preserves
native browser paste without executing a command twice. Consumed physical keys
remain consumed through repeats and release, including palette focus changes.

jsep 1.6.0 parses bounded typed conditions without evaluation of JavaScript.
A whitelist interpreter rejects unknown contexts, operators and value types.
Single-stroke versus chord-prefix ambiguity is rejected unless a bounded truth
space proves conditions disjoint. Chords use an injected clock and never replay
consumed prefixes.

`app/keybindings` is a separate version-1 Engine setting. The Engine bounds
shape, argument nesting, counts and byte size, preserves future fields, and
requires CAS even for the first write. The client watches once per Engine
client and activates an entire map only after settled write and confirmed fresh
readback. Invalid known rules retain the last good map; future versions are
read-only. Unknown commands and future rule semantics remain inert and retain
copyable recovery data. Local draft conflicts preserve their stable IDs and the
last active map until reload/discard or an explicitly reviewed CAS retry.

Appearance and Log Stream preferences keep their existing persistence owner.
The keyboard editor has explicit rule and document Save/Cancel operations and
its own open-work flag. No generic Engine method, apply/delete action, Exec
rerun, extension host, macro, or OS hotkey is exposed.
