import {
  E2E_NOISE_NNPSK0_CAPABILITY_V1,
  ENCRYPTED_ONLY_BUSINESS_CAPABILITY_V1,
  PLAINTEXT_BUSINESS_CAPABILITY_V1,
  PROTOCOL_SUPPORT_V1,
  TERMINAL_STREAM_CAPABILITY_V1,
  createMessage,
  type AgentHelloPayload,
  type MessageEnvelope,
} from "@omniwork/protocol-ts";
import type { RelayCloseEvent } from "@omniwork/relay-client";
import type { AgentConfig } from "../config/config.ts";
import type { SessionKeyRecord } from "../auth-key/authKey.ts";
import { AgentRelayClient } from "../relay-client/agentRelayClient.ts";
import type { TerminalProviderRegistry } from "../terminal-provider/terminalProviderRegistry.ts";
import type { WorkspaceManager } from "../workspace/workspaceManager.ts";
import { AgentRelayPath, AgentSessionTransport } from "../transport/index.ts";
import type { TerminalStreamPusher } from "./terminalStreamPusher.ts";
import type { Logger } from "../telemetry/logger.ts";
import { createRelayDeviceAuth } from "./relayDeviceAuth.ts";
import {
  classifyRelayClose,
  formatRelayConnectionError,
  isTerminalRelayConnectionError,
  nextRelayReconnectDelayMs,
  relayReconnectAttemptLimitLabel,
  shouldLimitRelayReconnectAttempt,
  type RelayConnectionStatus,
} from "./relayReconnectPolicy.ts";
import type { AgentRelayRuntimeStatus } from "./agentRuntimeTypes.ts";
import type { E2E_SUPPORT_V1 } from "@omniwork/protocol-ts";

interface AgentRelayControllerOptions {
  config: AgentConfig;
  logger: Logger;
  logTransport: boolean;
  terminalProviders: TerminalProviderRegistry;
  workspaces: WorkspaceManager;
  terminalStreamPusher: TerminalStreamPusher;
  getKeyRecord(): SessionKeyRecord;
  e2eSupport(): typeof E2E_SUPPORT_V1;
  onMessage(message: MessageEnvelope): Promise<void>;
  onRelayUnavailable(): void;
}

export class AgentRelayController {
  private readonly config: AgentConfig;
  private readonly logger: Logger;
  private readonly logTransport: boolean;
  private readonly terminalProviders: TerminalProviderRegistry;
  private readonly workspaces: WorkspaceManager;
  private readonly terminalStreamPusher: TerminalStreamPusher;
  private readonly getKeyRecord: () => SessionKeyRecord;
  private readonly e2eSupport: () => typeof E2E_SUPPORT_V1;
  private readonly onMessage: (message: MessageEnvelope) => Promise<void>;
  private readonly onRelayUnavailable: () => void;
  private relay: AgentRelayClient | null = null;
  private transport: AgentSessionTransport | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayResolve: (() => void) | null = null;
  private status: RelayConnectionStatus = "idle";
  private lastError: string | null = null;
  private lastClose: RelayCloseEvent | null = null;
  private nextRetryAt: number | null = null;
  private stopping = false;

  constructor(options: AgentRelayControllerOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.logTransport = options.logTransport;
    this.terminalProviders = options.terminalProviders;
    this.workspaces = options.workspaces;
    this.terminalStreamPusher = options.terminalStreamPusher;
    this.getKeyRecord = options.getKeyRecord;
    this.e2eSupport = options.e2eSupport;
    this.onMessage = options.onMessage;
    this.onRelayUnavailable = options.onRelayUnavailable;
  }

  start(): void {
    this.stopping = false;
    this.startRelayConnector();
  }

  stop(): void {
    this.stopping = true;
    void this.terminalStreamPusher.stopAll();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectDelayResolve?.();
    this.reconnectDelayResolve = null;
    this.transport?.close("agent stopping");
    this.transport = null;
    this.relay?.close();
    this.relay = null;
    if (this.status !== "terminal_error") {
      this.updateStatus("stopped");
    }
  }

  getTransport(): AgentSessionTransport | null {
    return this.transport;
  }

  statusSnapshot(): AgentRelayRuntimeStatus {
    return {
      status: this.status,
      reconnectAttempts: this.reconnectAttempts,
      nextRetryAt: this.nextRetryAt,
      lastError: this.lastError,
      lastClose: this.lastClose,
    };
  }

  private startRelayConnector(): void {
    this.updateStatus("connecting");
    void this.connectRelayWithRetry(this.config.relayUrl).catch(
      (error: unknown) => {
        if (this.stopping) {
          return;
        }
        this.lastError = formatRelayConnectionError(error);
        this.updateStatus("terminal_error");
        this.logger.error("relay connector stopped unexpectedly", {
          error: this.lastError,
        });
        this.scheduleRelayReconnect({ terminal: true });
      },
    );
  }

