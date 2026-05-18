import {
  createMessage,
  type MessageEnvelope,
} from "../../../../packages/protocol-ts/src/index.ts";
import type {
  AgentHelloPayload,
  AuthVerifyPayload,
  CodexSession,
  SessionCreatePayload,
  SessionListPayload,
  SessionRenamePayload,
  TerminalErrorPayload,
  TerminalInputPayload,
  TerminalResizePayload,
} from "../../../../packages/protocol-ts/src/index.ts";

import type { AgentConfig } from "../config/config.ts";
import {
  createAndPersistSessionKey,
  createAgentInstanceId,
  verifyProof,
} from "../auth-key/authKey.ts";
import type { SessionKeyRecord } from "../auth-key/authKey.ts";
import { AgentRelayClient } from "../relay-client/agentRelayClient.ts";
import { RuntimeRegistry } from "../runtime/runtimeAdapter.ts";
import { SessionManager } from "./sessionManager.ts";
import { JsonSessionStore } from "../session-store/sessionStore.ts";
import { TerminalBridge } from "../pty-bridge/terminalBridge.ts";
import {
  TmuxManager,
  TmuxTargetMissingError,
} from "../tmux-manager/tmuxManager.ts";
import { Logger } from "../telemetry/logger.ts";
import {
  createPairingQrDetails,
  printPairingDetailsWithoutRelay,
  printPairingQr,
} from "../pairing/pairingQr.ts";

export class AgentService {
  private readonly logger = new Logger("omniwork-agent");
  private readonly tmux = new TmuxManager();
  private readonly runtimes: RuntimeRegistry;
  private readonly sessionManager: SessionManager;
  private readonly terminalBridge: TerminalBridge;
  private readonly config: AgentConfig;
  private keyRecord: SessionKeyRecord | null = null;
  private relay: AgentRelayClient | null = null;

  constructor(config: AgentConfig) {
    this.config = config;
    this.runtimes = new RuntimeRegistry({
      providers: config.agentProviders,
    });
    this.sessionManager = new SessionManager(
      new JsonSessionStore(config.sessionStorePath),
      this.tmux,
      this.runtimes,
      {
        cwd: config.defaultCwd,
        terminalSize: config.terminalSize,
      },
    );
    this.terminalBridge = new TerminalBridge(this.tmux);
  }

  async start(): Promise<void> {
    const agentInstanceId = createAgentInstanceId();
    this.keyRecord = await createAndPersistSessionKey({
      path: this.config.sessionKeyPath,
      agentInstanceId,
      relayUrl: this.config.relayUrl,
    });

    this.logger.info("generated temporary session key", {
      key_id: this.keyRecord.key_id,
      key_path: this.config.sessionKeyPath,
      agent_instance_id: this.keyRecord.agent_instance_id,
    });
    const pairingQr = createPairingQrDetails(this.config, this.keyRecord);
    if (pairingQr) {
      printPairingQr(pairingQr);
    } else {
      printPairingDetailsWithoutRelay(this.config, this.keyRecord);
    }

    const tmuxAvailable = await this.tmux.isAvailable();
    if (!tmuxAvailable) {
      this.logger.warn(
        "tmux is not available; session creation will fail until tmux is installed",
      );
    }

    if (!this.config.relayUrl) {
      this.logger.info(
        "OMNIWORK_RELAY_URL is not set; running without relay connection",
      );
      return;
    }

    await this.connectRelay(this.config.relayUrl);
  }

