import { createMessage, type MessageEnvelope } from "../../../../packages/protocol-ts/src/index.ts";
import type {
  AgentHelloPayload,
  AuthVerifyPayload,
  SessionCreatePayload,
  SessionListPayload,
  TerminalInputPayload,
  TerminalResizePayload,
} from "../../../../packages/protocol-ts/src/index.ts";

import type { AgentConfig } from "../config/config.ts";
import { createAndPersistSessionKey, createAgentInstanceId, verifyProof } from "../auth-key/authKey.ts";
import type { SessionKeyRecord } from "../auth-key/authKey.ts";
import { AgentRelayClient } from "../relay-client/agentRelayClient.ts";
import { RuntimeRegistry } from "../runtime/runtimeAdapter.ts";
import { SessionManager } from "./sessionManager.ts";
import { JsonSessionStore } from "../session-store/sessionStore.ts";
import { TerminalBridge } from "../pty-bridge/terminalBridge.ts";
import { TmuxManager } from "../tmux-manager/tmuxManager.ts";
import { Logger } from "../telemetry/logger.ts";

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
      codexCommand: config.codexCommand,
      claudeCommand: config.claudeCommand,
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

    const tmuxAvailable = await this.tmux.isAvailable();
    if (!tmuxAvailable) {
      this.logger.warn("tmux is not available; session creation will fail until tmux is installed");
    }

    if (!this.config.relayUrl) {
      this.logger.info("OMNIWORK_RELAY_URL is not set; running without relay connection");
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

    await relay.connect();
    relay.send(
      createMessage<AgentHelloPayload>("agent.hello", {
        device_id: this.config.deviceId,
        agent_instance_id: keyRecord.agent_instance_id,
        key_id: keyRecord.key_id,
        hostname: this.config.hostname,
        platform: "darwin",
        agent_version: this.config.agentVersion,
        capabilities: [
          "terminal.tui",
          "terminal.snapshot",
          "session.tmux",
          ...this.runtimes.capabilities(),
        ],
      }, { device_id: this.config.deviceId }),
    );

    this.logger.info("connected to relay", { relay_url: url, key_id: keyRecord.key_id });
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
        await this.handleSessionCreate(message as MessageEnvelope<SessionCreatePayload>);
        break;
      case "session.close":
        if (message.session_id) {
          await this.sessionManager.close(message.session_id);
          await this.handleSessionList(message);
        }
        break;
      case "terminal.input":
        await this.handleTerminalInput(message as MessageEnvelope<TerminalInputPayload>);
        break;
      case "terminal.resize":
        await this.handleTerminalResize(message as MessageEnvelope<TerminalResizePayload>);
        break;
      case "terminal.snapshot":
      case "session.attach":
        await this.handleTerminalSnapshot(message);
        break;
      default:
        this.logger.debug("ignored relay message", { message_type: message.type });
    }
  }

  private handleAuthVerify(message: MessageEnvelope<AuthVerifyPayload>): void {
    const keyRecord = this.requireKeyRecord();
    const valid =
      message.payload.key_id === keyRecord.key_id &&
      verifyProof(keyRecord.key, message.payload.nonce, message.payload.proof);

    if (valid) {
      this.send(
        createMessage("auth.ok", {
          agent_instance_id: keyRecord.agent_instance_id,
          connection_id: message.payload.connection_id,
        }, { device_id: this.config.deviceId }),
      );
    } else {
      this.send(
        createMessage("auth.failed", {
          reason: "key_mismatch",
          connection_id: message.payload.connection_id,
          retry_after_ms: 2000,
        }, { device_id: this.config.deviceId }),
      );
    }
  }

  private async handleSessionList(message: MessageEnvelope): Promise<void> {
    const payload: SessionListPayload = {
      default_cwd: this.config.defaultCwd,
      sessions: await this.sessionManager.list(),
    };
    this.send(createMessage("session.list", payload, { device_id: this.config.deviceId, id: message.id }));
  }

  private async handleSessionCreate(message: MessageEnvelope<SessionCreatePayload>): Promise<void> {
    const session = await this.sessionManager.create(message.payload ?? {});
    this.send(
      createMessage("session.status", { session }, {
        device_id: this.config.deviceId,
        session_id: session.session_id,
      }),
    );
    await this.handleTerminalSnapshot({ ...message, session_id: session.session_id });
  }

  private async handleTerminalInput(message: MessageEnvelope<TerminalInputPayload>): Promise<void> {
    const session = message.session_id ? await this.sessionManager.get(message.session_id) : undefined;
    if (!session) {
      return;
    }

    await this.terminalBridge.writeInput(session, message.payload);
  }

  private async handleTerminalResize(message: MessageEnvelope<TerminalResizePayload>): Promise<void> {
    const session = message.session_id ? await this.sessionManager.get(message.session_id) : undefined;
    if (!session) {
      return;
    }

    await this.terminalBridge.resize(session, message.payload);
    await this.sessionManager.updateTerminalSize(session.session_id, message.payload);
  }

  private async handleTerminalSnapshot(message: MessageEnvelope): Promise<void> {
    const session = message.session_id ? await this.sessionManager.get(message.session_id) : undefined;
    if (!session) {
      return;
    }

    const snapshot = await this.terminalBridge.snapshot(session);
    this.send(
      createMessage("terminal.snapshot", snapshot, {
        device_id: this.config.deviceId,
        session_id: session.session_id,
      }),
    );
  }

  private send(message: MessageEnvelope): void {
    if (!this.relay) {
      this.logger.warn("cannot send without relay", { message_type: message.type });
      return;
    }

    this.relay.send(message);
  }

  private requireKeyRecord(): SessionKeyRecord {
    if (!this.keyRecord) {
      throw new Error("Session key has not been generated");
    }

    return this.keyRecord;
  }
}
