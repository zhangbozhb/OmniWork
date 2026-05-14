import type {
  CodexSession,
  TerminalFramePayload,
  TerminalInputPayload,
  TerminalResizePayload,
  TerminalSnapshotPayload,
} from "../../../../packages/protocol-ts/src/index.ts";
import {
  createControlInput,
  createPasteInput,
  createTextInput,
} from "../../../../packages/terminal-core/src/index.ts";
import { TmuxManager } from "../tmux-manager/tmuxManager.ts";

export class TerminalBridge {
  private readonly tmux: TmuxManager;
  private readonly inputQueues = new Map<string, Promise<void>>();

  constructor(tmux: TmuxManager) {
    this.tmux = tmux;
  }

  async writeInput(
    session: CodexSession,
    input: TerminalInputPayload,
  ): Promise<void> {
    const sessionId = session.session_id;
    const previous = this.inputQueues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.writeInputNow(session, input));

    this.inputQueues.set(sessionId, next);

    try {
      await next;
    } finally {
      if (this.inputQueues.get(sessionId) === next) {
        this.inputQueues.delete(sessionId);
      }
    }
  }

  private async writeInputNow(
    session: CodexSession,
    input: TerminalInputPayload,
  ): Promise<void> {
    if (input.kind === "key") {
      await this.tmux.sendKey(session.tmux_session_name, toTmuxKey(input.data));
      return;
    }

    await this.writeTerminalData(session.tmux_session_name, input.data);
  }

  private async writeTerminalData(
    tmuxSessionName: string,
    data: string,
  ): Promise<void> {
    let literalBuffer = "";

    for (const char of data) {
      if (char === "\r" || char === "\n") {
        await this.flushLiteralInput(tmuxSessionName, literalBuffer);
        literalBuffer = "";
        await delay(40);
        await this.tmux.sendKey(tmuxSessionName, "Enter");
        continue;
      }

      literalBuffer += char;
    }

    await this.flushLiteralInput(tmuxSessionName, literalBuffer);
  }

  private async flushLiteralInput(
    tmuxSessionName: string,
    data: string,
  ): Promise<void> {
    if (!data) {
      return;
    }

    await this.tmux.sendLiteralInput(tmuxSessionName, data);
  }

  async resize(
    session: CodexSession,
    size: TerminalResizePayload,
  ): Promise<void> {
    await this.tmux.resize(session.tmux_session_name, size);
  }

  async snapshot(session: CodexSession): Promise<TerminalSnapshotPayload> {
    await this.waitForInputDrain(session.session_id);
    const data = await this.tmux.capturePane(session.tmux_session_name);
    return {
      data,
      size: session.terminal_size,
      captured_at: new Date().toISOString(),
    };
  }

  async frame(session: CodexSession): Promise<TerminalFramePayload> {
    await this.waitForInputDrain(session.session_id);
    return {
      data: await this.tmux.capturePane(session.tmux_session_name),
      snapshot: true,
    };
  }

  private async waitForInputDrain(sessionId: string): Promise<void> {
    await (this.inputQueues.get(sessionId) ?? Promise.resolve());
  }
}

export const terminalInputs = {
  text: createTextInput,
  paste: createPasteInput,
  control: createControlInput,
};

function toTmuxKey(data: string): string {
  switch (data) {
    case "\u001b":
      return "Escape";
    case "\t":
      return "Tab";
    case "\r":
      return "Enter";
    case "\u007f":
      return "BSpace";
    case "\u0003":
      return "C-c";
    case "\u0004":
      return "C-d";
    case "\u000c":
      return "C-l";
    case "\u001b[A":
      return "Up";
    case "\u001b[B":
      return "Down";
    case "\u001b[C":
      return "Right";
    case "\u001b[D":
      return "Left";
    default:
      return data;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
