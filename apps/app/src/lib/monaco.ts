import "monaco-editor/features/find/register";
import "monaco-editor/features/clipboard/register";
import "monaco-editor/features/codicon/register";
import * as monaco from "monaco-editor/editor/editor.api";
// oxlint-disable-next-line import/default -- Vite provides the default export for ?worker imports.
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// Removal rules with no key remove every platform's binding for the command.
monaco.editor.addKeybindingRules([
  ...[
    "actions.find",
    "actions.findWithSelection",
    "editor.action.nextSelectionMatchFindAction",
    "editor.action.previousSelectionMatchFindAction",
    "editor.action.startFindReplaceAction",
    "togglePreserveCase",
    "editor.action.replaceOne",
    "editor.action.replaceAll",
    "editor.action.selectAllMatches",
    "history.showPrevious",
    "history.showNext",
    "leaveEditorMessage",
    "editor.action.clipboardCutAction",
    "editor.action.clipboardCopyAction",
    "editor.action.clipboardPasteAction",
  ].map((command) => ({ keybinding: 0, command: `-${command}` })),
  {
    keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF,
    command: "actions.find",
    when: "editorFocus",
  },
]);

export { monaco };
