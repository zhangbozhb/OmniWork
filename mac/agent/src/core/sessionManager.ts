import { createHash, randomUUID } from "node:crypto";

import type {
  CodexSession,
  RuntimeKind,
  SessionCreatePayload,
  TerminalSize,
  WorkspaceDefinition,
} from "../../../../packages/protocol-ts/src/index.ts";
import { clampTerminalSize } from "../../../../packages/terminal-core/src/index.ts";
import { JsonSessionStore } from "../session-store/sessionStore.ts";
import { TmuxManager } from "../tmux-manager/tmuxManager.ts";
import { RuntimeRegistry } from "../runtime/runtimeAdapter.ts";
import { WorkspaceManager } from "../workspace/workspaceManager.ts";

type SessionStatusListener = (session: CodexSession) => void | Promise<void>;

export class SessionManager {
  private readonly store: JsonSessionStore;
  private readonly tmux: TmuxManager;
  private readonly runtimes: RuntimeRegistry;
  private readonly workspaces?: WorkspaceManager;
  private readonly defaults: {
    cwd: string;
    terminalSize: TerminalSize;
  };

  constructor(
    store: JsonSessionStore,
    tmux: TmuxManager,
    runtimes: RuntimeRegistry,
    workspaces: WorkspaceManager | undefined,
    defaults: {
      cwd: string;
      terminalSize: TerminalSize;
    },
  ) {
    this.store = store;
    this.tmux = tmux;
    this.runtimes = runtimes;
    this.workspaces = workspaces;
    this.defaults = defaults;
  }

  async list(): Promise<CodexSession[]> {
    const storedSessions = await this.store.list();
    const tmuxSessions = await this.tmux.listSessions();
    const liveTmuxNames = new Set(tmuxSessions.map((session) => session.name));
    const reconciledStoredSessions = storedSessions.map((session) =>
      shouldMarkMissingTmuxAsError(session, liveTmuxNames)
        ? {
            ...session,
            status: "error" as const,
            last_active_at: new Date().toISOString(),
          }
        : session,
    );
    if (hasSessionChanges(storedSessions, reconciledStoredSessions)) {
      await this.store.saveAll(reconciledStoredSessions);
    }
    const storedTmuxNames = new Set(
      reconciledStoredSessions.map((session) => session.tmux_session_name),
    );
    const externalSessions = tmuxSessions
      .filter((session) => !storedTmuxNames.has(session.name))
      .map((session) => this.createExternalSession(session));

    const sessions = [...reconciledStoredSessions, ...externalSessions];
    const workspaces = this.workspaces ? await this.workspaces.list(sessions) : [];
    const annotatedSessions = await Promise.all(
      sessions.map((session) => this.annotateWorkspace(session, workspaces)),
    );

    return annotatedSessions.sort(
      compareSessionsByRecentTime,
    );
  }

