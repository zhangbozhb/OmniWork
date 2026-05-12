import { randomUUID } from "node:crypto";

import type {
  CodexSession,
  SessionCreatePayload,
  TerminalSize,
} from "../../../../packages/protocol-ts/src/index.ts";
import { clampTerminalSize } from "../../../../packages/terminal-core/src/index.ts";
import { CodexRuntime } from "../codex-runtime/codexRuntime.ts";
import { JsonSessionStore } from "../session-store/sessionStore.ts";
import { TmuxManager } from "../tmux-manager/tmuxManager.ts";

export class SessionManager {
  private readonly store: JsonSessionStore;
  private readonly tmux: TmuxManager;
  private readonly runtime: CodexRuntime;
  private readonly defaults: {
    cwd: string;
    terminalSize: TerminalSize;
  };

  constructor(
    store: JsonSessionStore,
    tmux: TmuxManager,
    runtime: CodexRuntime,
    defaults: {
      cwd: string;
      terminalSize: TerminalSize;
    },
  ) {
    this.store = store;
    this.tmux = tmux;
    this.runtime = runtime;
    this.defaults = defaults;
  }

  async list(): Promise<CodexSession[]> {
    return this.store.list();
  }

  async create(payload: SessionCreatePayload = {}): Promise<CodexSession> {
    const sessionId = `sess_${randomUUID()}`;
    const tmuxSessionName = toTmuxSessionName(sessionId);
    const now = new Date().toISOString();
    const cwd = payload.cwd ?? this.defaults.cwd;
    const command = payload.command ?? this.runtime.buildTuiCommand();
    const size = clampTerminalSize(payload.terminal_size ?? this.defaults.terminalSize);

    const session: CodexSession = {
      session_id: sessionId,
      title: payload.title ?? "Codex",
      cwd,
      command,
      status: "starting",
      created_at: now,
      last_active_at: now,
      terminal_size: size,
      tmux_session_name: tmuxSessionName,
    };

    await this.store.upsert(session);
    await this.tmux.createSession({
      tmuxSessionName,
      cwd,
      command,
      size,
    });

    const running = {
      ...session,
      status: "running" as const,
      last_active_at: new Date().toISOString(),
    };
    await this.store.upsert(running);
    return running;
  }

  async get(sessionId: string): Promise<CodexSession | undefined> {
    return (await this.list()).find((session) => session.session_id === sessionId);
  }

  async close(sessionId: string): Promise<void> {
    const session = await this.get(sessionId);
    if (!session) {
      return;
    }

    await this.tmux.killSession(session.tmux_session_name);
    await this.store.remove(sessionId);
  }
}

function toTmuxSessionName(sessionId: string): string {
  return `omniwork_${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
