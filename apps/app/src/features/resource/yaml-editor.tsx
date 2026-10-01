import "monaco-editor/languages/definitions/yaml/register";

import * as monaco from "monaco-editor/editor/editor.api";
// oxlint-disable-next-line import/default -- Vite provides the default export for ?worker imports.
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { useEffect, useRef } from "react";

import { useTheme } from "@/lib/theme.ts";

import { applyEditorTheme } from "./editor-theme.ts";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

const monoFont = "JetBrains Mono Variable";

/** A read-only Monaco view of YAML that keeps its scroll position across updates. */
export default function YamlEditor({ value }: { value: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const theme = useTheme();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const editor = monaco.editor.create(container, {
      value: "",
      language: "yaml",
      readOnly: true,
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
    if (containerRef.current) applyEditorTheme(monaco, containerRef.current, theme === "dark");
  }, [theme]);

  return <div ref={containerRef} className="h-full min-h-0" />;
}