  private async connectRelay(url: string): Promise<void> {
    const keyRecord = this.getKeyRecord();
    const relay = new AgentRelayClient(url);
    this.relay = relay;
    const relayPath = new AgentRelayPath(relay);
    const transport = new AgentSessionTransport(relayPath);
    this.transport = transport;

    transport.onEvent((event) => {
      switch (event.type) {
        case "path_change":
          this.logger.info("transport path changed", {
            from: event.from,
            to: event.to,
          });
          break;
        case "ping_timeout":
          this.logger.warn("transport ping timeout", {
            seq: event.seq,
            count: event.count,
          });
          break;
        case "pong_received":
          if (this.logTransport) {
            this.logger.debug("transport pong received", {
              seq: event.seq,
              rtt_ms: event.rtt_ms,
            });
          }
          break;
        case "downgrade":
          this.logger.warn("transport downgrade", { reason: event.reason });
          break;
        case "display_frame_deferred":
          if (this.logTransport) {
            this.logger.debug("display frame deferred", {
              app_connection_id: event.app_connection_id,
              buffered_amount: event.buffered_amount,
            });
          }
          break;
      }
    });

    transport.onMessage((message) => {
      this.onMessage(message).catch((error: unknown) => {
        this.logger.error("failed to handle relay message", {
          message_type: message.type,
          error: String(error),
        });
      });
    });
    try {
      this.updateStatus("connecting");
      await relay.connect();
    } catch (error) {
      relay.close(1000, "connect failed");
      this.cleanupRelayResources(relay, transport);
      throw new Error(
        [
          `Unable to connect to OMNIWORK_RELAY_URL: ${url}`,
          "Start the relay first with `pnpm dev:relay`, then restart the Desktop Agent.",
          `Original error: ${formatRelayConnectionError(error)}`,
        ].join("\n"),
      );
    }
    relay.onClose((event) => this.handleRelayClose(event));

    relay.send(
      createMessage<AgentHelloPayload>(
        "agent.hello",
        {
          v: PROTOCOL_SUPPORT_V1.current,
          device_id: this.config.deviceId,
          agent_instance_id: keyRecord.agent_instance_id,
          key_id: keyRecord.key_id,
          ...(this.config.relayDevicePrivateKey
            ? {
                relay_auth: createRelayDeviceAuth({
                  deviceId: this.config.deviceId,
                  agentInstanceId: keyRecord.agent_instance_id,
                  privateKeyPem: this.config.relayDevicePrivateKey,
                }),
              }
            : {}),
          protocol: PROTOCOL_SUPPORT_V1,
          e2e: this.e2eSupport(),
          business_security_mode: this.config.businessSecurityMode,
          hostname: this.config.hostname,
          platform: "darwin",
          agent_version: this.config.agentVersion,
          providers: this.terminalProviders.providers(),
          workspaces: this.workspaces.snapshot(),
          capabilities: [
            E2E_NOISE_NNPSK0_CAPABILITY_V1,
            this.config.businessSecurityMode === "e2e_required"
              ? ENCRYPTED_ONLY_BUSINESS_CAPABILITY_V1
              : PLAINTEXT_BUSINESS_CAPABILITY_V1,
            "terminal.tui",
            "terminal.snapshot",
            ...(this.config.terminalStreamEnabled
              ? [TERMINAL_STREAM_CAPABILITY_V1]
              : []),
            "session.tmux",
            "session.tmux.attach",
            "session.tmux.kill",
            "workspace.list",
            "files.read",
            "files.write",
            "git.read",
            "agent.message",
            "agent.message.inbox.sqlite",
            "agent.notification.settings",
            "agent.probe.codex",
            "agent.probe.codex.app_server",
            "agent.probe.claude_code",
            "agent.probe.trae",
            "agent.probe.trae_cn",
            "agent.probe.tmux",
            ...this.terminalProviders.capabilities(),
          ],
        },
        { device_id: this.config.deviceId },
      ),
    );

    this.logger.info("connected to relay", {
      relay_url: url,
      key_id: keyRecord.key_id,
    });
    this.reconnectAttempts = 0;
    this.lastError = null;
    this.lastClose = null;
    this.nextRetryAt = null;
    this.updateStatus("connected");
  }

  private async connectRelayWithRetry(url: string): Promise<void> {
    while (!this.stopping) {
      const nextAttempt = this.reconnectAttempts + 1;
      try {
        this.reconnectAttempts = nextAttempt;
        await this.connectRelay(url);
        return;
      } catch (error) {
        this.lastError = formatRelayConnectionError(error);
        if (isTerminalRelayConnectionError(error)) {
          const delayMs = this.config.relayReconnectMaxDelayMs;
          this.nextRetryAt = Date.now() + delayMs;
          this.updateStatus("terminal_error");
          this.logger.error("relay connect rejected; retrying slowly", {
            attempt: nextAttempt,
            delay_ms: delayMs,
            error: this.lastError,
          });
          await this.waitRelayReconnectDelay(delayMs);
          continue;
        }
        const attemptsExhausted = this.hasRelayReconnectAttemptLimit(
          nextAttempt + 1,
        );
        const delayMs = this.reconnectDelayMs(nextAttempt);
        this.nextRetryAt = Date.now() + delayMs;
        this.updateStatus("reconnecting");
        this.logger.warn(
          attemptsExhausted
            ? "relay connect attempts exhausted; continuing background retries"
            : "relay connect attempt failed; retrying",
          {
            attempt: nextAttempt,
            max_attempts: this.relayReconnectAttemptLimitLabel(),
            delay_ms: delayMs,
            error: formatRelayConnectionError(error),
          },
        );
        await this.waitRelayReconnectDelay(delayMs);
      }
    }
  }

