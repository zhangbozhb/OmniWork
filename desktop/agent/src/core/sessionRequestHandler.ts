import {
  createMessage,
  type CodexSession,
  type MessageEnvelope,
  type RuntimeKind,
  type SessionCreatePayload,
  type SessionListPayload,
  type SessionRenamePayload,
  type TerminalErrorPayload,
} from "@omniwork/protocol-ts";
import { RuntimeRegistry } from "../runtime/runtimeAdapter.ts";
import { WorkspaceManager } from "../workspace/workspaceManager.ts";
import type { SessionManager } from "./sessionManager.ts";
import type { TerminalFramePusher } from "./terminalFramePusher.ts";

type AgentDispatchContext = {
  appConnectionId: string;
  trustedE2E: boolean;
};

type SessionRequestHandlerOptions = {
  deviceId: string;
  defaultCwd: string;
  runtimes: RuntimeRegistry;
  workspaces: WorkspaceManager;
  sessionManager: SessionManager;
  terminalFramePusher: TerminalFramePusher;
  sendToApp(context: AgentDispatchContext | undefined, message: MessageEnvelope): void;
  prepareRuntime?(runtime: {
    kind: RuntimeKind;
    command: string;
  }): Promise<void>;
  handleTerminalSnapshot(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void>;
};

export class SessionRequestHandler {
  private readonly options: SessionRequestHandlerOptions;

  constructor(options: SessionRequestHandlerOptions) {
    this.options = options;
  }

  async handleList(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void> {
    const sessions = await this.options.sessionManager.list();
    const payload: SessionListPayload = {
      default_cwd: this.options.defaultCwd,
      providers: this.options.runtimes.providers(),
      workspaces: await this.options.workspaces.list(sessions),
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
      const runtime = this.options.runtimes.get(message.payload?.runtime_kind);
      await this.options.prepareRuntime?.({
        kind: runtime.kind,
        command: message.payload?.command ?? runtime.buildTuiCommand(),
      });
      session = await this.options.sessionManager.create(
        message.payload ?? {},
        (nextSession) => this.sendSessionStatus(nextSession, context),
      );
    } catch (error) {
      this.options.sendToApp(
        context,
        createMessage<TerminalErrorPayload>(
          "terminal.error",
          {
            code: "SESSION_CREATE_FAILED",
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

    await this.options.handleTerminalSnapshot(
      {
        ...message,
        session_id: session.session_id,
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

  async handleClose(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void> {
    if (!message.session_id) {
      return;
    }

    this.options.terminalFramePusher.stop(message.session_id);
    await this.options.sessionManager.close(message.session_id);
    await this.handleList(message, context);
  }

  async handleKillTmux(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void> {
    if (!message.session_id) {
      return;
    }

    this.options.terminalFramePusher.stop(message.session_id);
    await this.options.sessionManager.killTmux(message.session_id);
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
        },
      ),
    );
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
      },
      context,
    );
    this.options.terminalFramePusher.start(session.session_id);
  }

  private sendSessionStatus(
    session: CodexSession,
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
        },
      ),
    );
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
