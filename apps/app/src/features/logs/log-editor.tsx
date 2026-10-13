import { Button } from "@hukube/ui/components/button";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { monaco } from "@/lib/monaco.ts";
import { useTheme } from "@/lib/theme.ts";
import { applyEditorTheme } from "../resource/editor-theme.ts";
import { type LogDocument, type LogRow } from "./log-document.ts";

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
    let shown: LogRow[] = [];
    let decorationIds: string[][] = [];
    const options = new Map<string, monaco.editor.IModelDecorationOptions>();
    // One call for the whole batch: each call makes Monaco announce a change.
    const decorations = (rows: LogRow[], first: number): string[][] => {
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
      const ids = added.length ? model.deltaDecorations([], added) : [];
      let next = 0;
      return rows.map((row) => ids.slice(next, (next += row.spans.length)));
    };
    const synchronize = () => {
      ownScroll.current = true;
      const rows = log.rows;
      const previousLast = shown.at(-1)?.sequence ?? -1;
      const received = rows.filter((row) => row.sequence > previousLast).length;
      const removed = shown.findIndex((row) => row.sequence === rows[0]?.sequence);
      const overlap = removed >= 0 ? shown[removed] : undefined;
      const reset = shown.length && (!overlap || overlap !== rows[0]);
      const top = editor.getScrollTop();
      if (reset) {
        const view = editor.saveViewState();
        model.deltaDecorations(decorationIds.flat(), []);
        model.applyEdits([
          {
            range: model.getFullModelRange(),
            text: rows.length ? `${rows.map((row) => row.text).join("\n")}\n` : "",
          },
        ]);
        decorationIds = decorations(rows, 1);
        if (view && overlap) editor.restoreViewState(view);
        else if (!follow.current) editor.setScrollTop(0, monaco.editor.ScrollType.Immediate);
      } else {
        if (removed > 0) {
          const height = editor.getTopForLineNumber(removed + 1) - editor.getTopForLineNumber(1);
          model.deltaDecorations(decorationIds.splice(0, removed).flat(), []);
          model.applyEdits([{ range: new monaco.Range(1, 1, removed + 1, 1), text: null }]);
          if (!follow.current)
            editor.setScrollTop(Math.max(0, top - height), monaco.editor.ScrollType.Immediate);
        }
        const retained = Math.max(0, shown.length - Math.max(0, removed));
        const appended = rows.slice(retained);
        if (appended.length) {
          const first = model.getLineCount();
          model.applyEdits([
            {
              range: new monaco.Range(first, 1, first, 1),
              text: `${appended.map((row) => row.text).join("\n")}\n`,
            },
          ]);
          decorationIds.push(...decorations(appended, first));
        }
      }
      shown = [...rows];
      if (follow.current)
        editor.setScrollTop(editor.getScrollHeight(), monaco.editor.ScrollType.Immediate);
      else if (received) setNewLines((count) => count + received);
      ownScroll.current = false;
    };
    const scroll = editor.onDidScrollChange((event) => {
      if (ownScroll.current || !event.scrollTopChanged) return;
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
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        ownScroll.current = true;
        editor.layout();
        if (follow.current)
          editor.setScrollTop(editor.getScrollHeight(), monaco.editor.ScrollType.Immediate);
        ownScroll.current = false;
      });
    });
    resize.observe(container.current);
    const unsubscribe = log.subscribe(synchronize);
    synchronize();
    void document.fonts
      .load('12px "JetBrains Mono Variable"')
      .then(() => monaco.editor.remeasureFonts());
    return () => {
      unsubscribe();
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
    if (container.current) applyEditorTheme(monaco, container.current, theme === "dark");
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