  private handleRelayClose(event: RelayCloseEvent): void {
    if (this.stopping) {
      return;
    }

    this.logger.warn("relay connection closed", {
      code: event.code,
      reason: event.reason ?? "",
    });

    this.lastClose = {
      code: event.code,
      reason: event.reason,
    };
    this.cleanupRelayResources(this.relay, this.transport);
    this.onRelayUnavailable();
    if (classifyRelayClose(event) === "terminal") {
      this.logger.error("relay explicitly rejected agent connection", {
        code: event.code,
        reason: event.reason ?? "",
      });
      this.updateStatus("terminal_error");
      this.scheduleRelayReconnect({ terminal: true });
      return;
    }

    this.scheduleRelayReconnect();
  }

  private scheduleRelayReconnect(options: { terminal?: boolean } = {}): void {
    if (this.stopping || this.reconnectTimer) {
      return;
    }

    const nextAttempt = this.reconnectAttempts + 1;
    const attemptsExhausted = this.hasRelayReconnectAttemptLimit(nextAttempt);
    const delayMs = options.terminal
      ? this.config.relayReconnectMaxDelayMs
      : this.reconnectDelayMs(nextAttempt);
    this.nextRetryAt = Date.now() + delayMs;
    if (options.terminal) {
      this.updateStatus("terminal_error");
    } else {
      this.updateStatus("reconnecting");
    }
    this.logScheduledRelayReconnect(
      options.terminal
        ? "scheduling slow relay reconnect after terminal rejection"
        : attemptsExhausted
          ? "relay reconnect attempts exhausted; continuing background retries"
          : "scheduling relay reconnect",
      { attempt: nextAttempt, delayMs },
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectRelay().catch((error: unknown) => {
        this.lastError = formatRelayConnectionError(error);
        if (isTerminalRelayConnectionError(error)) {
          this.logger.error("relay reconnect rejected; retrying slowly", {
            attempt: nextAttempt,
            error: this.lastError,
          });
          this.updateStatus("terminal_error");
          this.scheduleRelayReconnect({ terminal: true });
          return;
        }
        this.logger.warn("relay reconnect failed", {
          attempt: nextAttempt,
          error: this.lastError,
        });
        this.scheduleRelayReconnect();
      });
    }, delayMs);
  }

  private async waitRelayReconnectDelay(delayMs: number): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    await new Promise<void>((resolve) => {
      this.reconnectDelayResolve = resolve;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnectDelayResolve = null;
        resolve();
      }, delayMs);
    });
  }

  private async reconnectRelay(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.reconnectAttempts += 1;
    this.nextRetryAt = null;
    await this.connectRelay(this.config.relayUrl);
  }

  private reconnectDelayMs(attempt: number): number {
    return nextRelayReconnectDelayMs({
      attempt,
      initialDelayMs: this.config.relayReconnectInitialDelayMs,
      maxDelayMs: this.config.relayReconnectMaxDelayMs,
    });
  }

  private hasRelayReconnectAttemptLimit(nextAttempt: number): boolean {
    return shouldLimitRelayReconnectAttempt({
      reconnectForever: this.config.relayReconnectForever,
      maxAttempts: this.config.relayReconnectMaxAttempts,
      nextAttempt,
    });
  }

  private relayReconnectAttemptLimitLabel(): number | "unlimited" {
    return relayReconnectAttemptLimitLabel({
      reconnectForever: this.config.relayReconnectForever,
      maxAttempts: this.config.relayReconnectMaxAttempts,
    });
  }

  private logScheduledRelayReconnect(
    message: string,
    input: { attempt: number; delayMs: number },
  ): void {
    this.logger.warn(message, {
      attempt: input.attempt,
      max_attempts: this.relayReconnectAttemptLimitLabel(),
      delay_ms: input.delayMs,
    });
  }

  private updateStatus(status: RelayConnectionStatus): void {
    this.status = status;
  }

  private cleanupRelayResources(
    relay: AgentRelayClient | null,
    transport: AgentSessionTransport | null,
  ): void {
    void this.terminalStreamPusher.stopAll();
    if (this.transport === transport) {
      this.transport = null;
    }
    if (this.relay === relay) {
      this.relay = null;
    }
    transport?.close("relay disconnected");
  }
}
