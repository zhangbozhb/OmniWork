import {
  createMessage,
  type CodexSession,
  type MessageEnvelope,
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
  handleTerminalSnapshot(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void>;
};

export class SessionRequestHandler {
  constructor(private readonly options: SessionRequestHandlerOptions) {}

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
      session = await this.options.sessionManager.create(
        message.payload ?? {},
        (nextSession) => this.sendSessionStatus(nextSession),
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

    this.sendSessionStatus(session);
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
      this.sendSessionStatus(session);
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

  private sendSessionStatus(session: CodexSession): void {
    this.options.sendToApp(
      undefined,
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
