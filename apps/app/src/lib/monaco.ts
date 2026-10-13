import "monaco-editor/features/find/register";
import "monaco-editor/features/readOnlyMessage/register";
import "monaco-editor/features/clipboard/register";
import "monaco-editor/features/codicon/register";
import "monaco-editor/features/contextmenu/register";
import * as monaco from "monaco-editor/editor/editor.api";
// oxlint-disable-next-line import/default -- Vite provides the default export for ?worker imports.
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// Removal rules with no key remove every platform's binding for the command.
monaco.editor.addKeybindingRules([
  ...[
    "diffEditor.exitCompareMove",
    "editor.action.accessibleDiffViewer.next",
    "editor.action.accessibleDiffViewer.prev",
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
    "editor.action.showContextMenu",
    // A chord that starts with the key of the Go to Resource palette.
    "workbench.action.showHover",
    // The features above also bring a quick input and an action menu that
    // nothing here opens. Their keys go too, so that what an editor binds is
    // what the end-to-end test lists.
    "quickInput.accept",
    "quickInput.acceptInBackground",
    "quickInput.first",
    "quickInput.hide",
    "quickInput.last",
    "quickInput.next",
    "quickInput.nextSeparator",
    "quickInput.nextSeparatorWithQuickAccessFallback",
    "quickInput.pageNext",
    "quickInput.pagePrevious",
    "quickInput.previous",
    "quickInput.previousSeparator",
    "quickInput.previousSeparatorWithQuickAccessFallback",
    "quickInput.toggleCheckbox",
    "quickInput.toggleHover",
    "acceptSelectedCodeAction",
    "clearFilterCodeActionWidget",
    "collapseSectionCodeAction",
    "expandSectionCodeAction",
    "hideCodeActionWidget",
    "previewSelectedCodeAction",
    "selectNextCodeAction",
    "selectPrevCodeAction",
    "toggleSectionCodeAction",
  ].map((command) => ({ keybinding: 0, command: `-${command}` })),
  {
    keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF,
    command: "actions.find",
    when: "editorFocus",
  },
]);

export { monaco };
