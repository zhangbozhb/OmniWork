import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess as commandIndentLess,
  indentMore as commandIndentMore,
  indentWithTab,
  redo as commandRedo,
  undo as commandUndo,
} from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  gutter,
  GutterMarker,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";

import { codeEditorLanguageForPath } from "./codeEditorLanguages";

declare global {
  interface Window {
    ReactNativeWebView?: {
      postMessage(message: string): void;
    };
    __omniworkCodeEditorBridge?: (command: BridgeCommand) => void;
  }
}

type BridgeCommand =
  | { type: "focus" }
  | { type: "goToChange"; direction: "next" | "previous" }
  | { type: "indentLess" }
  | { type: "indentMore" }
  | { type: "insertText"; text: string }
  | { type: "openSearch" }
  | { type: "redo" }
  | { type: "requestContent"; requestId: string }
  | { type: "setDocument"; value: string; path: string; editable: boolean }
  | { type: "setEditable"; editable: boolean }
  | { type: "setLanguage"; path: string }
  | { type: "undo" };

const editableCompartment = new Compartment();
const changeGutterCompartment = new Compartment();
const languageCompartment = new Compartment();

let editor: EditorView | undefined;
let applyingRemoteDocument = false;
let baselineDocument = "";
let changedLines: number[] = [];

function post(message: unknown): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify(message));
}

function createEditor(): void {
  const parent = document.getElementById("editor");
  if (!parent) {
    return;
  }
  editor = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        lineNumbers(),
        foldGutter(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        rectangularSelection(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        editableCompartment.of([
          EditorView.editable.of(true),
          EditorState.readOnly.of(false),
        ]),
        changeGutterCompartment.of(createChangeGutter(new Set())),
        languageCompartment.of([]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || applyingRemoteDocument) {
            return;
          }
          const value = update.state.doc.toString();
          changedLines = createChangedLineNumbers(baselineDocument, value);
          editor?.dispatch({
            effects: changeGutterCompartment.reconfigure(
              createChangeGutter(new Set(changedLines)),
            ),
          });
          post({
            type: "change",
            changedLines,
            dirty: value !== baselineDocument,
          });
        }),
        editorTheme,
      ],
    }),
  });

  window.__omniworkCodeEditorBridge = handleBridgeCommand;
  post({ type: "ready" });
}

function handleBridgeCommand(command: BridgeCommand): void {
  if (!editor || !command?.type) {
    return;
  }
  switch (command.type) {
    case "focus":
      editor.focus();
      break;
    case "goToChange":
      goToChange(command.direction);
      break;
    case "indentLess":
      commandIndentLess({
        state: editor.state,
        dispatch: (transaction) => editor?.dispatch(transaction),
      });
      editor.focus();
      break;
    case "indentMore":
      commandIndentMore({
        state: editor.state,
        dispatch: (transaction) => editor?.dispatch(transaction),
      });
      editor.focus();
      break;
    case "insertText":
      editor.dispatch(
        editor.state.replaceSelection(command.text),
        { scrollIntoView: true },
      );
      editor.focus();
      break;
    case "openSearch":
      openSearchPanel(editor);
      editor.focus();
      break;
    case "redo":
      commandRedo({
        state: editor.state,
        dispatch: (transaction) => editor?.dispatch(transaction),
      });
      editor.focus();
      break;
    case "requestContent":
      post({
        type: "content",
        requestId: command.requestId,
        value: editor.state.doc.toString(),
      });
      break;
    case "setDocument":
      applyingRemoteDocument = true;
      baselineDocument = command.value;
      changedLines = [];
      editor.dispatch({
        changes: {
          from: 0,
          to: editor.state.doc.length,
          insert: command.value,
        },
        effects: [
          editableCompartment.reconfigure([
            EditorView.editable.of(command.editable),
            EditorState.readOnly.of(!command.editable),
          ]),
          changeGutterCompartment.reconfigure(createChangeGutter(new Set())),
          languageCompartment.reconfigure(codeEditorLanguageForPath(command.path)),
        ],
      });
      applyingRemoteDocument = false;
      break;
    case "setEditable":
      editor.dispatch({
        effects: editableCompartment.reconfigure([
          EditorView.editable.of(command.editable),
          EditorState.readOnly.of(!command.editable),
        ]),
      });
      break;
    case "setLanguage":
      editor.dispatch({
        effects: languageCompartment.reconfigure(
          codeEditorLanguageForPath(command.path),
        ),
      });
      break;
    case "undo":
      commandUndo({
        state: editor.state,
        dispatch: (transaction) => editor?.dispatch(transaction),
      });
      editor.focus();
      break;
  }
}

function createChangedLineNumbers(before: string, after: string): number[] {
  if (before === after) {
    return [];
  }
  const lines = createLineDiff(before, after);
  const changedLineSet = new Set<number>();
  let afterLine = 1;
  for (const line of lines) {
    if (line.type === "context") {
      afterLine += 1;
    } else if (line.type === "add") {
      changedLineSet.add(afterLine);
      afterLine += 1;
    } else {
      changedLineSet.add(Math.max(1, afterLine));
    }
  }
  return [...changedLineSet].sort((left, right) => left - right);
}

