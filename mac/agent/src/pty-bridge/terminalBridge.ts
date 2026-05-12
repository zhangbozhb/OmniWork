import type {
  CodexSession,
  TerminalFramePayload,
  TerminalInputPayload,
  TerminalResizePayload,
  TerminalSnapshotPayload,
} from "../../../../packages/protocol-ts/src/index.ts";
import { createControlInput, createPasteInput, createTextInput } from "../../../../packages/terminal-core/src/index.ts";
import { TmuxManager } from "../tmux-manager/tmuxManager.ts";

export class TerminalBridge {
  private readonly tmux: TmuxManager;

  constructor(tmux: TmuxManager) {
    this.tmux = tmux;
  }

  async writeInput(session: CodexSession, input: TerminalInputPayload): Promise<void> {
    await this.tmux.sendInput(session.tmux_session_name, input.data);
  }

  async resize(session: CodexSession, size: TerminalResizePayload): Promise<void> {
    await this.tmux.resize(session.tmux_session_name, size);
  }

  async snapshot(session: CodexSession): Promise<TerminalSnapshotPayload> {
    const data = await this.tmux.capturePane(session.tmux_session_name);
    return {
      data,
      size: session.terminal_size,
      captured_at: new Date().toISOString(),
    };
  }

  async frame(session: CodexSession): Promise<TerminalFramePayload> {
    return {
      data: await this.tmux.capturePane(session.tmux_session_name),
      snapshot: true,
    };
  }
}

export const terminalInputs = {
  text: createTextInput,
  paste: createPasteInput,
  control: createControlInput,
};
