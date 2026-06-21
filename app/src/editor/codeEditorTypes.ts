export interface CodeEditorChange {
  changedLines: number[];
  dirty: boolean;
  value?: string;
}

export interface CodeEditorViewHandle {
  focus(): void;
  goToChange(direction: "next" | "previous"): void;
  indentLess(): void;
  indentMore(): void;
  insertText(text: string): void;
  openSearch(): void;
  requestContent(): Promise<string | undefined>;
  redo(): void;
  undo(): void;
}

export interface CodeEditorViewProps {
  editable: boolean;
  path: string;
  value: string;
  onChange(change: CodeEditorChange): void;
}
