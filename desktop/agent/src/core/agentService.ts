import {
  E2E_NOISE_NNPSK0_CAPABILITY_V1,
  E2E_SUPPORT_V1,
  ENCRYPTED_ONLY_BUSINESS_CAPABILITY_V1,
  PLAINTEXT_BUSINESS_CAPABILITY_V1,
  PROTOCOL_SUPPORT_V1,
  TERMINAL_STREAM_CAPABILITY_V1,
  createMessage,
  innerToMessage,
  isE2EBusinessMessage,
  messageToInner,
  parseMessageEnvelope,
  type AppConnectionGoodbyePayload,
  type AppConnectionHeartbeatPayload,
  type MessageEnvelope,
  type P2pChannelKind,
} from "@omniwork/protocol-ts";
import type {
  AgentHelloPayload,
  E2EHandshakeInitPayload,
  E2EMessagePayload,
  E2EReadyPayload,
  AuthVerifyPayload,
  FilesListRequestPayload,
  FilesReadRequestPayload,
  FilesWriteRequestPayload,
  GitDiffRequestPayload,
  GitStatusRequestPayload,
  SessionCreatePayload,
  SessionRenamePayload,
  TerminalErrorPayload,
  TerminalInputPayload,
  TerminalResizePayload,
  TerminalStreamStartPayload,
  TerminalStreamStopPayload,
  TunnelUpgradeAnswerPayload,
  TunnelUpgradeCandidatePayload,
  TunnelUpgradeCommittedPayload,
  TunnelUpgradeDowngradePayload,
  TunnelUpgradeOfferPayload,
  TunnelUpgradeProposePayload,
} from "@omniwork/protocol-ts";
import {
  E2ENoiseError,
  acceptInitiatorHandshake,
  type E2ENoiseSession,
} from "@omniwork/e2e-noise";

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
import { SQLiteSessionStore } from "../session-store/sessionStore.ts";
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
import { AgentRelayPath, AgentSessionTransport } from "../transport/index.ts";
import { UpgradeCoordinator } from "../transport/upgradeCoordinator.ts";
import { createAgentWebRtcPeerAdapter } from "../transport/webRtcPeerAdapter.ts";
import { AuthReplayCache } from "./authReplayCache.ts";
import { WorkspaceManager } from "../workspace/workspaceManager.ts";
import { ResourceRequestHandler } from "./resourceRequestHandler.ts";
import { SessionRequestHandler } from "./sessionRequestHandler.ts";
import { TerminalFramePusher } from "./terminalFramePusher.ts";
import { TerminalStreamPusher } from "./terminalStreamPusher.ts";
import { AppConnectionRegistry } from "./appConnectionRegistry.ts";
import { AgentAdminServer } from "./adminServer.ts";
import type { RelayCloseEvent } from "@omniwork/relay-client";
import {
  classifyRelayClose,
  formatRelayConnectionError,
  isTerminalRelayConnectionError,
  nextRelayReconnectDelayMs,
  relayReconnectAttemptLimitLabel,
  shouldLimitRelayReconnectAttempt,
  type RelayConnectionStatus,
} from "./relayReconnectPolicy.ts";

interface AppE2EPeer {
  appConnectionId: string;
  session: E2ENoiseSession;
  ready: boolean;
}

interface AgentDispatchContext {
  appConnectionId: string;
  trustedE2E: boolean;
}

