import {
  createMessage,
  type TerminalSession,
  type MessageEnvelope,
  type TerminalProviderKind,
  type SessionCreatePayload,
  type SessionListPayload,
  type SessionRenamePayload,
  type TerminalErrorPayload,
} from "@omni-work/protocol-ts";
import { TerminalProviderRegistry } from "../terminal-provider/terminalProviderRegistry.ts";
import { WorkspaceManager } from "../workspace/workspaceManager.ts";
import { GitService } from "../git/gitService.ts";
import type { SessionManager } from "./sessionManager.ts";
import type { TerminalFramePusher } from "./terminalFramePusher.ts";

type AgentDispatchContext = {
  appConnectionId: string;
  trustedE2E: boolean;
};

type SessionRequestHandlerOptions = {
  deviceId: string;
  defaultCwd: string;
  terminalProviders: TerminalProviderRegistry;
  workspaces: WorkspaceManager;
  git: GitService;
  sessionManager: SessionManager;
  terminalFramePusher: TerminalFramePusher;
  sendToApp(context: AgentDispatchContext | undefined, message: MessageEnvelope): void;
  prepareTerminalProvider?(terminalProvider: {
    kind: TerminalProviderKind;
    command: string;
  }): Promise<void>;
  closeAgentSurfaceSession?(sessionId: string): void;
  handleTerminalSnapshot(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void>;
};

export class SessionRequestHandler {
  private readonly options: SessionRequestHandlerOptions;
  private readonly pendingCreates = new Map<string, Promise<TerminalSession>>();
  private readonly completedCreates = new Map<string, TerminalSession>();

  constructor(options: SessionRequestHandlerOptions) {
    this.options = options;
  }

  async handleList(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void> {
    const { sessions, workspaces } =
      await this.options.sessionManager.listWithWorkspaces();
    const payload: SessionListPayload = {
      default_cwd: this.options.defaultCwd,
      providers: this.options.terminalProviders.providers(),
      workspaces,
      sessions,
    };
    this.options.sendToApp(
      context,
      createMessage("session.list", payload, {
        device_id: this.options.deviceId,
        id: message.id,
      }),
    );
  }

  async handleCreate(
    message: MessageEnvelope<SessionCreatePayload>,
    context?: AgentDispatchContext,
  ): Promise<void> {
    let session;
    try {
      session = await this.createSession(
        message.payload ?? {},
        (nextSession) => this.sendSessionStatus(nextSession, context),
      );
    } catch (error) {
      this.options.sendToApp(
        context,
        createMessage<TerminalErrorPayload>(
          "terminal.error",
          {
            code:
              error instanceof WorktreeRetainedError
                ? "SESSION_CREATE_FAILED_WORKTREE_RETAINED"
                : "SESSION_CREATE_FAILED",
            message: formatHandlerError(error),
          },
          { device_id: this.options.deviceId },
        ),
      );
      return;
    }

    this.sendSessionStatus(session, context);
    if (session.status !== "running" && session.status !== "detached") {
      return;
    }
    if (session.runtime?.capabilities.terminal_io === false) {
      return;
    }

    await this.options.handleTerminalSnapshot(
      {
        ...message,
        session_id: session.session_id,
        surface_id: session.primary_surface_id,
      },
      context,
    );
    if (context) {
      this.options.terminalFramePusher.addSubscriber(
        session.session_id,
        context.appConnectionId,
      );
    }
    this.options.terminalFramePusher.start(session.session_id);
  }

  private async createSession(
    payload: SessionCreatePayload,
    onStatus: (session: TerminalSession) => void,
  ): Promise<TerminalSession> {
    const actionId = payload.create_action_id;
    if (!actionId) {
      return this.createSessionOnce(payload, onStatus);
    }
    const completed = this.completedCreates.get(actionId);
    if (completed) {
      return completed;
    }
    const pending = this.pendingCreates.get(actionId);
    if (pending) {
      return pending;
    }

    const create = this.createSessionOnce(payload, onStatus);
    this.pendingCreates.set(actionId, create);
    try {
      const session = await create;
      this.completedCreates.set(actionId, session);
      if (this.completedCreates.size > 100) {
        const oldest = this.completedCreates.keys().next().value;
        if (oldest) {
          this.completedCreates.delete(oldest);
        }
      }
      return session;
    } finally {
      if (this.pendingCreates.get(actionId) === create) {
        this.pendingCreates.delete(actionId);
      }
    }
  }

  private async createSessionOnce(
    payload: SessionCreatePayload,
    onStatus: (session: TerminalSession) => void,
  ): Promise<TerminalSession> {
    const terminalProvider = this.options.terminalProviders.get(
      payload.terminal_provider_kind,
    );
    await this.options.prepareTerminalProvider?.({
      kind: terminalProvider.kind,
      command: payload.command ?? terminalProvider.buildTuiCommand(),
    });

    const { managed_worktree: managedWorktree, ...base } = payload;
    let createPayload: SessionCreatePayload = base;
    let retainedWorktreePath: string | undefined;
    if (managedWorktree) {
      const workspace = await this.options.workspaces.get(
        managedWorktree.source_workspace_path,
      );
      if (!workspace?.isGitRepository) {
        throw new Error("Managed worktrees require a Git workspace.");
      }
      const result = await this.options.git.createWorktree(
        workspace,
        managedWorktree.name,
      );
      retainedWorktreePath = result.created.path;
      createPayload = {
        ...base,
        cwd: undefined,
        workspace_path: result.created.path,
      };
    }

    try {
      return await this.options.sessionManager.create(createPayload, onStatus);
    } catch (error) {
      if (retainedWorktreePath) {
        throw new WorktreeRetainedError(retainedWorktreePath, error);
      }
      throw error;
    }
  }

  async handleClose(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void> {
    if (!message.session_id) {
      return;
    }

    this.options.terminalFramePusher.stop(message.session_id);
    this.options.closeAgentSurfaceSession?.(message.session_id);
    await this.options.sessionManager.close(message.session_id);
    await this.handleList(message, context);
  }

  async handleKillTerminal(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void> {
    if (!message.session_id) {
      return;
    }

    this.options.terminalFramePusher.stop(message.session_id);
    this.options.closeAgentSurfaceSession?.(message.session_id);
    await this.options.sessionManager.killTerminal(message.session_id);
    await this.handleList(message, context);
  }

  async handleRename(
    message: MessageEnvelope<SessionRenamePayload>,
    context?: AgentDispatchContext,
  ): Promise<void> {
    const sessionId = message.payload.session_id || message.session_id;
    if (!sessionId) {
      return;
    }

    const session = await this.options.sessionManager.rename(
      sessionId,
      message.payload.title,
    );
    if (session) {
      this.sendSessionStatus(session, context);
    }
    await this.handleList(message, context);
  }

  async handleAttach(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void> {
    if (!message.session_id) {
      return;
    }

    const session = await this.options.sessionManager.attach(message.session_id);
    if (!session) {
      return;
    }

    this.options.sendToApp(
      context,
      createMessage(
        "session.status",
        { session },
        {
          device_id: this.options.deviceId,
          session_id: session.session_id,
          surface_id: session.primary_surface_id,
        },
      ),
    );
    if (session.runtime?.capabilities.terminal_io === false) {
      return;
    }
    if (context) {
      this.options.terminalFramePusher.addSubscriber(
        session.session_id,
        context.appConnectionId,
      );
    }
    await this.options.handleTerminalSnapshot(
      {
        ...message,
        session_id: session.session_id,
        surface_id: session.primary_surface_id,
      },
      context,
    );
    this.options.terminalFramePusher.start(session.session_id);
  }

  private sendSessionStatus(
    session: TerminalSession,
    context?: AgentDispatchContext,
  ): void {
    this.options.sendToApp(
      context,
      createMessage(
        "session.status",
        { session },
        {
          device_id: this.options.deviceId,
          session_id: session.session_id,
          surface_id: session.primary_surface_id,
        },
      ),
    );
  }
}

class WorktreeRetainedError extends Error {
  constructor(path: string, cause: unknown) {
    super(
      `The managed worktree was created at ${path}, but the session failed to start: ${formatHandlerError(cause)}`,
    );
    this.name = "WorktreeRetainedError";
  }
}

function formatHandlerError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
