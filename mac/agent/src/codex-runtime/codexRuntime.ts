export interface CodexRuntimeOptions {
  codexCommand: string;
}

export class CodexRuntime {
  private readonly options: CodexRuntimeOptions;

  constructor(options: CodexRuntimeOptions) {
    this.options = options;
  }

  buildTuiCommand(): string {
    return this.options.codexCommand;
  }
}
