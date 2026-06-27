import {
  createMessage,
  type AgentProbeEvent,
  type MessageEnvelope,
  type TerminalErrorPayload,
  type TerminalInputPayload,
  type TerminalResizePayload,
  type TerminalSession,
  type TerminalStreamStartPayload,
  type TerminalStreamStopPayload,
} from "@omniwork/protocol-ts";
import { TerminalBridge } from "../pty-bridge/terminalBridge.ts";
import { TmuxTargetMissingError } from "../tmux-manager/tmuxManager.ts";
import type { Logger } from "../telemetry/logger.ts";
import type { SessionManager } from "./sessionManager.ts";
import type { SessionRequestHandler } from "./sessionRequestHandler.ts";
import type { TerminalFramePusher } from "./terminalFramePusher.ts";
import type { TerminalStreamPusher } from "./terminalStreamPusher.ts";
import type { AgentDispatchContext } from "./agentRuntimeTypes.ts";

interface TerminalRequestHandlerOptions {
  deviceId: string;
  logger: Logger;
  terminalBridge: TerminalBridge;
  sessionManager: SessionManager;
  terminalFramePusher: TerminalFramePusher;
  terminalStreamPusher: TerminalStreamPusher;
  getSessionRequests(): SessionRequestHandler;
  send(message: MessageEnvelope): void;
  sendToApp(
    context: AgentDispatchContext | undefined,
    message: MessageEnvelope,
  ): void;
  publishLocalProbeEvent(event: AgentProbeEvent): void;
}

export class TerminalRequestHandler {
  private readonly deviceId: string;
  private readonly logger: Logger;
  private readonly sessionManager: SessionManager;
  private readonly terminalBridge: TerminalBridge;
  private readonly terminalFramePusher: TerminalFramePusher;
  private readonly terminalStreamPusher: TerminalStreamPusher;
  private readonly getSessionRequests: () => SessionRequestHandler;
  private readonly send: (message: MessageEnvelope) => void;
  private readonly sendToApp: (
    context: AgentDispatchContext | undefined,
    message: MessageEnvelope,
  ) => void;
  private readonly publishLocalProbeEvent: (event: AgentProbeEvent) => void;

  constructor(options: TerminalRequestHandlerOptions) {
    this.deviceId = options.deviceId;
    this.logger = options.logger;
    this.sessionManager = options.sessionManager;
    this.terminalBridge = options.terminalBridge;
    this.terminalFramePusher = options.terminalFramePusher;
    this.terminalStreamPusher = options.terminalStreamPusher;
    this.getSessionRequests = options.getSessionRequests;
    this.send = options.send;
    this.sendToApp = options.sendToApp;
    this.publishLocalProbeEvent = options.publishLocalProbeEvent;
  }

  async handleInput(
    message: MessageEnvelope<TerminalInputPayload>,
  ): Promise<void> {
    const session = await this.resolveTerminalSession(message);
    if (!session) {
      return;
    }

    try {
      await this.terminalBridge.writeInput(session, message.payload);
    } catch (error) {
      if (error instanceof TmuxTargetMissingError) {
        await this.handleMissingTmuxTarget(session.session_id, error);
        return;
      }
      throw error;
    }
  }

  async handleResize(
    message: MessageEnvelope<TerminalResizePayload>,
  ): Promise<void> {
    const session = await this.resolveTerminalSession(message);
    if (!session) {
      return;
    }

    try {
      await this.terminalBridge.resize(session, message.payload);
      await this.sessionManager.updateTerminalSize(
        session.session_id,
        message.payload,
      );
    } catch (error) {
      if (error instanceof TmuxTargetMissingError) {
        await this.handleMissingTmuxTarget(session.session_id, error);
        return;
      }
      throw error;
    }
  }

  async handleStreamStart(
    message: MessageEnvelope<TerminalStreamStartPayload>,
    context?: AgentDispatchContext,
  ): Promise<void> {
    if (!message.surface_id || !context) {
      return;
    }
    const session = await this.resolveTerminalSession(message);
    if (!session) {
      return;
    }
    await this.terminalStreamPusher.start(
      session.session_id,
      message.surface_id,
      context.appConnectionId,
    );
  }

  async handleStreamStop(
    message: MessageEnvelope<TerminalStreamStopPayload>,
    context?: AgentDispatchContext,
  ): Promise<void> {
    const session = await this.resolveTerminalSession(message);
    if (!session) {
      return;
    }
    await this.terminalStreamPusher.stop(
      session.session_id,
      context?.appConnectionId,
    );
  }

  async handleSnapshot(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void> {
    if (!message.surface_id) {
      return;
    }
    const session = await this.resolveTerminalSession(message);
    if (!session) {
      return;
    }

    let snapshot;
    try {
      snapshot = await this.terminalBridge.snapshot(session);
    } catch (error) {
      if (error instanceof TmuxTargetMissingError) {
        await this.handleMissingTmuxTarget(session.session_id, error);
        return;
      }
      throw error;
    }

    const snapshotSeq = this.terminalFramePusher.nextSeq(session.session_id);
    this.sendToApp(
      context,
      createMessage("terminal.snapshot", snapshot, {
        device_id: this.deviceId,
        session_id: session.session_id,
        surface_id: message.surface_id,
        seq: snapshotSeq,
      }),
    );
    this.terminalFramePusher.rememberFrameData(
      session.session_id,
      snapshot.data,
    );
  }

  async handleMissingTmuxTarget(
    sessionId: string,
    error: TmuxTargetMissingError,
  ): Promise<void> {
    const session = await this.sessionManager.get(sessionId);
    this.terminalFramePusher.stop(sessionId);
    await this.terminalStreamPusher.stop(sessionId);
    this.logger.warn("tmux target no longer exists; removing stale session", {
      session_id: sessionId,
      tmux_target: error.tmuxTarget,
    });
    this.publishLocalProbeEvent({
      id: `tmux-exited:${sessionId}:${error.tmuxTarget}`,
      provider: session?.terminal_provider_kind ?? "unknown",
      probe_id: "tmux-probe",
      session_id: sessionId,
      surface_id: session?.primary_surface_id,
      workspace_path: session?.workspace_path ?? session?.cwd,
      event_type: "agent.exited",
      severity: "warning",
      title: "Terminal runtime exited",
      summary: "The tmux pane no longer exists.",
      source: {
        kind: "tmux",
        raw_event_id: error.tmuxTarget,
      },
      created_at: new Date().toISOString(),
    });
    await this.sessionManager.remove(sessionId);
    this.send(
      createMessage<TerminalErrorPayload>(
        "terminal.error",
        {
          code: error.code,
          message:
            "The tmux pane no longer exists. The stale session was removed.",
        },
        {
          device_id: this.deviceId,
          session_id: sessionId,
        },
      ),
    );
    await this.getSessionRequests().handleList(
      createMessage(
        "session.list",
        {},
        {
          device_id: this.deviceId,
        },
      ),
    );
  }

  private async resolveTerminalSession(
    message: Pick<MessageEnvelope, "surface_id">,
  ): Promise<TerminalSession | undefined> {
    if (!message.surface_id) {
      return undefined;
    }
    return (
      this.sessionManager.getKnownBySurfaceId(message.surface_id) ??
      (await this.sessionManager.getBySurfaceId(message.surface_id))
    );
  }
}