  private async connectRelay(url: string): Promise<void> {
    const keyRecord = this.requireKeyRecord();
    const relay = new AgentRelayClient(url);
    this.relay = relay;
    relay.onMessage((message) => {
      this.handleRelayMessage(message).catch((error: unknown) => {
        this.logger.error("failed to handle relay message", {
          message_type: message.type,
          error: String(error),
        });
      });
    });

    try {
      await relay.connect();
    } catch (error) {
      throw new Error(
        [
          `Unable to connect to OMNIWORK_RELAY_URL: ${url}`,
          "Start the relay first with `pnpm dev:relay`, then restart the Mac Agent.",
          `Original error: ${formatRelayConnectionError(error)}`,
        ].join("\n"),
      );
    }

    relay.send(
      createMessage<AgentHelloPayload>(
        "agent.hello",
        {
          device_id: this.config.deviceId,
          agent_instance_id: keyRecord.agent_instance_id,
          key_id: keyRecord.key_id,
          hostname: this.config.hostname,
          platform: "darwin",
          agent_version: this.config.agentVersion,
          providers: this.runtimes.providers(),
          capabilities: [
            "terminal.tui",
            "terminal.snapshot",
            "session.tmux",
            "session.tmux.attach",
            "session.tmux.kill",
            ...this.runtimes.capabilities(),
          ],
        },
        { device_id: this.config.deviceId },
      ),
    );

    this.logger.info("connected to relay", {
      relay_url: url,
      key_id: keyRecord.key_id,
    });
  }

  private async handleRelayMessage(message: MessageEnvelope): Promise<void> {
    switch (message.type) {
      case "auth.verify":
        this.handleAuthVerify(message as MessageEnvelope<AuthVerifyPayload>);
        break;
      case "session.list":
        await this.handleSessionList(message);
        break;
      case "session.create":
        await this.handleSessionCreate(
          message as MessageEnvelope<SessionCreatePayload>,
        );
        break;
      case "session.retry":
        await this.handleSessionRecovery(message, "retry");
        break;
      case "session.recover":
        await this.handleSessionRecovery(message, "recover");
        break;
      case "session.restart":
        await this.handleSessionRecovery(message, "restart");
        break;
      case "session.close":
        if (message.session_id) {
          await this.sessionManager.close(message.session_id);
          await this.handleSessionList(message);
        }
        break;
      case "session.rename":
        await this.handleSessionRename(
          message as MessageEnvelope<SessionRenamePayload>,
        );
        break;
      case "session.kill_tmux":
        if (message.session_id) {
          await this.sessionManager.killTmux(message.session_id);
          await this.handleSessionList(message);
        }
        break;
      case "terminal.input":
        await this.handleTerminalInput(
          message as MessageEnvelope<TerminalInputPayload>,
        );
        break;
      case "terminal.resize":
        await this.handleTerminalResize(
          message as MessageEnvelope<TerminalResizePayload>,
        );
        break;
      case "session.attach":
        await this.handleSessionAttach(message);
        break;
      case "terminal.snapshot":
        await this.handleTerminalSnapshot(message);
        break;
      default:
        this.logger.debug("ignored relay message", {
          message_type: message.type,
        });
    }
  }

  private handleAuthVerify(message: MessageEnvelope<AuthVerifyPayload>): void {
    const keyRecord = this.requireKeyRecord();
    const valid =
      message.payload.key_id === keyRecord.key_id &&
      verifyProof(keyRecord.key, message.payload.nonce, message.payload.proof);

    if (valid) {
      this.send(
        createMessage(
          "auth.ok",
          {
            agent_instance_id: keyRecord.agent_instance_id,
            connection_id: message.payload.connection_id,
          },
          { device_id: this.config.deviceId },
        ),
      );
    } else {
      this.send(
        createMessage(
          "auth.failed",
          {
            reason: "key_mismatch",
            connection_id: message.payload.connection_id,
            retry_after_ms: 2000,
          },
          { device_id: this.config.deviceId },
        ),
      );
    }
  }

  private async handleSessionList(message: MessageEnvelope): Promise<void> {
    const payload: SessionListPayload = {
      default_cwd: this.config.defaultCwd,
      providers: this.runtimes.providers(),
      sessions: await this.sessionManager.list(),
    };
    this.send(
      createMessage("session.list", payload, {
        device_id: this.config.deviceId,
        id: message.id,
      }),
    );
  }

