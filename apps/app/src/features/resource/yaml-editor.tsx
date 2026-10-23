import "monaco-editor/languages/definitions/yaml/register";

import { monaco } from "@/lib/monaco.ts";
import {
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  useMemo,
  useId,
  type Ref,
} from "react";

import { useTheme } from "@/lib/theme.ts";

import { caretInEditableManifest } from "../edit/caret.ts";
import type { YamlIssue } from "../edit/yaml.ts";

import { applyEditorTheme } from "./editor-theme.ts";

import { gutterChanges, replacement } from "./gutter.ts";

const monoFont = "JetBrains Mono Variable";

/** A read-only Monaco view of YAML that keeps its scroll position across updates. */
export interface YamlEditorHandle {
  search(): void;
  focus(issue?: YamlIssue): void;
}

export default function YamlEditor({
  value,
  ref,
  editing = false,
  dirty = false,
  issues = [],
  onChange,
  onReview,
  baseText,
  editGroup,
}: {
  value: string;
  baseText?: string;
  editGroup?: string;
  ref?: Ref<YamlEditorHandle>;
  editing?: boolean;
  dirty?: boolean;
  issues?: YamlIssue[];
  onChange?: (text: string) => void;
  onReview?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const theme = useTheme();
  const description = useId();
  const gutter = useMemo(() => gutterChanges(baseText ?? value, value), [baseText, value]);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | undefined>(undefined);
  const group = useRef<string | undefined>(undefined);
  const callbacks = useRef({ onChange, onReview });
  useLayoutEffect(() => {
    callbacks.current = { onChange, onReview };
  }, [onChange, onReview]);
  const setting = useRef(false);
  const contextRef = useRef<monaco.editor.IContextKey<boolean> | undefined>(undefined);
  useImperativeHandle(
    ref,
    () => ({
      focus: (issue) => {
        const editor = editorRef.current;
        editor?.focus();
        if (issue) {
          editor?.setPosition({ lineNumber: issue.line, column: issue.column });
          editor?.revealLineInCenter(issue.line);
        }
      },
      search: () => {
        editorRef.current?.focus();
        void editorRef.current?.getAction("actions.find")?.run();
      },
    }),
    [],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const editor = monaco.editor.create(container, {
      value: "",
      language: "yaml",
      readOnly: true,
      readOnlyMessage: { value: "Choose Edit to change this Manifest." },
      ariaLabel: "Resource YAML",
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontFamily: `"${monoFont}", ui-monospace, monospace`,
      fontSize: 12,
      lineHeight: 18,
      renderLineHighlight: "none",
      padding: { top: 8 },
      stickyScroll: { enabled: true },
    });
    editorRef.current = editor;
    decorations.current = editor.createDecorationsCollection();
    const changes = editor.onDidChangeModelContent(() => {
      if (!setting.current) callbacks.current.onChange?.(editor.getValue());
    });
    editor.addAction({
      id: "hukube.edit.review",
      label: "Review changes",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      precondition: "hukubeEditDirty && editorTextFocus",
      run: () => callbacks.current.onReview?.(),
    });
    const dirtyKey = editor.createContextKey("hukubeEditDirty", false);
    contextRef.current = dirtyKey;
    // Metrics measured before the web font loads are wrong; remeasure once it has.
    void document.fonts.load(`12px "${monoFont}"`).then(() => monaco.editor.remeasureFonts());
    return () => {
      changes.dispose();
      decorations.current?.clear();
      decorations.current = undefined;
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  const wasEditing = useRef(false);
  useEffect(() => {
    const editor = editorRef.current;
    const starting = editing && !wasEditing.current;
    wasEditing.current = editing;
    if (!editor) return;
    editor.updateOptions({ readOnly: !editing });
    const position = starting
      ? caretInEditableManifest(editor.getValue(), value, editor.getPosition())
      : undefined;
    if (editor.getValue() === value) {
      if (starting) editor.focus();
      return;
    }
    const viewState = editor.saveViewState();
    setting.current = true;
    const model = editor.getModel();
    if (editing && !starting && model) {
      const change = replacement(editor.getValue(), value);
      const start = model.getPositionAt(change.start);
      const end = model.getPositionAt(change.end);
      if (group.current !== editGroup || !editGroup) editor.pushUndoStop();
      editor.executeEdits("hukube.overview", [
        {
          range: {
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: end.lineNumber,
            endColumn: end.column,
          },
          text: change.text,
          forceMoveMarkers: true,
        },
      ]);
      if (!editGroup) editor.pushUndoStop();
      group.current = editGroup;
    } else editor.setValue(value);
    setting.current = false;
    if (viewState) editor.restoreViewState(viewState);
    if (starting && position) {
      editor.setPosition(position);
      editor.revealLineInCenterIfOutsideViewport(position.lineNumber);
      editor.focus();
    }
  }, [value, editing, editGroup]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: !editing });
    contextRef.current?.set(editing && dirty);
  }, [editing, dirty]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model)
      monaco.editor.setModelMarkers(
        model,
        "hukube-edit",
        issues.map((issue) => ({
          severity: monaco.MarkerSeverity.Error,
          message: issue.message,
          startLineNumber: issue.line,
          startColumn: issue.column,
          endLineNumber: issue.endLine,
          endColumn: Math.max(issue.endColumn, issue.column + 1),
        })),
      );
  }, [issues]);

  useEffect(() => {
    if (containerRef.current)
      return applyEditorTheme(monaco, containerRef.current, theme === "dark");
  }, [theme]);

  useEffect(() => {
    const editor = editorRef.current;
    const collection = decorations.current;
    const model = editor?.getModel();
    if (!editor || !collection || !model) return;
    collection.set(
      gutter.changes.map((change) => ({
        range: {
          startLineNumber: change.line,
          startColumn: 1,
          endLineNumber: Math.min(
            model.getLineCount(),
            change.line + (change.kind === "deleted" ? 0 : change.count - 1),
          ),
          endColumn: 1,
        },
        options: {
          isWholeLine: true,
          linesDecorationsClassName: `yaml-change-${change.kind}${change.before ? " yaml-change-before" : ""}`,
          linesDecorationsTooltip: `${change.count} ${change.kind} ${change.count === 1 ? "line" : "lines"}`,
        },
      })),
    );
    editor
      .getDomNode()
      ?.querySelector("textarea, [role=textbox]")
      ?.setAttribute("aria-describedby", description);
    // setValue on entry/exit clears decorations even when the diff is unchanged.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [gutter, description, value, editing]);

  useEffect(() => {
    if (group.current !== editGroup) {
      editorRef.current?.pushUndoStop();
      group.current = editGroup;
    }
  }, [editGroup]);

  return (
    <div className="relative h-full min-h-0">
      <p
        id={description}
        className={
          gutter.limited
            ? "absolute bottom-2 right-3 z-10 max-w-64 rounded border bg-popover px-2 py-1 text-xs"
            : "sr-only"
        }
      >
        {gutter.summary}
      </p>
      <div ref={containerRef} className="h-full min-h-0" />
    </div>
  );
}