export class AgentService {
  private readonly logger = new Logger("omniwork-agent");
  private readonly tmux = new TmuxManager();
  private readonly runtimes: RuntimeRegistry;
  private readonly workspaces: WorkspaceManager;
  private readonly sessionManager: SessionManager;
  private readonly resourceRequests: ResourceRequestHandler;
  private readonly sessionRequests: SessionRequestHandler;
  private readonly terminalBridge: TerminalBridge;
  private readonly terminalFramePusher: TerminalFramePusher;
  private readonly terminalStreamPusher: TerminalStreamPusher;
  private readonly config: AgentConfig;
  private keyRecord: SessionKeyRecord | null = null;
  private agentStartedAt = Date.now();
  private agentInstanceId = "";
  private relay: AgentRelayClient | null = null;
  private transport: AgentSessionTransport | null = null;
  private adminServer: AgentAdminServer | null = null;
  private readonly upgradeCoordinators = new Map<string, UpgradeCoordinator>();
  private readonly e2ePeers = new Map<string, AppE2EPeer>();
  private readonly authenticatedAppConnectionIds = new Set<string>();
  private readonly authReplayCache = new AuthReplayCache();
  private readonly appConnections: AppConnectionRegistry;
  private relayReconnectAttempts = 0;
  private relayReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private relayReconnectDelayResolve: (() => void) | null = null;
  private relayStatus: RelayConnectionStatus = "idle";
  private relayLastError: string | null = null;
  private relayLastClose: RelayCloseEvent | null = null;
  private relayNextRetryAt: number | null = null;
  private stopping = false;
  private readonly logTransport =
    (process.env.OMNIWORK_LOG_TRANSPORT ?? "") === "1";
  constructor(config: AgentConfig) {
    this.config = config;
    this.appConnections = new AppConnectionRegistry({
      heartbeatIntervalMs: config.connectionHeartbeatMs,
      staleTimeoutMs: config.connectionStaleMs,
      disconnectTimeoutMs: config.connectionDisconnectMs,
    });
    this.runtimes = new RuntimeRegistry({
      providers: config.agentProviders,
    });
    this.workspaces = new WorkspaceManager({
      defaultCwd: config.defaultCwd,
    });
    this.sessionManager = new SessionManager(
      new SQLiteSessionStore(config.sessionStorePath),
      this.tmux,
      this.runtimes,
      this.workspaces,
      {
        cwd: config.defaultCwd,
        terminalSize: config.terminalSize,
      },
    );
    this.resourceRequests = new ResourceRequestHandler({
      deviceId: this.config.deviceId,
      workspaces: this.workspaces,
      listSessions: () => this.sessionManager.list(),
      sendToApp: (context, message) => this.sendToApp(context, message),
    });
    this.terminalBridge = new TerminalBridge(this.tmux);
    this.terminalFramePusher = new TerminalFramePusher({
      deviceId: this.config.deviceId,
      logTransport: this.logTransport,
      logger: this.logger,
      sessionManager: this.sessionManager,
      terminalBridge: this.terminalBridge,
      getBufferedAmountForApp: (appConnectionId) =>
        this.transport?.getBufferedAmountForApp(appConnectionId) ?? 0,
      emitDisplayFrameDeferred: (appConnectionId, bufferedAmount) =>
        this.transport?.emitDisplayFrameDeferred(
          appConnectionId,
          bufferedAmount,
        ),
      sendToAppByConnectionId: (appConnectionId, message, channel) =>
        this.sendToAppByConnectionId(appConnectionId, message, channel),
      onMissingTmuxTarget: (sessionId, error) =>
        this.handleMissingTmuxTarget(sessionId, error),
    });
    this.terminalStreamPusher = new TerminalStreamPusher({
      deviceId: this.config.deviceId,
      enabled: this.config.terminalStreamEnabled,
      logger: this.logger,
      sessionManager: this.sessionManager,
      tmux: this.tmux,
      sendToAppByConnectionId: (appConnectionId, message, channel) =>
        this.sendToAppByConnectionId(appConnectionId, message, channel),
      onMissingTmuxTarget: (sessionId, error) =>
        this.handleMissingTmuxTarget(sessionId, error),
    });
    this.sessionRequests = new SessionRequestHandler({
      deviceId: this.config.deviceId,
      defaultCwd: this.config.defaultCwd,
      runtimes: this.runtimes,
      workspaces: this.workspaces,
      sessionManager: this.sessionManager,
      terminalFramePusher: this.terminalFramePusher,
      sendToApp: (context, message) => this.sendToApp(context, message),
      handleTerminalSnapshot: (message, context) =>
        this.handleTerminalSnapshot(message, context),
    });
  }

