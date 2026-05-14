import { createHash, randomUUID } from "node:crypto";

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
    const storedSessions = await this.store.list();
    const storedTmuxNames = new Set(
      storedSessions.map((session) => session.tmux_session_name),
    );
    const externalSessions = (await this.tmux.listSessions())
      .filter((session) => !storedTmuxNames.has(session.name))
      .map((session) => this.createExternalSession(session));

    return [...storedSessions, ...externalSessions].sort(
      compareSessionsByRecentTime,
    );
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
      origin: "managed",
      registered: true,
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

  async remove(sessionId: string): Promise<void> {
    await this.store.remove(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    const session = await this.get(sessionId);
    if (!session) {
      return;
    }

    if (session.origin === "external") {
      await this.store.remove(sessionId);
      return;
    }

    try {
      await this.tmux.killSession(session.tmux_session_name);
    } catch {
      // Treat stale tmux records as already closed so mobile can recover.
    } finally {
      await this.store.remove(sessionId);
    }
  }

  async killTmux(sessionId: string): Promise<void> {
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

  async attach(sessionId: string): Promise<CodexSession | undefined> {
    const session = await this.get(sessionId);
    if (!session) {
      return undefined;
    }

    if (session.origin === "external" && !session.registered) {
      const attached = {
        ...session,
        status: "running" as const,
        last_active_at: new Date().toISOString(),
        registered: true,
      };
      await this.store.upsert(attached);
      return attached;
    }

    return session;
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
    return (await this.store.list()).filter((session) => session.runtime_kind === runtimeKind).length;
  }

  private createExternalSession(session: {
    name: string;
    createdAt: string;
    currentPath?: string;
    currentCommand?: string;
  }): CodexSession {
    const runtimeKind = inferRuntimeKind(session.currentCommand);
    const runtimeLabel = getRuntimeLabel(runtimeKind);
    return {
      session_id: toExternalSessionId(session.name),
      runtime_kind: runtimeKind,
      runtime_label: runtimeLabel,
      title: session.name,
      cwd: session.currentPath || this.defaults.cwd,
      command: session.currentCommand || "tmux",
      status: "detached",
      created_at: session.createdAt,
      last_active_at: session.createdAt,
      terminal_size: this.defaults.terminalSize,
      tmux_session_name: session.name,
      origin: "external",
      registered: false,
    };
  }
}

function toTmuxSessionName(sessionId: string): string {
  return `omniwork_${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function toExternalSessionId(tmuxSessionName: string): string {
  const digest = createHash("sha1").update(tmuxSessionName).digest("hex");
  return `tmux_${digest.slice(0, 16)}`;
}

function inferRuntimeKind(command?: string): RuntimeKind {
  const normalizedCommand = command?.toLowerCase() ?? "";
  if (normalizedCommand.includes("claude")) {
    return "claude";
  }
  if (normalizedCommand.includes("codex")) {
    return "codex";
  }
  return "other";
}

function getRuntimeLabel(runtimeKind: RuntimeKind): string {
  switch (runtimeKind) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "other":
    default:
      return "Other";
  }
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
