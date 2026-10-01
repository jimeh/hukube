import type * as Monaco from "monaco-editor/editor/editor.api";

/** Resolves a CSS color custom property on element to a #rrggbb hex string. */
function cssColor(element: Element, property: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "#000000";
  ctx.fillStyle = getComputedStyle(element).getPropertyValue(property).trim() || "#000";
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Defines and applies a Monaco theme matching the app's tokens. */
export function applyEditorTheme(monaco: typeof Monaco, element: Element, dark: boolean): void {
  const color = (property: string) => cssColor(element, property);
  monaco.editor.defineTheme("hukube", {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": color("--background"),
      "editor.foreground": color("--foreground"),
      "editorLineNumber.foreground": color("--muted-foreground"),
      "editorLineNumber.activeForeground": color("--foreground"),
      "editor.selectionBackground": color("--accent"),
      "editor.inactiveSelectionBackground": color("--muted"),
      "editorIndentGuide.background1": color("--border"),
      "editorWidget.background": color("--popover"),
      "editorWidget.border": color("--border"),
      "scrollbarSlider.background": `${color("--muted-foreground")}33`,
    },
  });
  monaco.editor.setTheme("hukube");
}
