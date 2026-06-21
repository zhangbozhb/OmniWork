import {
  forwardRef,
  type JSX,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { View } from "react-native";
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
import type {
  CodeEditorChange,
  CodeEditorViewHandle,
  CodeEditorViewProps,
} from "./codeEditorTypes";

export type { CodeEditorViewHandle, CodeEditorViewProps } from "./codeEditorTypes";

const editableCompartment = new Compartment();
const changeGutterCompartment = new Compartment();
const languageCompartment = new Compartment();

export const CodeEditorView = forwardRef<CodeEditorViewHandle, CodeEditorViewProps>(
  function CodeEditorView({ editable, path, value, onChange }, ref): JSX.Element {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const baselineValueRef = useRef(value);
    const lastAppliedValueRef = useRef(value);

    onChangeRef.current = onChange;

    useImperativeHandle(ref, () => ({
      focus() {
        viewRef.current?.focus();
      },
      goToChange(direction: "next" | "previous") {
        const view = viewRef.current;
        const changedLines = createChangedLineNumbers(
          baselineValueRef.current,
          view?.state.doc.toString() ?? "",
        );
        if (!view || changedLines.length === 0) {
          return;
        }
        const currentLine = view.state.doc.lineAt(view.state.selection.main.head).number;
        const targetLine =
          direction === "next"
            ? (changedLines.find((line) => line > currentLine) ?? changedLines[0])
            : ([...changedLines].reverse().find((line) => line < currentLine) ??
              changedLines[changedLines.length - 1]);
        if (!targetLine) {
          return;
        }
        const line = view.state.doc.line(Math.min(targetLine, view.state.doc.lines));
        view.dispatch({
          selection: { anchor: line.from },
          scrollIntoView: true,
        });
        view.focus();
      },
      indentLess() {
        const view = viewRef.current;
        if (view) {
          commandIndentLess({
            state: view.state,
            dispatch: (transaction) => view.dispatch(transaction),
          });
          view.focus();
        }
      },
      indentMore() {
        const view = viewRef.current;
        if (view) {
          commandIndentMore({
            state: view.state,
            dispatch: (transaction) => view.dispatch(transaction),
          });
          view.focus();
        }
      },
      insertText(text: string) {
        const view = viewRef.current;
        if (!view) {
          return;
        }
        view.dispatch(
          view.state.replaceSelection(text),
          { scrollIntoView: true },
        );
        view.focus();
      },
      openSearch() {
        const view = viewRef.current;
        if (view) {
          openSearchPanel(view);
          view.focus();
        }
      },
      requestContent() {
        return Promise.resolve(
          viewRef.current?.state.doc.toString() ?? lastAppliedValueRef.current,
        );
      },
      redo() {
        const view = viewRef.current;
        if (view) {
          commandRedo({
            state: view.state,
            dispatch: (transaction) => view.dispatch(transaction),
          });
          view.focus();
        }
      },
      undo() {
        const view = viewRef.current;
        if (view) {
          commandUndo({
            state: view.state,
            dispatch: (transaction) => view.dispatch(transaction),
          });
          view.focus();
        }
      },
    }));

    useEffect(() => {
      if (!hostRef.current) {
        return;
      }
      const view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: value,
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
              EditorView.editable.of(editable),
              EditorState.readOnly.of(!editable),
            ]),
            changeGutterCompartment.of(createChangeGutter(new Set())),
            languageCompartment.of(codeEditorLanguageForPath(path)),
            EditorView.updateListener.of((update) => {
              if (!update.docChanged) {
                return;
              }
              const nextValue = update.state.doc.toString();
              lastAppliedValueRef.current = nextValue;
              const change = createEditorChange(baselineValueRef.current, nextValue);
              update.view.dispatch({
                effects: changeGutterCompartment.reconfigure(
                  createChangeGutter(new Set(change.changedLines)),
                ),
              });
              onChangeRef.current({ ...change, value: nextValue });
            }),
            editorTheme,
          ],
        }),
      });
      viewRef.current = view;
      return () => {
        view.destroy();
        viewRef.current = null;
      };
    }, []);

    useEffect(() => {
      const view = viewRef.current;
      if (!view || value === lastAppliedValueRef.current) {
        return;
      }
      baselineValueRef.current = value;
      lastAppliedValueRef.current = value;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        effects: changeGutterCompartment.reconfigure(createChangeGutter(new Set())),
      });
    }, [value]);

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: editableCompartment.reconfigure([
          EditorView.editable.of(editable),
          EditorState.readOnly.of(!editable),
        ]),
      });
    }, [editable]);

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: languageCompartment.reconfigure(codeEditorLanguageForPath(path)),
      });
    }, [path]);

    return (
      <View style={{ flex: 1 }}>
        <div ref={hostRef} style={{ height: "100%", width: "100%" }} />
      </View>
    );
  },
);

function createEditorChange(before: string, after: string): CodeEditorChange {
  return {
    changedLines: createChangedLineNumbers(before, after),
    dirty: before !== after,
  };
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