  async create(
    payload: SessionCreatePayload = {},
    onStatus?: SessionStatusListener,
  ): Promise<CodexSession> {
    const sessionId = `sess_${randomUUID()}`;
    const tmuxSessionName = toTmuxSessionName(sessionId);
    const now = new Date().toISOString();
    const runtime = this.runtimes.get(payload.runtime_kind);
    const resolvedWorkspace = this.workspaces
      ? await this.workspaces.resolveCreateCwd(payload)
      : { cwd: payload.cwd ?? this.defaults.cwd, workspace: undefined };
    const cwd = resolvedWorkspace.cwd;
    const command = payload.command ?? runtime.buildTuiCommand();
    const size = clampTerminalSize(payload.terminal_size ?? this.defaults.terminalSize);
    const runtimeSessionCount = await this.countSessionsForRuntime(runtime.kind);

    const created: CodexSession = {
      session_id: sessionId,
      runtime_kind: runtime.kind,
      runtime_label: runtime.displayName,
      title: payload.title ?? runtime.defaultTitle(runtimeSessionCount + 1),
      cwd,
      command,
      status: "created",
      created_at: now,
      last_active_at: now,
      terminal_size: size,
      tmux_session_name: tmuxSessionName,
      workspace_path: resolvedWorkspace.workspace?.path,
      workspace_name: resolvedWorkspace.workspace?.name,
      git_repository: resolvedWorkspace.workspace?.isGitRepository,
      origin: "managed",
      registered: true,
    };

    await this.store.upsert(created);
    await onStatus?.(created);

    const starting = {
      ...created,
      status: "starting" as const,
      last_active_at: new Date().toISOString(),
    };
    await this.store.upsert(starting);
    await onStatus?.(starting);

    try {
      await this.tmux.createSession({
        tmuxSessionName,
        cwd,
        command,
        size,
      });
    } catch {
      const failed = {
        ...starting,
        status: "error" as const,
        last_active_at: new Date().toISOString(),
      };
      await this.store.upsert(failed);
      return failed;
    }

    const running = {
      ...starting,
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

  async rename(sessionId: string, title: string): Promise<CodexSession | undefined> {
    const session = await this.get(sessionId);
    const nextTitle = title.trim();
    if (!session || !nextTitle) {
      return undefined;
    }

    const renamed = {
      ...session,
      title: nextTitle,
      last_active_at: new Date().toISOString(),
      registered: session.registered ?? true,
    };
    await this.store.upsert(renamed);
    return renamed;
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

  async retry(
    sessionId: string,
    onStatus?: SessionStatusListener,
  ): Promise<CodexSession | undefined> {
    const session = await this.get(sessionId);
    if (!session) {
      return undefined;
    }

    return this.restartTmuxSession(session, onStatus);
  }

  async restart(
    sessionId: string,
    onStatus?: SessionStatusListener,
  ): Promise<CodexSession | undefined> {
    const session = await this.get(sessionId);
    if (!session) {
      return undefined;
    }

    try {
      await this.tmux.killSession(session.tmux_session_name);
    } catch {
      // Restart should also work when the previous tmux target is already gone.
    }
    return this.restartTmuxSession(session, onStatus);
  }

  async recover(sessionId: string): Promise<CodexSession | undefined> {
    const session = await this.get(sessionId);
    if (!session) {
      return undefined;
    }

    const tmuxSessions = await this.tmux.listSessions();
    const live = tmuxSessions.some(
      (item) => item.name === session.tmux_session_name,
    );
    const recovered = {
      ...session,
      status: live ? ("running" as const) : ("error" as const),
      last_active_at: new Date().toISOString(),
    };
    await this.store.upsert(recovered);
    return recovered;
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

  private async restartTmuxSession(
    session: CodexSession,
    onStatus?: SessionStatusListener,
  ): Promise<CodexSession> {
    const recovering = {
      ...session,
      status: "recovering" as const,
      registered: true,
      last_active_at: new Date().toISOString(),
    };
    await this.store.upsert(recovering);
    await onStatus?.(recovering);

    try {
      await this.tmux.createSession({
        tmuxSessionName: recovering.tmux_session_name,
        cwd: recovering.cwd,
        command: recovering.command,
        size: recovering.terminal_size,
      });
    } catch {
      const failed = {
        ...recovering,
        status: "error" as const,
        last_active_at: new Date().toISOString(),
      };
      await this.store.upsert(failed);
      return failed;
    }

    const running = {
      ...recovering,
      status: "running" as const,
      last_active_at: new Date().toISOString(),
    };
    await this.store.upsert(running);
    return running;
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

  private async countSessionsForRuntime(
    runtimeKind: RuntimeKind,
  ): Promise<number> {
    return (await this.store.list()).filter(
      (session) => session.runtime_kind === runtimeKind,
    ).length;
  }

  private createExternalSession(session: {
    name: string;
    createdAt: string;
    currentPath?: string;
    currentCommand?: string;
  }): CodexSession {
    const runtime = this.runtimes.infer(session.currentCommand);
    return {
      session_id: toExternalSessionId(session.name),
      runtime_kind: runtime?.kind ?? "other",
      runtime_label: runtime?.displayName ?? "Other",
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

  private async annotateWorkspace(
    session: CodexSession,
    workspaces: readonly WorkspaceDefinition[],
  ): Promise<CodexSession> {
    const workspace = this.workspaces
      ? await this.workspaces.resolveSessionWorkspace(session, workspaces)
      : undefined;
    return {
      ...session,
      workspace_path: workspace?.path ?? session.workspace_path,
      workspace_name: workspace?.name ?? session.workspace_name,
      git_repository: workspace?.isGitRepository ?? session.git_repository,
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

function shouldMarkMissingTmuxAsError(
  session: CodexSession,
  liveTmuxNames: Set<string>,
): boolean {
  if (
    session.status === "error" ||
    session.status === "exited" ||
    session.status === "archived"
  ) {
    return false;
  }

  if (session.registered === false) {
    return false;
  }

  return !liveTmuxNames.has(session.tmux_session_name);
}

function hasSessionChanges(
  previous: CodexSession[],
  next: CodexSession[],
): boolean {
  return JSON.stringify(previous) !== JSON.stringify(next);
}