function createLineDiff(
  before: string,
  after: string,
): Array<{ type: "add" | "delete" | "context"; text: string }> {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  if (beforeLines.length * afterLines.length > 250_000) {
    return createPrefixSuffixLineDiff(beforeLines, afterLines);
  }
  const table = Array.from({ length: beforeLines.length + 1 }, () =>
    Array<number>(afterLines.length + 1).fill(0),
  );
  for (let row = beforeLines.length - 1; row >= 0; row -= 1) {
    for (let column = afterLines.length - 1; column >= 0; column -= 1) {
      table[row][column] =
        beforeLines[row] === afterLines[column]
          ? table[row + 1][column + 1] + 1
          : Math.max(table[row + 1][column], table[row][column + 1]);
    }
  }
  const result: Array<{ type: "add" | "delete" | "context"; text: string }> = [];
  let row = 0;
  let column = 0;
  while (row < beforeLines.length && column < afterLines.length) {
    if (beforeLines[row] === afterLines[column]) {
      result.push({ type: "context", text: beforeLines[row] });
      row += 1;
      column += 1;
    } else if (table[row + 1][column] >= table[row][column + 1]) {
      result.push({ type: "delete", text: beforeLines[row] });
      row += 1;
    } else {
      result.push({ type: "add", text: afterLines[column] });
      column += 1;
    }
  }
  while (row < beforeLines.length) {
    result.push({ type: "delete", text: beforeLines[row] });
    row += 1;
  }
  while (column < afterLines.length) {
    result.push({ type: "add", text: afterLines[column] });
    column += 1;
  }
  return result;
}

function createPrefixSuffixLineDiff(
  beforeLines: string[],
  afterLines: string[],
): Array<{ type: "add" | "delete" | "context"; text: string }> {
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let beforeSuffix = beforeLines.length - 1;
  let afterSuffix = afterLines.length - 1;
  while (
    beforeSuffix >= prefix &&
    afterSuffix >= prefix &&
    beforeLines[beforeSuffix] === afterLines[afterSuffix]
  ) {
    beforeSuffix -= 1;
    afterSuffix -= 1;
  }
  const result: Array<{ type: "add" | "delete" | "context"; text: string }> = [];
  for (let index = prefix; index <= beforeSuffix; index += 1) {
    result.push({ type: "delete", text: beforeLines[index] });
  }
  for (let index = prefix; index <= afterSuffix; index += 1) {
    result.push({ type: "add", text: afterLines[index] });
  }
  return result;
}

function goToChange(direction: "next" | "previous"): void {
  if (!editor || changedLines.length === 0) {
    return;
  }
  const currentLine = editor.state.doc.lineAt(editor.state.selection.main.head).number;
  const targetLine =
    direction === "next"
      ? (changedLines.find((line) => line > currentLine) ?? changedLines[0])
      : ([...changedLines].reverse().find((line) => line < currentLine) ??
        changedLines[changedLines.length - 1]);
  if (!targetLine) {
    return;
  }
  const line = editor.state.doc.line(Math.min(targetLine, editor.state.doc.lines));
  editor.dispatch({
    selection: { anchor: line.from },
    scrollIntoView: true,
  });
  editor.focus();
}

const changedLineMarker = new class extends GutterMarker {
  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = "cm-omniwork-change-marker";
    return marker;
  }
}();

function createChangeGutter(changedLineSet: Set<number>) {
  return gutter({
    class: "cm-omniwork-change-gutter",
    lineMarker(view, line) {
      const lineNumber = view.state.doc.lineAt(line.from).number;
      return changedLineSet.has(lineNumber) ? changedLineMarker : null;
    },
  });
}

const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "#151c21",
    color: "#f5f7f8",
    fontSize: "13px",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: 'Menlo, "SF Mono", "Cascadia Code", Consolas, "Roboto Mono", monospace',
    lineHeight: "19px",
  },
  ".cm-content": {
    caretColor: "#30c48d",
    minHeight: "100%",
    padding: "10px 0",
  },
  ".cm-line": {
    padding: "0 10px",
  },
  ".cm-gutters": {
    backgroundColor: "#11181d",
    borderRightColor: "#263037",
    color: "#66727c",
  },
  ".cm-omniwork-change-gutter": {
    width: "4px",
  },
  ".cm-omniwork-change-marker": {
    backgroundColor: "#f6c350",
    borderRadius: "999px",
    display: "block",
    height: "14px",
    marginTop: "2px",
    width: "3px",
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(148, 163, 173, 0.08)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "rgba(48, 196, 141, 0.14)",
    color: "#30c48d",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "rgba(48, 196, 141, 0.32)",
  },
  "&.cm-focused": {
    outline: "none",
  },
});

createEditor();
