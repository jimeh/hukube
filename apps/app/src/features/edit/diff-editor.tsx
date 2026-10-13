import { useEffect, useRef } from "react";
import { monaco } from "@/lib/monaco.ts";
import { useTheme } from "@/lib/theme.ts";
import { applyEditorTheme } from "../resource/editor-theme.ts";

export default function DiffEditor({ before, after }: { before: string; after: string }) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | undefined>(undefined);
  const theme = useTheme();
  useEffect(() => {
    if (!container.current) return;
    const instance = monaco.editor.createDiffEditor(container.current, {
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
      lineHeight: 18,
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
      scrollBeyondLastLine: false,
      renderSideBySide: true,
      renderSideBySideInlineBreakpoint: 900,
      hideUnchangedRegions: { enabled: true },
      ariaLabel: "Manifest changes",
      diffCodeLens: false,
    });
    editor.current = instance;
    return () => {
      instance.dispose();
      editor.current = undefined;
    };
  }, []);
  useEffect(() => {
    // New models for new text: Monaco collapses unchanged regions only for a diff it has not shown.
    const original = monaco.editor.createModel(before, "yaml");
    const modified = monaco.editor.createModel(after, "yaml");
    editor.current?.setModel({ original, modified });
    return () => {
      editor.current?.setModel(null);
      original.dispose();
      modified.dispose();
    };
  }, [before, after]);
  useEffect(() => {
    if (container.current) return applyEditorTheme(monaco, container.current, theme === "dark");
  }, [theme]);
  return <div ref={container} className="h-full min-h-0" />;
}
