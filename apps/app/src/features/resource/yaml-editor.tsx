import "monaco-editor/languages/definitions/yaml/register";

import { monaco } from "@/lib/monaco.ts";
import { useEffect, useLayoutEffect, useImperativeHandle, useRef, type Ref } from "react";

import { useTheme } from "@/lib/theme.ts";

import type { YamlIssue } from "../edit/yaml.ts";

import { applyEditorTheme } from "./editor-theme.ts";

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
}: {
  value: string;
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
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.getValue() === value) return;
    const viewState = editor.saveViewState();
    setting.current = true;
    editor.setValue(value);
    setting.current = false;
    if (viewState) editor.restoreViewState(viewState);
  }, [value]);

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

  return <div ref={containerRef} className="h-full min-h-0" />;
}