  private async handleSessionCreate(
    message: MessageEnvelope<SessionCreatePayload>,
  ): Promise<void> {
    const session = await this.sessionManager.create(
      message.payload ?? {},
      (nextSession) => this.sendSessionStatus(nextSession),
    );
    this.sendSessionStatus(session);
    if (session.status !== "running" && session.status !== "detached") {
      return;
    }

    await this.handleTerminalSnapshot({
      ...message,
      session_id: session.session_id,
    });
  }

  private async handleSessionRename(
    message: MessageEnvelope<SessionRenamePayload>,
  ): Promise<void> {
    const sessionId = message.payload.session_id || message.session_id;
    if (!sessionId) {
      return;
    }

    const session = await this.sessionManager.rename(
      sessionId,
      message.payload.title,
    );
    if (session) {
      this.sendSessionStatus(session);
    }
    await this.handleSessionList(message);
  }

  private async handleSessionAttach(message: MessageEnvelope): Promise<void> {
    if (!message.session_id) {
      return;
    }

    const session = await this.sessionManager.attach(message.session_id);
    if (!session) {
      return;
    }

    this.send(
      createMessage(
        "session.status",
        { session },
        {
          device_id: this.config.deviceId,
          session_id: session.session_id,
        },
      ),
    );
    await this.handleTerminalSnapshot({
      ...message,
      session_id: session.session_id,
    });
  }

  private async handleSessionRecovery(
    message: MessageEnvelope,
    action: "retry" | "recover" | "restart",
  ): Promise<void> {
    if (!message.session_id) {
      return;
    }

    const session =
      action === "retry"
        ? await this.sessionManager.retry(message.session_id, (nextSession) =>
            this.sendSessionStatus(nextSession),
          )
        : action === "recover"
          ? await this.sessionManager.recover(message.session_id)
          : await this.sessionManager.restart(message.session_id, (nextSession) =>
              this.sendSessionStatus(nextSession),
            );
    if (!session) {
      return;
    }

    this.sendSessionStatus(session);
    await this.handleSessionList(message);
    if (session.status === "running" || session.status === "detached") {
      await this.handleTerminalSnapshot({
        ...message,
        session_id: session.session_id,
      });
    }
  }

  private async handleTerminalInput(
    message: MessageEnvelope<TerminalInputPayload>,
  ): Promise<void> {
    const session = message.session_id
      ? await this.sessionManager.get(message.session_id)
      : undefined;
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

  private async handleTerminalResize(
    message: MessageEnvelope<TerminalResizePayload>,
  ): Promise<void> {
    const session = message.session_id
      ? await this.sessionManager.get(message.session_id)
      : undefined;
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

  private async handleTerminalSnapshot(
    message: MessageEnvelope,
  ): Promise<void> {
    const session = message.session_id
      ? await this.sessionManager.get(message.session_id)
      : undefined;
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

    this.send(
      createMessage("terminal.snapshot", snapshot, {
        device_id: this.config.deviceId,
        session_id: session.session_id,
      }),
    );
  }

  private async handleMissingTmuxTarget(
    sessionId: string,
    error: TmuxTargetMissingError,
  ): Promise<void> {
    this.logger.warn("tmux target no longer exists; removing stale session", {
      session_id: sessionId,
      tmux_target: error.tmuxTarget,
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
          device_id: this.config.deviceId,
          session_id: sessionId,
        },
      ),
    );
    await this.handleSessionList(
      createMessage(
        "session.list",
        {},
        {
          device_id: this.config.deviceId,
        },
      ),
    );
  }

  private send(message: MessageEnvelope): void {
    if (!this.relay) {
      this.logger.warn("cannot send without relay", {
        message_type: message.type,
      });
      return;
    }

    this.relay.send(message);
  }

  private sendSessionStatus(session: CodexSession): void {
    this.send(
      createMessage(
        "session.status",
        { session },
        {
          device_id: this.config.deviceId,
          session_id: session.session_id,
        },
      ),
    );
  }

  private requireKeyRecord(): SessionKeyRecord {
    if (!this.keyRecord) {
      throw new Error("Session key has not been generated");
    }

    return this.keyRecord;
  }
}

function formatRelayConnectionError(error: unknown): string {
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
