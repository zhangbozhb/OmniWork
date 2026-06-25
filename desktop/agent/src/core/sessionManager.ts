import { createHash, randomUUID } from "node:crypto";

import type {
  TerminalSession,
  TerminalProviderKind,
  SessionCreatePayload,
  SurfaceDefinition,
  TerminalSize,
  WorkspaceDefinition,
} from "@omniwork/protocol-ts";
import { isSupportedSessionStatus } from "@omniwork/protocol-ts";
import { clampTerminalSize } from "@omniwork/terminal-core";
import { SQLiteSessionStore } from "../session-store/sessionStore.ts";
import { formatLocalTimestamp } from "../telemetry/logger.ts";
import { TmuxManager } from "../tmux-manager/tmuxManager.ts";
import { TerminalProviderRegistry } from "../terminal-provider/terminalProviderRegistry.ts";
import { WorkspaceManager } from "../workspace/workspaceManager.ts";

type SessionStatusListener = (session: TerminalSession) => void | Promise<void>;

export class SessionManager {
  private readonly store: SQLiteSessionStore;
  private readonly tmux: TmuxManager;
  private readonly terminalProviders: TerminalProviderRegistry;
  private readonly workspaces?: WorkspaceManager;
  private readonly defaults: {
    cwd: string;
    terminalSize: TerminalSize;
  };

  constructor(
    store: SQLiteSessionStore,
    tmux: TmuxManager,
    terminalProviders: TerminalProviderRegistry,
    workspaces: WorkspaceManager | undefined,
    defaults: {
      cwd: string;
      terminalSize: TerminalSize;
    },
  ) {
    this.store = store;
    this.tmux = tmux;
    this.terminalProviders = terminalProviders;
    this.workspaces = workspaces;
    this.defaults = defaults;
  }

  /**
   * Agent 启动期对持久化 session store 做的一次性补丁，集中放在这里。
   *
   * 设计取舍：采用 **白名单** 策略而非黑名单。
   * - 协议层 `SUPPORTED_SESSION_STATUSES` 是 SessionStatus 的唯一事实源；
   *   任何不在白名单内的 status 一律视为非法数据，直接从 store 中删除。
   * - 白名单只需在新增 / 删除合法状态时改协议层常量一处，启动期补丁
   *   无需跟改。
   * - reconcile 的常态逻辑只关心"对应 tmux 还活着吗"，不会主动改写
   *   非法 status；因此把"格式正确性"约束集中到启动期统一收敛。
   *
   * 任何新增的"启动期 session store 补丁"都集中加在这一函数里，
   * 与运行期 reconcile / 写入路径保持职责分离。
   */
  async applyStartupPatches(): Promise<void> {
    const stored = await this.store.list();
    if (stored.length === 0) {
      // eslint-disable-next-line no-console
      console.info(
        JSON.stringify({
          ts: formatLocalTimestamp(),
          event: "session_store.startup_patch.summary",
          scanned: 0,
          dropped: 0,
        }),
      );
      return;
    }
    const droppedIds: string[] = [];
    const droppedDetail: Array<{ session_id: string; status: string }> = [];
    for (const session of stored) {
      if (!isSupportedSessionStatus(session.status)) {
        droppedIds.push(session.session_id);
        droppedDetail.push({
          session_id: session.session_id,
          status: String(session.status),
        });
      }
    }
    // 汇总日志：无论是否有 drop，都打一次 summary，便于排查"启动期到底
    // 改了什么"，避免反复在多条 remove() 日志里翻找。
    // eslint-disable-next-line no-console
    console.info(
      JSON.stringify({
        ts: formatLocalTimestamp(),
        event: "session_store.startup_patch.summary",
        scanned: stored.length,
        dropped: droppedIds.length,
        dropped_detail: droppedDetail,
      }),
    );
    if (droppedIds.length === 0) {
      return;
    }
    // 走 store.remove 路径以便沿用结构化 reason 日志，方便用户反馈
    // "我的 session 突然没了"时溯源。
    for (const sessionId of droppedIds) {
      await this.store.remove(sessionId, "startup_patch_unsupported_status");
    }
  }