  async start(): Promise<void> {
    try {
      this.stopping = false;
      const agentInstanceId = createAgentInstanceId();
      this.agentStartedAt = Date.now();
      this.agentInstanceId = agentInstanceId;
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

      // 对持久化 session store 做一次性补丁（清理已废弃的 status 等），与运行期
      // reconcile 的职责分离；具体规则集中在 SessionManager.applyStartupPatches。
      await this.sessionManager.applyStartupPatches();
      await this.startAdminServer();

      this.startRelayConnector();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.stopping = true;
    void this.terminalStreamPusher.stopAll();
    if (this.relayReconnectTimer) {
      clearTimeout(this.relayReconnectTimer);
      this.relayReconnectTimer = null;
    }
    this.relayReconnectDelayResolve?.();
    this.relayReconnectDelayResolve = null;
    this.transport?.close("agent stopping");
    this.transport = null;
    this.relay?.close();
    this.relay = null;
    if (this.relayStatus !== "terminal_error") {
      this.updateRelayStatus("stopped");
    }
    this.adminServer?.close();
    this.adminServer = null;
  }

  private startRelayConnector(): void {
    this.updateRelayStatus("connecting");
    void this.connectRelayWithRetry(this.config.relayUrl).catch(
      (error: unknown) => {
        if (this.stopping) {
          return;
        }
        this.relayLastError = formatRelayConnectionError(error);
        this.updateRelayStatus("terminal_error");
        this.logger.error("relay connector stopped unexpectedly", {
          error: this.relayLastError,
        });
        this.scheduleRelayReconnect({ terminal: true });
      },
    );
  }

  private async connectRelay(url: string): Promise<void> {
    const keyRecord = this.requireKeyRecord();
    const relay = new AgentRelayClient(url);
    this.relay = relay;
    const relayPath = new AgentRelayPath(relay);
    const transport = new AgentSessionTransport(relayPath);
    this.transport = transport;

    // transport 健康事件 → Logger（pong_received 仅在 OMNIWORK_LOG_TRANSPORT=1 时打印）。
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

    // 通过 transport 订阅业务消息，覆盖 relay path + P2P path 两条通道；
    // P2P 升级成功后 mobile 端的业务消息只会出现在 DataChannel 上，
    // 直接订阅 relay.onMessage 会漏掉这部分流量（终端永远拿不到 snapshot）。
    transport.onMessage((message) => {
      this.handleRelayMessage(message).catch((error: unknown) => {
        this.logger.error("failed to handle relay message", {
          message_type: message.type,
          error: String(error),
        });
      });
    });
    try {
      this.updateRelayStatus("connecting");
      await relay.connect();
    } catch (error) {
      relay.close(1000, "connect failed");
      this.cleanupRelayResources(relay, transport);
      throw new Error(
        [
          `Unable to connect to OMNIWORK_RELAY_URL: ${url}`,
          "Start the relay first with `pnpm dev:relay`, then restart the Mac Agent.",
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
          protocol: PROTOCOL_SUPPORT_V1,
          e2e: this.e2eSupport(),
          business_security_mode: this.config.businessSecurityMode,
          hostname: this.config.hostname,
          platform: "darwin",
          agent_version: this.config.agentVersion,
          providers: this.runtimes.providers(),
          workspaces: await this.workspaces.list(),
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
    this.relayReconnectAttempts = 0;
    this.relayLastError = null;
    this.relayLastClose = null;
    this.relayNextRetryAt = null;
    this.updateRelayStatus("connected");
  }

  private async connectRelayWithRetry(url: string): Promise<void> {
    while (!this.stopping) {
      const nextAttempt = this.relayReconnectAttempts + 1;
      try {
        this.relayReconnectAttempts = nextAttempt;
        await this.connectRelay(url);
        return;
      } catch (error) {
        this.relayLastError = formatRelayConnectionError(error);
        if (isTerminalRelayConnectionError(error)) {
          const delayMs = this.config.relayReconnectMaxDelayMs;
          this.relayNextRetryAt = Date.now() + delayMs;
          this.updateRelayStatus("terminal_error");
          this.logger.error("relay connect rejected; retrying slowly", {
            attempt: nextAttempt,
            delay_ms: delayMs,
            error: this.relayLastError,
          });
          await this.waitRelayReconnectDelay(delayMs);
          continue;
        }
        const attemptsExhausted = this.hasRelayReconnectAttemptLimit(
          nextAttempt + 1,
        );
        const delayMs = this.reconnectDelayMs(nextAttempt);
        this.relayNextRetryAt = Date.now() + delayMs;
        this.updateRelayStatus("reconnecting");
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

  private handleRelayClose(event: RelayCloseEvent): void {
    if (this.stopping) {
      return;
    }

    this.logger.warn("relay connection closed", {
      code: event.code,
      reason: event.reason ?? "",
    });

    this.relayLastClose = {
      code: event.code,
      reason: event.reason,
    };
    this.cleanupRelayResources(this.relay, this.transport);
    this.clearRelayAppConnectionState();
    if (classifyRelayClose(event) === "terminal") {
      this.logger.error("relay explicitly rejected agent connection", {
        code: event.code,
        reason: event.reason ?? "",
      });
      this.updateRelayStatus("terminal_error");
      this.scheduleRelayReconnect({ terminal: true });
      return;
    }

    this.scheduleRelayReconnect();
  }

  private scheduleRelayReconnect(options: { terminal?: boolean } = {}): void {
    if (this.stopping || this.relayReconnectTimer) {
      return;
    }

    const nextAttempt = this.relayReconnectAttempts + 1;
    const attemptsExhausted = this.hasRelayReconnectAttemptLimit(nextAttempt);
    const delayMs = options.terminal
      ? this.config.relayReconnectMaxDelayMs
      : this.reconnectDelayMs(nextAttempt);
    this.relayNextRetryAt = Date.now() + delayMs;
    if (options.terminal) {
      this.updateRelayStatus("terminal_error");
    } else {
      this.updateRelayStatus("reconnecting");
    }
    this.logScheduledRelayReconnect(
      options.terminal
        ? "scheduling slow relay reconnect after terminal rejection"
        : attemptsExhausted
          ? "relay reconnect attempts exhausted; continuing background retries"
          : "scheduling relay reconnect",
      { attempt: nextAttempt, delayMs },
    );
    this.relayReconnectTimer = setTimeout(() => {
      this.relayReconnectTimer = null;
      this.reconnectRelay().catch((error: unknown) => {
        this.relayLastError = formatRelayConnectionError(error);
        if (isTerminalRelayConnectionError(error)) {
          this.logger.error("relay reconnect rejected; retrying slowly", {
            attempt: nextAttempt,
            error: this.relayLastError,
          });
          this.updateRelayStatus("terminal_error");
          this.scheduleRelayReconnect({ terminal: true });
          return;
        }
        this.logger.warn("relay reconnect failed", {
          attempt: nextAttempt,
          error: this.relayLastError,
        });
        this.scheduleRelayReconnect();
      });
    }, delayMs);
  }

  private async waitRelayReconnectDelay(delayMs: number): Promise<void> {
    if (this.relayReconnectTimer) {
      clearTimeout(this.relayReconnectTimer);
    }
    await new Promise<void>((resolve) => {
      this.relayReconnectDelayResolve = resolve;
      this.relayReconnectTimer = setTimeout(() => {
        this.relayReconnectTimer = null;
        this.relayReconnectDelayResolve = null;
        resolve();
      }, delayMs);
    });
  }

  private async reconnectRelay(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.relayReconnectAttempts += 1;
    this.relayNextRetryAt = null;
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

  private updateRelayStatus(status: RelayConnectionStatus): void {
    this.relayStatus = status;
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

  private clearRelayAppConnectionState(): void {
    this.authenticatedAppConnectionIds.clear();
    this.e2ePeers.clear();
    this.upgradeCoordinators.clear();
    this.appConnections.markRelayUnavailable();
  }

  private async handleRelayMessage(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void> {
    const trustedE2E = context?.trustedE2E === true;
    const dispatchContext =
      context ??
      (message.app_connection_id
        ? {
            appConnectionId: message.app_connection_id,
            trustedE2E: false,
          }
        : undefined);
    switch (message.type) {
      case "auth.verify":
        this.handleAuthVerify(message as MessageEnvelope<AuthVerifyPayload>);
        break;
      case "e2e.handshake.init":
        this.handleE2EHandshakeInit(
          message as MessageEnvelope<E2EHandshakeInitPayload>,
        );
        break;
      case "e2e.ready":
        this.handleE2EReady(message as MessageEnvelope<E2EReadyPayload>);
        break;
      case "e2e.message":
        await this.handleE2EMessage(
          message as MessageEnvelope<E2EMessagePayload>,
        );
        break;
      case "app.connection.heartbeat":
        this.handleConnectionHeartbeat(
          message as MessageEnvelope<AppConnectionHeartbeatPayload>,
          dispatchContext,
          trustedE2E,
        );
        break;
      case "app.connection.goodbye":
        this.handleConnectionGoodbye(
          message as MessageEnvelope<AppConnectionGoodbyePayload>,
          dispatchContext,
          trustedE2E,
        );
        break;
      case "session.list":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.sessionRequests.handleList(message, dispatchContext);
        break;
      case "session.create":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.sessionRequests.handleCreate(
          message as MessageEnvelope<SessionCreatePayload>,
          dispatchContext,
        );
        break;
      case "session.close":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        if (message.session_id) {
          await this.terminalStreamPusher.stop(message.session_id);
        }
        await this.sessionRequests.handleClose(message, dispatchContext);
        break;
      case "session.rename":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.sessionRequests.handleRename(
          message as MessageEnvelope<SessionRenamePayload>,
          dispatchContext,
        );
        break;
      case "session.kill_tmux":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        if (message.session_id) {
          await this.terminalStreamPusher.stop(message.session_id);
        }
        await this.sessionRequests.handleKillTmux(message, dispatchContext);
        break;
      case "workspace.list":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.resourceRequests.handleWorkspaceList(
          message,
          dispatchContext,
        );
        break;
      case "files.list":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.resourceRequests.handleFilesList(
          message as MessageEnvelope<FilesListRequestPayload>,
          dispatchContext,
        );
        break;
      case "files.read":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.resourceRequests.handleFilesRead(
          message as MessageEnvelope<FilesReadRequestPayload>,
          dispatchContext,
        );
        break;
      case "files.write":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.resourceRequests.handleFilesWrite(
          message as MessageEnvelope<FilesWriteRequestPayload>,
          dispatchContext,
        );
        break;
      case "git.status":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.resourceRequests.handleGitStatus(
          message as MessageEnvelope<GitStatusRequestPayload>,
          dispatchContext,
        );
        break;
      case "git.diff":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.resourceRequests.handleGitDiff(
          message as MessageEnvelope<GitDiffRequestPayload>,
          dispatchContext,
        );
        break;
      case "terminal.input":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.handleTerminalInput(
          message as MessageEnvelope<TerminalInputPayload>,
        );
        break;
      case "terminal.resize":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.handleTerminalResize(
          message as MessageEnvelope<TerminalResizePayload>,
        );
        break;
      case "session.attach":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.sessionRequests.handleAttach(message, dispatchContext);
        break;
      case "terminal.snapshot":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.handleTerminalSnapshot(message, dispatchContext);
        break;
      case "terminal.stream.start":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.handleTerminalStreamStart(
          message as MessageEnvelope<TerminalStreamStartPayload>,
          dispatchContext,
        );
        break;
      case "terminal.stream.stop":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.handleTerminalStreamStop(
          message as MessageEnvelope<TerminalStreamStopPayload>,
          dispatchContext,
        );
        break;
      case "tunnel.upgrade.propose": {
        const payload = (
          message as MessageEnvelope<TunnelUpgradeProposePayload>
        ).payload;
        if (
          this.config.businessSecurityMode === "e2e_required" &&
          !trustedE2E &&
          !this.e2ePeers.get(payload.app_connection_id)?.ready
        ) {
          this.rejectPlaintextBusiness(message, trustedE2E);
          return;
        }
        if (
          !this.recordInboundBusinessForConnection(
            message,
            payload.app_connection_id,
            trustedE2E,
            { skipPlaintextReject: true },
          )
        ) {
          return;
        }
        await this.getUpgradeCoordinator(payload.app_connection_id).propose(
          payload,
        );
        break;
      }
      case "tunnel.upgrade.offer":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        {
          const payload = (
            message as MessageEnvelope<TunnelUpgradeOfferPayload>
          ).payload;
          await this.getUpgradeCoordinator(
            payload.app_connection_id,
          ).handleOffer(payload);
        }
        break;
      case "tunnel.upgrade.answer":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        {
          const payload = (
            message as MessageEnvelope<TunnelUpgradeAnswerPayload>
          ).payload;
          await this.getUpgradeCoordinator(
            payload.app_connection_id,
          ).handleAnswer(payload);
        }
        break;
      case "tunnel.upgrade.candidate":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        {
          const payload = (
            message as MessageEnvelope<TunnelUpgradeCandidatePayload>
          ).payload;
          await this.getUpgradeCoordinator(
            payload.app_connection_id,
          ).handleCandidate(payload);
        }
        break;
      case "tunnel.upgrade.committed":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        {
          const payload = (
            message as MessageEnvelope<TunnelUpgradeCommittedPayload>
          ).payload;
          this.getUpgradeCoordinator(payload.app_connection_id).handleCommitted(
            payload,
          );
        }
        break;
      case "tunnel.upgrade.downgrade":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        {
          const payload = (
            message as MessageEnvelope<TunnelUpgradeDowngradePayload>
          ).payload;
          this.getUpgradeCoordinator(payload.app_connection_id).downgrade(
            payload.reason,
          );
        }
        break;
      default:
        this.logger.debug("ignored relay message", {
          message_type: message.type,
        });
    }
  }

  private getUpgradeCoordinator(appConnectionId: string): UpgradeCoordinator {
    const existing = this.upgradeCoordinators.get(appConnectionId);
    if (existing) {
      return existing;
    }
    if (!this.transport) {
      throw new Error("Cannot create upgrade coordinator without transport.");
    }
    const coordinator = new UpgradeCoordinator({
      role: "answerer",
      deviceId: this.config.deviceId,
      peerFactory: (opts) =>
        createAgentWebRtcPeerAdapter({
          iceServers: opts.iceServers,
          role: opts.role,
        }),
      sendControl: (envelope) =>
        this.sendToAppByConnectionId(appConnectionId, envelope),
      onSwitchPath: (path) => {
        this.appConnections.setPath(appConnectionId, path);
        if (path === "p2p") {
          const peer = coordinator.getPeer();
          const upgradeId = coordinator.getUpgradeId();
          if (peer) {
            this.transport?.attachP2pPeer(peer, {
              appConnectionId,
              upgradeId: upgradeId ?? undefined,
              onDowngrade: (reason) => coordinator.downgrade(reason),
            });
          }
        } else {
          this.transport?.detachP2pPeer(appConnectionId);
        }
        void this.transport?.switchPath(path);
      },
      onForceClose: (reason) => {
        this.logger.warn("strict_p2p_disconnect", {
          app_connection_id: appConnectionId,
          reason,
        });
        this.transport?.detachP2pPeer(appConnectionId);
      },
    });
    coordinator.onEvent((event) => {
      if (event.type === "propose") {
        this.logger.info("upgrade propose", {
          app_connection_id: appConnectionId,
          upgrade_id: event.upgrade_id,
          role: event.role,
        });
      } else if (event.type === "upgrade_success") {
        this.logger.info("upgrade success", {
          app_connection_id: appConnectionId,
          upgrade_id: event.upgrade_id,
        });
      } else {
        this.logger.warn("upgrade failed", {
          app_connection_id: appConnectionId,
          upgrade_id: event.upgrade_id,
          reason: event.reason,
        });
      }
    });
    this.upgradeCoordinators.set(appConnectionId, coordinator);
    return coordinator;
  }

  private handleConnectionHeartbeat(
    message: MessageEnvelope<AppConnectionHeartbeatPayload>,
    context: AgentDispatchContext | undefined,
    trustedE2E: boolean,
  ): void {
    if (!context) {
      return;
    }
    if (!this.recordInboundBusiness(message, context, trustedE2E)) {
      return;
    }
    this.appConnections.acceptHeartbeat(
      context.appConnectionId,
      message.payload,
    );
  }

  private handleConnectionGoodbye(
    message: MessageEnvelope<AppConnectionGoodbyePayload>,
    context: AgentDispatchContext | undefined,
    trustedE2E: boolean,
  ): void {
    if (!context) {
      return;
    }
    if (!this.recordInboundBusiness(message, context, trustedE2E)) {
      return;
    }
    this.appConnections.markGoodbye(context.appConnectionId, message.payload);
  }

  private handleE2EHandshakeInit(
    message: MessageEnvelope<E2EHandshakeInitPayload>,
  ): void {
    if (
      !this.appConnections.hasAuthenticatedConnection(
        message.payload.app_connection_id,
      )
    ) {
      this.logger.warn("rejected e2e handshake before authenticated tracking", {
        app_connection_id: message.payload.app_connection_id,
      });
      return;
    }
    const keyRecord = this.requireKeyRecord();
    try {
      const result = acceptInitiatorHandshake(
        {
          pairingKey: keyRecord.key,
          deviceId: this.config.deviceId,
          keyId: keyRecord.key_id,
          agentInstanceId: keyRecord.agent_instance_id,
          appConnectionId: message.payload.app_connection_id,
          handshakeId: message.payload.handshake_id,
        },
        message.payload,
      );
      const peer: AppE2EPeer = {
        appConnectionId: message.payload.app_connection_id,
        session: result.session,
        ready: false,
      };
      this.e2ePeers.set(peer.appConnectionId, peer);
      this.send(
        createMessage("e2e.handshake.reply", result.reply, {
          device_id: this.config.deviceId,
        }),
      );
      this.send(
        createMessage("e2e.ready", result.session.readyPayload(), {
          device_id: this.config.deviceId,
        }),
      );
      this.logger.info("e2e handshake accepted", {
        handshake_id: result.reply.handshake_id,
        e2e_session_id: result.session.sessionId,
      });
    } catch (error) {
      this.e2ePeers.delete(message.payload.app_connection_id);
      this.logger.warn("e2e handshake failed", { error: String(error) });
      this.send(
        createMessage(
          "e2e.failed",
          {
            v: PROTOCOL_SUPPORT_V1.current,
            e2e_version: E2E_SUPPORT_V1.versions[0],
            app_connection_id: message.payload.app_connection_id,
            handshake_id: message.payload.handshake_id,
            reason:
              error instanceof E2ENoiseError &&
              error.code === "unsupported_suite"
                ? "unsupported_suite"
                : "handshake_failed",
          },
          { device_id: this.config.deviceId },
        ),
      );
    }
  }

  private handleE2EReady(message: MessageEnvelope<E2EReadyPayload>): void {
    const peer = this.e2ePeers.get(message.payload.app_connection_id);
    if (!peer) {
      this.logger.warn("e2e ready without active session", {
        app_connection_id: message.payload.app_connection_id,
        handshake_id: message.payload.handshake_id,
      });
      return;
    }
    if (
      message.payload.handshake_id !== peer.session.handshakeId ||
      message.payload.transcript_hash !== peer.session.transcriptHash
    ) {
      this.logger.warn("e2e ready transcript mismatch", {
        app_connection_id: message.payload.app_connection_id,
        handshake_id: message.payload.handshake_id,
      });
      this.e2ePeers.delete(message.payload.app_connection_id);
      return;
    }
    peer.ready = true;
    this.appConnections.markE2EReady(message.payload.app_connection_id);
    this.logger.info("e2e ready confirmed", {
      app_connection_id: message.payload.app_connection_id,
      handshake_id: message.payload.handshake_id,
      e2e_session_id: peer.session.sessionId,
    });
  }

  private async handleE2EMessage(
    message: MessageEnvelope<E2EMessagePayload>,
  ): Promise<void> {
    const peer = this.e2ePeers.get(message.payload.app_connection_id);
    if (!peer?.ready) {
      this.logger.warn("e2e message without active session", {
        app_connection_id: message.payload.app_connection_id,
        e2e_session_id: message.payload.e2e_session_id,
      });
      return;
    }
    try {
      const inner = peer.session.decrypt(message.payload);
      const decoded = parseMessageEnvelope(
        innerToMessage(inner, this.config.deviceId),
      );
      if (!decoded) {
        this.logger.warn("rejected invalid e2e business message", {
          app_connection_id: message.payload.app_connection_id,
        });
        return;
      }
      this.appConnections.markE2EReady(message.payload.app_connection_id);
      await this.handleRelayMessage(decoded, {
        appConnectionId: message.payload.app_connection_id,
        trustedE2E: true,
      });
    } catch (error) {
      this.logger.warn("failed to decrypt e2e message", {
        error: String(error),
      });
      if (
        error instanceof E2ENoiseError &&
        (error.code === "decrypt_failed" || error.code === "replay_detected")
      ) {
        this.e2ePeers.delete(message.payload.app_connection_id);
      }
    }
  }

  private rejectPlaintextBusiness(
    message: MessageEnvelope,
    trustedE2E: boolean,
  ): boolean {
    if (
      trustedE2E ||
      this.config.businessSecurityMode === "plaintext_allowed"
    ) {
      return false;
    }
    this.logger.warn("rejected plaintext business message", {
      message_type: message.type,
    });
    return true;
  }

  private recordInboundBusiness(
    message: MessageEnvelope,
    context: AgentDispatchContext | undefined,
    trustedE2E: boolean,
  ): boolean {
    return this.recordInboundBusinessForConnection(
      message,
      context?.appConnectionId ?? appConnectionIdFromMessage(message),
      trustedE2E,
    );
  }

  private recordInboundBusinessForConnection(
    message: MessageEnvelope,
    appConnectionId: string | undefined,
    trustedE2E: boolean,
    options: { skipPlaintextReject?: boolean } = {},
  ): boolean {
    if (
      !options.skipPlaintextReject &&
      this.rejectPlaintextBusiness(message, trustedE2E)
    ) {
      return false;
    }
    if (!appConnectionId) {
      this.logger.warn("rejected business message without app connection", {
        message_type: message.type,
      });
      return false;
    }
    if (!this.appConnections.hasAuthenticatedConnection(appConnectionId)) {
      this.logger.warn(
        "rejected business message before authenticated tracking",
        {
          app_connection_id: appConnectionId,
          message_type: message.type,
        },
      );
      return false;
    }
    this.appConnections.recordMessage(appConnectionId, "in", trustedE2E);
    return true;
  }

  private handleAuthVerify(message: MessageEnvelope<AuthVerifyPayload>): void {
    const keyRecord = this.requireKeyRecord();
    const authNonceKey = `${message.payload.key_id}:${message.payload.nonce}`;
    if (this.authReplayCache.has(authNonceKey)) {
      this.logger.warn("rejected replayed auth nonce", {
        key_id: message.payload.key_id,
      });
      this.send(
        createMessage(
          "auth.failed",
          {
            reason: "malformed_proof",
            connection_id: message.payload.connection_id,
            retry_after_ms: 2000,
          },
          { device_id: this.config.deviceId },
        ),
      );
      return;
    }

    const valid =
      message.payload.key_id === keyRecord.key_id &&
      verifyProof(
        keyRecord.key,
        message.payload.nonce,
        message.payload.app_info,
        message.payload.proof,
      );

    if (valid) {
      this.authReplayCache.remember(authNonceKey);
      if (message.payload.connection_id) {
        this.authenticatedAppConnectionIds.add(message.payload.connection_id);
        this.appConnections.acceptAuthenticatedConnection({
          relayConnectionId: message.payload.connection_id,
          keyId: keyRecord.key_id,
          appInfo: message.payload.app_info,
        });
      }
      this.send(
        createMessage(
          "auth.ok",
          {
            agent_instance_id: keyRecord.agent_instance_id,
            connection_id: message.payload.connection_id,
            business_security_mode: this.config.businessSecurityMode,
            e2e: this.e2eSupport(),
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

  private async handleTerminalStreamStart(
    message: MessageEnvelope<TerminalStreamStartPayload>,
    context?: AgentDispatchContext,
  ): Promise<void> {
    if (!message.session_id || !context) {
      return;
    }
    await this.terminalStreamPusher.start(
      message.session_id,
      context.appConnectionId,
    );
  }

  private async handleTerminalStreamStop(
    message: MessageEnvelope<TerminalStreamStopPayload>,
    context?: AgentDispatchContext,
  ): Promise<void> {
    if (!message.session_id) {
      return;
    }
    await this.terminalStreamPusher.stop(
      message.session_id,
      context?.appConnectionId,
    );
  }

  private async handleTerminalSnapshot(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
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

    const snapshotSeq = this.terminalFramePusher.nextSeq(session.session_id);

    this.sendToApp(
      context,
      createMessage("terminal.snapshot", snapshot, {
        device_id: this.config.deviceId,
        session_id: session.session_id,
        seq: snapshotSeq,
      }),
    );
    this.terminalFramePusher.rememberFrameData(
      session.session_id,
      snapshot.data,
    );
  }

  private async handleMissingTmuxTarget(
    sessionId: string,
    error: TmuxTargetMissingError,
  ): Promise<void> {
    this.terminalFramePusher.stop(sessionId);
    await this.terminalStreamPusher.stop(sessionId);
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
    await this.sessionRequests.handleList(
      createMessage(
        "session.list",
        {},
        {
          device_id: this.config.deviceId,
        },
      ),
    );
  }

  private async startAdminServer(): Promise<void> {
    if (!this.config.adminEnabled || this.adminServer) {
      return;
    }
    const server = new AgentAdminServer({
      host: this.config.adminHost,
      port: this.config.adminPort,
      token: this.config.adminToken,
      getStatus: () => ({
        agent: this.agentInfo(),
        runtime: {
          admin_enabled: this.config.adminEnabled,
          relay_configured: Boolean(this.config.relayUrl),
          relay_connected: this.relayStatus === "connected",
          relay_status: this.relayStatus,
          relay_reconnect_attempts: this.relayReconnectAttempts,
          relay_next_retry_at: this.relayNextRetryAt,
          relay_last_error: this.relayLastError,
          relay_last_close: this.relayLastClose,
          e2e_required: this.config.businessSecurityMode === "e2e_required",
        },
        connections_summary: this.appConnections.summary(),
      }),
      getConnections: () => ({
        agent: this.agentInfo(),
        summary: this.appConnections.summary(),
        connections: this.appConnections.list(),
      }),
    });
    await server.start();
    this.adminServer = server;
    this.logger.info("agent admin server started", {
      url: `http://${this.config.adminHost}:${this.config.adminPort}/`,
    });
  }

  private agentInfo(): {
    device_id: string;
    agent_instance_id: string;
    hostname: string;
    platform: "darwin";
    version: string;
    started_at: number;
    now: number;
  } {
    return {
      device_id: this.config.deviceId,
      agent_instance_id: this.agentInstanceId,
      hostname: this.config.hostname,
      platform: "darwin",
      version: this.config.agentVersion,
      started_at: this.agentStartedAt,
      now: Date.now(),
    };
  }

  private send(message: MessageEnvelope): void {
    if (!this.transport) {
      this.logger.warn("cannot send without transport", {
        message_type: message.type,
      });
      return;
    }

    if (isE2EBusinessMessage(message.type)) {
      this.broadcastToReadyApps(message);
      return;
    }

    this.transport.send(message);
  }

  private sendToApp(
    context: AgentDispatchContext | undefined,
    message: MessageEnvelope,
  ): void {
    if (!context) {
      this.logger.warn("dropped app-scoped message without context", {
        message_type: message.type,
      });
      return;
    }
    this.sendToAppByConnectionId(context.appConnectionId, message);
  }

  private sendToAppByConnectionId(
    appConnectionId: string,
    message: MessageEnvelope,
    channel?: P2pChannelKind,
  ): void {
    if (!this.transport) {
      this.logger.warn("cannot send without transport", {
        message_type: message.type,
      });
      return;
    }
    if (!this.appConnections.hasAuthenticatedConnection(appConnectionId)) {
      this.logger.warn(
        "dropped app-scoped message before authenticated tracking",
        {
          app_connection_id: appConnectionId,
          message_type: message.type,
        },
      );
      return;
    }
    const peer = this.e2ePeers.get(appConnectionId);
    if (this.config.businessSecurityMode === "plaintext_allowed") {
      this.appConnections.recordMessage(appConnectionId, "out", false);
      this.transport.send(
        {
          ...message,
          app_connection_id: appConnectionId,
        },
        channel,
      );
      return;
    }
    if (!peer?.ready) {
      this.logger.warn("dropped business message without ready app e2e peer", {
        app_connection_id: appConnectionId,
        message_type: message.type,
      });
      return;
    }
    const encrypted = peer.session.encrypt(messageToInner(message));
    this.appConnections.recordMessage(appConnectionId, "out", true);
    this.transport.send(
      createMessage("e2e.message", encrypted.payload, {
        device_id: this.config.deviceId,
      }),
      channel,
    );
  }

  private broadcastToReadyApps(message: MessageEnvelope): void {
    if (this.config.businessSecurityMode === "plaintext_allowed") {
      for (const appConnectionId of this.authenticatedAppConnectionIds) {
        this.sendToAppByConnectionId(appConnectionId, message);
      }
      return;
    }
    for (const peer of this.e2ePeers.values()) {
      if (peer.ready) {
        this.sendToAppByConnectionId(peer.appConnectionId, message);
      }
    }
  }

  private e2eSupport(): typeof E2E_SUPPORT_V1 {
    return {
      ...E2E_SUPPORT_V1,
      required: this.config.businessSecurityMode === "e2e_required",
    };
  }

  private requireKeyRecord(): SessionKeyRecord {
    if (!this.keyRecord) {
      throw new Error("Session key has not been generated");
    }

    return this.keyRecord;
  }
}

function appConnectionIdFromMessage(
  message: MessageEnvelope,
): string | undefined {
  const payload = message.payload as { app_connection_id?: unknown };
  return typeof payload.app_connection_id === "string"
    ? payload.app_connection_id
    : undefined;
}
