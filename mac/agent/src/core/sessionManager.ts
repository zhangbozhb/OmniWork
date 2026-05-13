import { randomUUID } from "node:crypto";

import type {
  CodexSession,
  RuntimeKind,
  SessionCreatePayload,
  TerminalSize,
} from "../../../../packages/protocol-ts/src/index.ts";
import { clampTerminalSize } from "../../../../packages/terminal-core/src/index.ts";
import { JsonSessionStore } from "../session-store/sessionStore.ts";
import { TmuxManager } from "../tmux-manager/tmuxManager.ts";
import { RuntimeRegistry } from "../runtime/runtimeAdapter.ts";

export class SessionManager {
  private readonly store: JsonSessionStore;
  private readonly tmux: TmuxManager;
  private readonly runtimes: RuntimeRegistry;
  private readonly defaults: {
    cwd: string;
    terminalSize: TerminalSize;
  };

  constructor(
    store: JsonSessionStore,
    tmux: TmuxManager,
    runtimes: RuntimeRegistry,
    defaults: {
      cwd: string;
      terminalSize: TerminalSize;
    },
  ) {
    this.store = store;
    this.tmux = tmux;
    this.runtimes = runtimes;
    this.defaults = defaults;
  }

  async list(): Promise<CodexSession[]> {
    return (await this.store.list()).sort(compareSessionsByRecentTime);
  }

  async create(payload: SessionCreatePayload = {}): Promise<CodexSession> {
    const sessionId = `sess_${randomUUID()}`;
    const tmuxSessionName = toTmuxSessionName(sessionId);
    const now = new Date().toISOString();
    const runtimeKind = payload.runtime_kind ?? "codex";
    const runtime = this.runtimes.get(runtimeKind);
    const cwd = payload.cwd ?? this.defaults.cwd;
    const command = payload.command ?? runtime.buildTuiCommand();
    const size = clampTerminalSize(payload.terminal_size ?? this.defaults.terminalSize);
    const runtimeSessionCount = await this.countSessionsForRuntime(runtimeKind);

    const session: CodexSession = {
      session_id: sessionId,
      runtime_kind: runtime.kind,
      runtime_label: runtime.displayName,
      title: payload.title ?? runtime.defaultTitle(runtimeSessionCount + 1),
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

    try {
      await this.tmux.killSession(session.tmux_session_name);
    } finally {
      await this.store.remove(sessionId);
    }
  }

  async updateTerminalSize(
    sessionId: string,
    terminalSize: TerminalSize,
  ): Promise<CodexSession | undefined> {
    const session = await this.get(sessionId);
    if (!session) {
      return undefined;
    }

    const updated = {
      ...session,
      terminal_size: clampTerminalSize(terminalSize),
      last_active_at: new Date().toISOString(),
    };
    await this.store.upsert(updated);
    return updated;
  }

  private async countSessionsForRuntime(runtimeKind: RuntimeKind): Promise<number> {
    return (await this.list()).filter((session) => session.runtime_kind === runtimeKind).length;
  }
}

function toTmuxSessionName(sessionId: string): string {
  return `omniwork_${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function compareSessionsByRecentTime(left: CodexSession, right: CodexSession): number {
  return getSessionSortTime(right) - getSessionSortTime(left);
}

function getSessionSortTime(session: CodexSession): number {
  const lastActiveAt = Date.parse(session.last_active_at);
  if (Number.isFinite(lastActiveAt)) {
    return lastActiveAt;
  }

  const createdAt = Date.parse(session.created_at);
  return Number.isFinite(createdAt) ? createdAt : 0;
}