  async list(): Promise<TerminalSession[]> {
    const storedSessions = await this.store.list();
    const tmuxSessions = await this.tmux.listSessions();
    // 用 (server_pid, session_uid) 构造强 ID 索引；
    // create() 与 external 发现路径都会写入这两个字段，因此 store 中的
    // 条目一律按强 ID 比对。同时建一个 name 索引，用于在 binding 失配时
    // 进一步区分"server 重启"与"同 server 内 uid 不同"两种 mismatch。
    const liveByBinding = new Map<string, (typeof tmuxSessions)[number]>();
    const liveByName = new Map<string, (typeof tmuxSessions)[number]>();
    for (const live of tmuxSessions) {
      if (live.serverPid && live.sessionUid) {
        liveByBinding.set(toBindingKey(live.serverPid, live.sessionUid), live);
      }
      liveByName.set(live.name, live);
    }
    // tmux 会话一旦消失（包括"同名但是新进程"，例如 tmux server 重启），
    // 进程内对话上下文随之丢失，无论 managed/external 都不存在"恢复成同一
    // session"的可能；为避免 UI 上残留无意义的孤儿条目，直接从持久化 store
    // 中删除。created/starting 仍保留以容忍 create() 与后续 list() 之间
    // tmux ls 尚未感知的瞬时窗口。
    const reconciledStoredSessions: TerminalSession[] = [];
    const orphanRemovals: Array<{
      session: TerminalSession;
      reason: OrphanReason;
    }> = [];
    for (const session of storedSessions) {
      const reason = classifyOrphanSession(session, liveByBinding, liveByName);
      if (reason === null) {
        reconciledStoredSessions.push(session);
      } else {
        orphanRemovals.push({ session, reason });
      }
    }
    if (orphanRemovals.length > 0) {
      // 走 store.remove 路径，把分类后的 reason 一并写进结构化日志，
      // 取代之前 saveAll(reconciled) 的"批量沉默删除"。
      for (const { session, reason } of orphanRemovals) {
        await this.store.remove(session.session_id, reason);
      }
    }
    const storedTmuxNames = new Set(
      reconciledStoredSessions.map((session) => session.tmux_session_name),
    );
    const externalSessions = tmuxSessions
      .filter((session) => !storedTmuxNames.has(session.name))
      .map((session) => this.createExternalSession(session));

    const sessions = [...reconciledStoredSessions, ...externalSessions];
    const workspaces = this.workspaces
      ? await this.workspaces.list(sessions)
      : [];
    const annotatedSessions = await Promise.all(
      sessions.map((session) => this.annotateWorkspace(session, workspaces)),
    );

    return annotatedSessions.sort(compareSessionsByRecentTime);
  }

  async create(
    payload: SessionCreatePayload = {},
    onStatus?: SessionStatusListener,
  ): Promise<TerminalSession> {
    const sessionId = `sess_${randomUUID()}`;
    const tmuxSessionName = toTmuxSessionName(sessionId);
    const now = new Date().toISOString();
    const terminalProvider = this.terminalProviders.get(payload.terminal_provider_kind);
    const resolvedWorkspace = this.workspaces
      ? await this.workspaces.resolveCreateCwd(payload)
      : { cwd: payload.cwd ?? this.defaults.cwd, workspace: undefined };
    const cwd = resolvedWorkspace.cwd;
    const command = payload.command ?? terminalProvider.buildTuiCommand();
    const primarySurfaceId = toTerminalSurfaceId(sessionId);
    const size = clampTerminalSize(
      payload.terminal_size ?? this.defaults.terminalSize,
    );
    const providerSessionCount = await this.countSessionsForProvider(
      terminalProvider.kind,
    );
    const title =
      payload.title ?? terminalProvider.defaultTitle(providerSessionCount + 1);

    const created: TerminalSession = {
      session_id: sessionId,
      primary_surface_id: primarySurfaceId,
      surfaces: [
        createTerminalSurface({
          sessionId,
          title,
          status: "created",
          provider: terminalProvider.kind,
        }),
      ],
      terminal_provider_kind: terminalProvider.kind,
      terminal_provider_label: terminalProvider.displayName,
      title,
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
      ...withTerminalSurfaceStatus(created, "starting"),
      status: "starting" as const,
      last_active_at: new Date().toISOString(),
    };
    await this.store.upsert(starting);
    await onStatus?.(starting);

    try {
      const identity = await this.tmux.createSession({
        tmuxSessionName,
        cwd,
        command,
        size,
      });

      const running = {
        ...withTerminalSurfaceStatus(starting, "running"),
        status: "running" as const,
        last_active_at: new Date().toISOString(),
        // 用 tmux 真实分配的强 ID 绑定，让后续 reconcile 能识别
        // "同名但新进程"的歧义。
        tmux_server_pid: identity.serverPid || undefined,
        tmux_session_uid: identity.sessionUid || undefined,
      };
      await this.store.upsert(running);
      return running;
    } catch (error) {
      // 启动 tmux 失败时不再写 status="error" 占位，直接删除 store 条目，
      // 并把异常上抛给调用方（agentService）以便其向前端推送一次性失败提示。
      await this.store.remove(sessionId, "tmux_create_failed");
      throw error;
    }
  }

