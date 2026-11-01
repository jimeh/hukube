import { Button } from "@hukube/ui/components/button";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { monaco } from "@/lib/monaco.ts";
import { useTheme } from "@/lib/theme.ts";
import { applyEditorTheme } from "../resource/editor-theme.ts";
import { type LogDocument, type LogRow } from "./log-document.ts";
import {
  anchorPosition,
  newProjectedRows,
  restorePosition,
  sequenceEdits,
  sequenceIndex,
  type SequencePosition,
} from "./log-editor-sequences.ts";

/** How many characters edits may add to the model before it is built again. */
const rebuildAfter = 8_000_000;

let editors = 0;

export interface LogEditorHandle {
  search(): void;
}

/** Owns the real editor, incremental edits, decorations, and viewport position. */
export default function LogEditor({
  document: log,
  wrap,
  label,
  ref,
}: {
  document: LogDocument;
  wrap: boolean;
  label: string;
  ref?: Ref<LogEditorHandle>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const searchRef = useRef<(() => void) | undefined>(undefined);
  const follow = useRef(true);
  const ownScroll = useRef(false);
  const [following, setFollowing] = useState(true);
  const [newLines, setNewLines] = useState(0);
  const theme = useTheme();
  useImperativeHandle(
    ref,
    () => ({
      search: () => searchRef.current?.(),
    }),
    [],
  );
  const newest = () => {
    follow.current = true;
    setFollowing(true);
    setNewLines(0);
    ownScroll.current = true;
    editorRef.current?.setScrollTop(
      editorRef.current.getScrollHeight(),
      monaco.editor.ScrollType.Immediate,
    );
    ownScroll.current = false;
    // The button is about to go, and focus would go with it.
    editorRef.current?.focus();
  };
  useEffect(() => {
    if (!container.current) return;
    const model = monaco.editor.createModel("", "plaintext");
    model.setEOL(monaco.editor.EndOfLineSequence.LF);
    const editor = monaco.editor.create(container.current, {
      model,
      readOnly: true,
      domReadOnly: true,
      ariaLabel: label,
      minimap: { enabled: false },
      lineNumbers: "off",
      // Lines start where the toolbar's and the header's text does.
      lineDecorationsWidth: 12,
      glyphMargin: false,
      folding: false,
      links: false,
      contextmenu: true,
      find: {
        // Only what the user selected is searched for, not the word the caret
        // happens to be in, and the view stays put until they ask for a match.
        seedSearchStringFromSelection: "selection",
        cursorMoveOnType: false,
      },
      scrollBeyondLastLine: false,
      wordWrap: wrap ? "on" : "off",
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 18,
      renderLineHighlight: "none",
      padding: { top: 8 },
      stickyScroll: { enabled: false },
      occurrencesHighlight: "off",
      selectionHighlight: false,
      unicodeHighlight: {
        ambiguousCharacters: false,
        invisibleCharacters: false,
        nonBasicASCII: false,
      },
      unusualLineTerminators: "off",
      stopRenderingLineAfter: -1,
      guides: { indentation: false, bracketPairs: false },
      matchBrackets: "never",
      hover: { enabled: "off" },
    });
    editorRef.current = editor;
    // A log is read from its end. With the caret there, the nearest match is
    // the newest one, and Enter in the find box goes to it and then to older
    // ones, as it does in VS Code's terminal. Shift+Enter goes the other way.
    const openSearch = () => {
      editor.focus();
      if (follow.current && editor.getSelection()?.isEmpty())
        editor.setPosition({ lineNumber: model.getLineCount(), column: 1 });
      void editor.getAction("actions.find")?.run();
    };
    searchRef.current = openSearch;
    // Monaco's key bindings are shared by every editor, so these are bound
    // to a context key that only this editor sets.
    const scope = `hukubeLogEditor${++editors}`;
    editor.createContextKey(scope, true);
    const actions = [
      editor.addAction({
        id: "hukube.logs.find",
        label: "Search",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF],
        keybindingContext: scope,
        run: openSearch,
      }),
      editor.addAction({
        id: "hukube.logs.newerMatch",
        label: "Previous Match",
        keybindings: [monaco.KeyCode.Enter],
        keybindingContext: `${scope} && findInputFocussed`,
        run: () => editor.getAction("editor.action.previousMatchFindAction")?.run(),
      }),
      editor.addAction({
        id: "hukube.logs.olderMatch",
        label: "Next Match",
        keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.Enter],
        keybindingContext: `${scope} && findInputFocussed`,
        run: () => editor.getAction("editor.action.nextMatchFindAction")?.run(),
      }),
    ];
    const none: readonly string[] = [];
    let decorationIds: (readonly string[])[] = [];
    const options = new Map<string, monaco.editor.IModelDecorationOptions>();
    // One call for the whole batch: each call makes Monaco announce a change.
    const decorations = (rows: LogRow[], first: number): (readonly string[])[] => {
      const added = rows.flatMap((row, index) =>
        row.spans.map((span) => {
          let option = options.get(span.className);
          if (!option) {
            option = {
              inlineClassName: span.className,
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            };
            options.set(span.className, option);
          }
          return {
            range: new monaco.Range(first + index, span.start + 1, first + index, span.end + 1),
            options: option,
          };
        }),
      );
      const ids = added.length ? model.deltaDecorations([], added) : none;
      let next = 0;
      return rows.map((row) =>
        row.spans.length ? ids.slice(next, (next += row.spans.length)) : none,
      );
    };
    const removeDecorations = (rows: readonly (readonly string[])[]) => {
      const ids = rows.flat();
      if (ids.length) model.deltaDecorations(ids, []);
    };
    // Numeric identities describe the old model even after a projection changes.
    // No text history is kept alongside the document and Monaco.
    let shownSequences: number[] = [];
    let shownRewrites = log.rewrites;
    let shownFilter = log.filterRevision;
    let watermark = log.nextSequence;
    let selectionAnchor: { start: SequencePosition; end: SequencePosition } | undefined;
    let selectionChanged = true;
    let topAnchor: { sequence: number; offset: number } | undefined;
    // Monaco's text buffer only grows: an edit is added to it and text that
    // is deleted stays. This counts what the edits have added, so the model
    // can be built again from the rows before that outgrows them.
    let added = 0;
    const text = (rows: LogRow[]) =>
      rows.length ? `${rows.map((row) => row.text).join("\n")}\n` : "";
    const synchronize = () => {
      ownScroll.current = true;
      const rows = log.visibleRows;
      const sequences = rows.map((row) => row.sequence);
      const edits = sequenceEdits(shownSequences, sequences);
      // Keep meaningful anchors through an empty projection. Its placeholder
      // line has no entry identity and must not overwrite them.
      if (shownSequences.length) {
        const top = editor.getVisibleRanges()[0]?.startLineNumber;
        if (top !== undefined)
          topAnchor = {
            sequence: shownSequences[Math.min(top - 1, shownSequences.length - 1)]!,
            offset: editor.getScrollTop() - editor.getTopForLineNumber(top),
          };
        const selection = editor.getSelection();
        if (selection && selectionChanged) {
          const start = anchorPosition(
            shownSequences,
            selection.selectionStartLineNumber,
            selection.selectionStartColumn,
          )!;
          const end = anchorPosition(
            shownSequences,
            selection.positionLineNumber,
            selection.positionColumn,
          )!;
          selectionAnchor = { start, end };
          selectionChanged = false;
        }
      }
      if (
        !edits ||
        shownRewrites !== log.rewrites ||
        shownFilter !== log.filterRevision ||
        added > rebuildAfter
      ) {
        model.setValue(text(rows));
        decorationIds = decorations(rows, 1);
        added = 0;
      } else {
        if (edits.removed > 0) {
          removeDecorations(decorationIds.splice(0, edits.removed));
          model.applyEdits([{ range: new monaco.Range(1, 1, edits.removed + 1, 1), text: null }]);
        }
        const appended = edits.appended ? rows.slice(rows.length - edits.appended) : [];
        if (appended.length) {
          const line = model.getLineCount();
          const inserted = text(appended);
          model.applyEdits([{ range: new monaco.Range(line, 1, line, 1), text: inserted }]);
          added += inserted.length;
          for (const ids of decorations(appended, line)) decorationIds.push(ids);
        }
      }
      if (sequences.length && selectionAnchor) {
        const start = restorePosition(sequences, selectionAnchor.start, (line) =>
          model.getLineMaxColumn(line),
        );
        const end = restorePosition(sequences, selectionAnchor.end, (line) =>
          model.getLineMaxColumn(line),
        );
        editor.setSelection(
          new monaco.Selection(start.lineNumber, start.column, end.lineNumber, end.column),
        );
        // Keep the resolved fallback and clamped columns, but preserve affinity
        // when the next model line is now an appended entry rather than EOF.
        selectionAnchor.start.sequence =
          sequences[sequenceIndex(sequences, selectionAnchor.start.sequence)]!;
        selectionAnchor.start.column = start.column;
        selectionAnchor.end.sequence =
          sequences[sequenceIndex(sequences, selectionAnchor.end.sequence)]!;
        selectionAnchor.end.column = end.column;
        selectionChanged = false;
      }
      if (follow.current)
        editor.setScrollTop(editor.getScrollHeight(), monaco.editor.ScrollType.Immediate);
      else {
        if (sequences.length && topAnchor)
          editor.setScrollTop(
            Math.max(
              0,
              editor.getTopForLineNumber(sequenceIndex(sequences, topAnchor.sequence) + 1) +
                topAnchor.offset,
            ),
            monaco.editor.ScrollType.Immediate,
          );
        setNewLines(newProjectedRows(sequences, watermark));
      }
      shownSequences = sequences;
      shownRewrites = log.rewrites;
      shownFilter = log.filterRevision;
      ownScroll.current = false;
    };
    // Lines can arrive many times a frame. One edit a frame is all that can
    // be seen, and a large edit costs the text buffer less than many small ones.
    let pending = 0;
    const schedule = () => {
      pending ||= requestAnimationFrame(() => {
        pending = 0;
        synchronize();
      });
    };
    const scroll = editor.onDidScrollChange((event) => {
      // A user's scroll moves the view and nothing else. One that comes with a
      // new content height is Monaco wrapping or measuring again, which the
      // content size listener answers.
      if (ownScroll.current || !event.scrollTopChanged || event.scrollHeightChanged) return;
      const atBottom = event.scrollTop + editor.getLayoutInfo().height >= event.scrollHeight - 2;
      if (follow.current && !atBottom) watermark = log.nextSequence;
      follow.current = atBottom;
      setFollowing(follow.current);
      if (follow.current) setNewLines(0);
    });
    const selection = editor.onDidChangeCursorSelection((event) => {
      // Restoring an after-row endpoint can put it at an appended row's start.
      // Only a new external selection may replace that endpoint's affinity.
      if (!ownScroll.current) selectionChanged = true;
      if (!ownScroll.current && !event.selection.isEmpty()) {
        if (follow.current) watermark = log.nextSequence;
        follow.current = false;
        setFollowing(false);
      }
    });
    const height = editor.onDidContentSizeChange(() => {
      if (!follow.current || ownScroll.current) return;
      ownScroll.current = true;
      editor.setScrollTop(editor.getScrollHeight(), monaco.editor.ScrollType.Immediate);
      ownScroll.current = false;
    });
    let frame = 0;
    const resize = new ResizeObserver(([entry]) => {
      cancelAnimationFrame(frame);
      // A hidden editor has no size. Laying it out would wrap every line at nothing.
      if (!entry?.contentRect.width || !entry.contentRect.height) return;
      frame = requestAnimationFrame(() => {
        ownScroll.current = true;
        editor.layout();
        if (follow.current)
          editor.setScrollTop(editor.getScrollHeight(), monaco.editor.ScrollType.Immediate);
        ownScroll.current = false;
      });
    });
    resize.observe(container.current);
    const unsubscribe = log.subscribe(schedule);
    synchronize();
    void document.fonts.load('12px "JetBrains Mono Variable"').then(() => {
      ownScroll.current = true;
      monaco.editor.remeasureFonts();
      if (follow.current)
        editor.setScrollTop(editor.getScrollHeight(), monaco.editor.ScrollType.Immediate);
      ownScroll.current = false;
    });
    return () => {
      unsubscribe();
      for (const action of actions) action.dispose();
      cancelAnimationFrame(pending);
      cancelAnimationFrame(frame);
      resize.disconnect();
      scroll.dispose();
      selection.dispose();
      height.dispose();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
    };
    // The document owns this editor; display options update it in place.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [log]);
  useEffect(() => {
    ownScroll.current = true;
    editorRef.current?.updateOptions({ wordWrap: wrap ? "on" : "off", ariaLabel: label });
    if (follow.current)
      editorRef.current?.setScrollTop(
        editorRef.current.getScrollHeight(),
        monaco.editor.ScrollType.Immediate,
      );
    ownScroll.current = false;
  }, [wrap, label]);
  useEffect(() => {
    if (container.current) return applyEditorTheme(monaco, container.current, theme === "dark");
  }, [theme]);
  return (
    <div className="relative h-full min-h-0">
      <div ref={container} className="h-full min-h-0" />
      {!following && (
        <Button
          variant="secondary"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm"
          onClick={newest}
        >
          <HugeiconsIcon icon={ArrowDown01Icon} data-icon="inline-start" aria-hidden="true" />
          Newest{newLines > 0 && ` · ${newLines.toLocaleString()} new`}
        </Button>
      )}
    </div>
  );
}
