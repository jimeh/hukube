import "monaco-editor/languages/definitions/yaml/register";

import { monaco } from "@/lib/monaco.ts";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

import { useTheme } from "@/lib/theme.ts";

import { applyEditorTheme } from "./editor-theme.ts";

const monoFont = "JetBrains Mono Variable";

/** A read-only Monaco view of YAML that keeps its scroll position across updates. */
export interface YamlEditorHandle {
  search(): void;
}

export default function YamlEditor({ value, ref }: { value: string; ref?: Ref<YamlEditorHandle> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const theme = useTheme();
  useImperativeHandle(
    ref,
    () => ({
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
    // Metrics measured before the web font loads are wrong; remeasure once it has.
    void document.fonts.load(`12px "${monoFont}"`).then(() => monaco.editor.remeasureFonts());
    return () => {
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.getValue() === value) return;
    const viewState = editor.saveViewState();
    editor.setValue(value);
    if (viewState) editor.restoreViewState(viewState);
  }, [value]);

  useEffect(() => {
    if (containerRef.current)
      return applyEditorTheme(monaco, containerRef.current, theme === "dark");
  }, [theme]);

  return <div ref={containerRef} className="h-full min-h-0" />;
}