  async get(sessionId: string): Promise<TerminalSession | undefined> {
    return (await this.list()).find(
      (session) => session.session_id === sessionId,
    );
  }

  async getBySurfaceId(
    surfaceId: string,
  ): Promise<TerminalSession | undefined> {
    return (await this.list()).find((session) =>
      session.surfaces.some((surface) => surface.surface_id === surfaceId),
    );
  }

  async remove(sessionId: string): Promise<void> {
    await this.store.remove(sessionId, "manager_remove");
  }

  async close(sessionId: string): Promise<void> {
    const session = await this.get(sessionId);
    if (!session) {
      return;
    }

    if (session.origin === "external") {
      await this.store.remove(sessionId, "external_close");
      return;
    }

    try {
      await this.tmux.killSession(session.tmux_session_name);
    } catch {
      // Treat stale tmux records as already closed so mobile can recover.
    } finally {
      await this.store.remove(sessionId, "managed_close");
    }
  }

  async rename(
    sessionId: string,
    title: string,
  ): Promise<TerminalSession | undefined> {
    const session = await this.get(sessionId);
    const nextTitle = title.trim();
    if (!session || !nextTitle) {
      return undefined;
    }

    const renamed = {
      ...session,
      title: nextTitle,
      surfaces: session.surfaces.map((surface) =>
        surface.surface_id === session.primary_surface_id
          ? { ...surface, title: nextTitle }
          : surface,
      ),
      last_active_at: new Date().toISOString(),
      registered: session.registered ?? true,
    };
    await this.store.upsert(renamed);
    return renamed;
  }

  async killTerminal(sessionId: string): Promise<void> {
    const session = await this.get(sessionId);
    if (!session) {
      return;
    }

    try {
      await this.tmux.killSession(session.tmux_session_name);
    } finally {
      await this.store.remove(sessionId, "kill_terminal");
    }
  }

