import { Button } from "@hukube/ui/components/button";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { monaco } from "@/lib/monaco.ts";
import { useTheme } from "@/lib/theme.ts";
import { applyEditorTheme } from "../resource/editor-theme.ts";
import { type LogDocument, type LogRow } from "./log-document.ts";

/** How many characters edits may add to the model before it is built again. */
const rebuildAfter = 8_000_000;

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
  const follow = useRef(true);
  const ownScroll = useRef(false);
  const [following, setFollowing] = useState(true);
  const [newLines, setNewLines] = useState(0);
  const theme = useTheme();
  useImperativeHandle(
    ref,
    () => ({
      search: () => {
        const editor = editorRef.current;
        editor?.focus();
        void editor?.getAction("actions.find")?.run();
      },
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
      lineDecorationsWidth: 8,
      glyphMargin: false,
      folding: false,
      links: false,
      contextmenu: false,
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
    // The model holds the rows from sequence shownFirst on. Rows leave the
    // document at its head and join at its tail, so counting sequences says
    // what changed without keeping a copy of the rows.
    let shownFirst = 0;
    let shownCount = 0;
    let shownRewrites = log.rewrites;
    // Monaco's text buffer only grows: an edit is added to it and text that
    // is deleted stays. This counts what the edits have added, so the model
    // can be built again from the rows before that outgrows them.
    let added = 0;
    const text = (rows: LogRow[]) =>
      rows.length ? `${rows.map((row) => row.text).join("\n")}\n` : "";
    const synchronize = () => {
      ownScroll.current = true;
      const rows = log.rows;
      const first = rows[0]?.sequence ?? shownFirst + shownCount;
      const next = rows.length ? rows.at(-1)!.sequence + 1 : first;
      const received = Math.max(0, next - (shownFirst + shownCount));
      const removed = first - shownFirst;
      const kept = shownRewrites === log.rewrites && removed >= 0 && removed <= shownCount;
      if (!kept || added > rebuildAfter) {
        // Lines that are still there keep their place on screen and their selection.
        const shift = kept ? removed : undefined;
        const top = editor.getVisibleRanges()[0]?.startLineNumber ?? 1;
        const offset = editor.getScrollTop() - editor.getTopForLineNumber(top);
        const selection = editor.getSelection();
        model.setValue(text(rows));
        decorationIds = decorations(rows, 1);
        added = 0;
        if (shift !== undefined && selection && selection.startLineNumber > shift)
          editor.setSelection(
            new monaco.Selection(
              selection.selectionStartLineNumber - shift,
              selection.selectionStartColumn,
              selection.positionLineNumber - shift,
              selection.positionColumn,
            ),
          );
        if (!follow.current)
          editor.setScrollTop(
            shift === undefined
              ? 0
              : Math.max(0, editor.getTopForLineNumber(Math.max(1, top - shift)) + offset),
            monaco.editor.ScrollType.Immediate,
          );
      } else {
        if (removed > 0) {
          const top = editor.getScrollTop();
          const height = editor.getTopForLineNumber(removed + 1) - editor.getTopForLineNumber(1);
          removeDecorations(decorationIds.splice(0, removed));
          model.applyEdits([{ range: new monaco.Range(1, 1, removed + 1, 1), text: null }]);
          if (!follow.current)
            editor.setScrollTop(Math.max(0, top - height), monaco.editor.ScrollType.Immediate);
        }
        const appended = received ? rows.slice(rows.length - received) : [];
        if (appended.length) {
          const line = model.getLineCount();
          const inserted = text(appended);
          model.applyEdits([{ range: new monaco.Range(line, 1, line, 1), text: inserted }]);
          added += inserted.length;
          for (const ids of decorations(appended, line)) decorationIds.push(ids);
        }
      }
      shownFirst = first;
      shownCount = rows.length;
      shownRewrites = log.rewrites;
      if (follow.current)
        editor.setScrollTop(editor.getScrollHeight(), monaco.editor.ScrollType.Immediate);
      else if (received) setNewLines((count) => count + received);
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
      follow.current = event.scrollTop + editor.getLayoutInfo().height >= event.scrollHeight - 2;
      setFollowing(follow.current);
      if (follow.current) setNewLines(0);
    });
    const selection = editor.onDidChangeCursorSelection((event) => {
      if (!ownScroll.current && !event.selection.isEmpty()) {
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
          <HugeiconsIcon icon={ArrowDown01Icon} data-icon="inline-start" />
          Newest{newLines > 0 && ` · ${newLines.toLocaleString()} new`}
        </Button>
      )}
    </div>
  );
}