  async attach(sessionId: string): Promise<TerminalSession | undefined> {
    const session = await this.get(sessionId);
    if (!session) {
      return undefined;
    }

    if (session.origin === "external" && !session.registered) {
      const attached = {
        ...withTerminalSurfaceStatus(session, "running"),
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
  ): Promise<TerminalSession | undefined> {
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

  private async countSessionsForProvider(
    terminalProviderKind: TerminalProviderKind,
  ): Promise<number> {
    return (await this.store.list()).filter(
      (session) => session.terminal_provider_kind === terminalProviderKind,
    ).length;
  }

  private createExternalSession(session: {
    name: string;
    sessionUid: string;
    serverPid: number;
    createdAt: string;
    currentPath?: string;
    currentCommand?: string;
  }): TerminalSession {
    const terminalProvider = this.terminalProviders.infer(session.currentCommand);
    const sessionId = toExternalSessionId(session.name);
    return {
      session_id: sessionId,
      primary_surface_id: toTerminalSurfaceId(sessionId),
      surfaces: [
        createTerminalSurface({
          sessionId,
          title: session.name,
          status: "detached",
          provider: terminalProvider?.kind ?? "other",
        }),
      ],
      terminal_provider_kind: terminalProvider?.kind ?? "other",
      terminal_provider_label: terminalProvider?.displayName ?? "Other",
      title: session.name,
      cwd: session.currentPath || this.defaults.cwd,
      command: session.currentCommand || "tmux",
      status: "detached",
      created_at: session.createdAt,
      last_active_at: session.createdAt,
      terminal_size: this.defaults.terminalSize,
      tmux_session_name: session.name,
      tmux_server_pid: session.serverPid || undefined,
      tmux_session_uid: session.sessionUid || undefined,
      origin: "external",
      registered: false,
    };
  }

  private async annotateWorkspace(
    session: TerminalSession,
    workspaces: readonly WorkspaceDefinition[],
  ): Promise<TerminalSession> {
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

export function toTerminalSurfaceId(sessionId: string): string {
  return `surface_${sessionId}_terminal`;
}

function createTerminalSurface(input: {
  sessionId: string;
  title: string;
  status: TerminalSession["status"];
  provider: string;
}): SurfaceDefinition {
  return {
    surface_id: toTerminalSurfaceId(input.sessionId),
    session_id: input.sessionId,
    kind: "terminal",
    title: input.title,
    status: toSurfaceStatus(input.status),
    provider: input.provider,
  };
}

function withTerminalSurfaceStatus(
  session: TerminalSession,
  status: TerminalSession["status"],
): TerminalSession {
  return {
    ...session,
    surfaces: session.surfaces.map((surface) =>
      surface.surface_id === session.primary_surface_id
        ? { ...surface, status: toSurfaceStatus(status) }
        : surface,
    ),
  };
}

function toSurfaceStatus(
  status: TerminalSession["status"],
): SurfaceDefinition["status"] {
  if (status === "exited" || status === "archived") {
    return "ended";
  }
  if (status === "detached") {
    return "detached";
  }
  return "active";
}

function compareSessionsByRecentTime(
  left: TerminalSession,
  right: TerminalSession,
): number {
  return getSessionSortTime(right) - getSessionSortTime(left);
}

function getSessionSortTime(session: TerminalSession): number {
  const lastActiveAt = Date.parse(session.last_active_at);
  if (Number.isFinite(lastActiveAt)) {
    return lastActiveAt;
  }

  const createdAt = Date.parse(session.created_at);
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function toBindingKey(serverPid: number, sessionUid: string): string {
  return `${serverPid}:${sessionUid}`;
}

/**
 * orphan 删除分类。把"为什么从 store 中删掉这条 session"分级写进结构化
 * 日志，便于排查"会话突然消失"类问题：
 * - `tmux_server_pid_mismatch`：store 记录的 server_pid 在当前 live tmux
 *   中找不到，最常见于 tmux server 重启后同名复用。
 * - `tmux_session_uid_mismatch`：server_pid 命中但 session_uid 对不上，
 *   说明同一 server 内已被其他 session 占用同名（极少见，但要区分）。
 * - `not_in_tmux_ls`：当前 tmux ls 中既无 binding 命中也无同名条目。
 */
type OrphanReason =
  | "tmux_server_pid_mismatch"
  | "tmux_session_uid_mismatch"
  | "not_in_tmux_ls";

function classifyOrphanSession(
  session: TerminalSession,
  liveByBinding: Map<string, { serverPid: number; sessionUid: string }>,
  liveByName: Map<string, { serverPid: number; sessionUid: string }>,
): OrphanReason | null {
  // 仍处于初始化窗口（agent 调用 tmux new-session 后、下一次 list 前）
  // 的会话不应被误删，否则会和 create() 的状态机抢资源。
  if (session.status === "created" || session.status === "starting") {
    return null;
  }

  // 未登记的 external 条目本来就不会进入 store；这里防御性兜底，
  // 避免外部上游写入异常数据时被这条逻辑误删。
  if (session.registered === false) {
    return null;
  }

  // 强 ID 路径：store 里必须有 binding，且匹配同一 (server_pid, session_uid)，
  // 否则视为孤儿。可识别"同名但是新进程"的歧义场景。
  if (!session.tmux_server_pid || !session.tmux_session_uid) {
    return "not_in_tmux_ls";
  }
  const bindingKey = toBindingKey(
    session.tmux_server_pid,
    session.tmux_session_uid,
  );
  if (liveByBinding.has(bindingKey)) {
    return null;
  }
  // 同名命中但 binding 不一致 → 区分是 server 不同（tmux 重启）
  // 还是同 server 内 uid 不同（极少见，多 client 操作）。
  const liveSameName = liveByName.get(session.tmux_session_name);
  if (liveSameName && liveSameName.serverPid !== session.tmux_server_pid) {
    return "tmux_server_pid_mismatch";
  }
  if (liveSameName && liveSameName.sessionUid !== session.tmux_session_uid) {
    return "tmux_session_uid_mismatch";
  }
  return "not_in_tmux_ls";
}
