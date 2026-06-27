import type { AgentAppMessage, MessageEnvelope } from "@omniwork/protocol-ts";
import type { AgentConfig } from "../config/config.ts";
import {
  createAgentInstanceId,
  createAndPersistSessionKey,
  type SessionKeyRecord,
} from "../auth-key/authKey.ts";
import { TerminalProviderRegistry } from "../terminal-provider/terminalProviderRegistry.ts";
import { SQLiteSessionStore } from "../session-store/sessionStore.ts";
import { TerminalBridge } from "../pty-bridge/terminalBridge.ts";
import { TmuxManager } from "../tmux-manager/tmuxManager.ts";
import { Logger } from "../telemetry/logger.ts";
import {
  createPairingQrDetails,
  printPairingDetailsWithoutRelay,
  printPairingQr,
} from "../pairing/pairingQr.ts";
import { WorkspaceManager } from "../workspace/workspaceManager.ts";
import { ResourceRequestHandler } from "./resourceRequestHandler.ts";
import { SessionManager } from "./sessionManager.ts";
import { SessionRequestHandler } from "./sessionRequestHandler.ts";
import { TerminalFramePusher } from "./terminalFramePusher.ts";
import { TerminalStreamPusher } from "./terminalStreamPusher.ts";
import { AppConnectionRegistry } from "./appConnectionRegistry.ts";
import { AgentMessageService } from "../probes/agentMessageService.ts";
import { AgentMessageStore } from "../probes/agentMessageStore.ts";
import { AgentAdminRuntime } from "./agentAdminRuntime.ts";
import { AgentAppSecurityGateway } from "./agentAppSecurityGateway.ts";
import { AgentInboxHandler } from "./agentInboxHandler.ts";
import { AgentMessageDispatcher } from "./agentMessageDispatcher.ts";
import { AgentProbeRuntime } from "./agentProbeRuntime.ts";
import { AgentRelayController } from "./agentRelayController.ts";
import { AgentTunnelUpgradeHandler } from "./agentTunnelUpgradeHandler.ts";
import { TerminalRequestHandler } from "./terminalRequestHandler.ts";
import type {
  AgentInfo,
  AgentRelayRuntimeStatus,
} from "./agentRuntimeTypes.ts";

export class AgentService {
  private readonly logger = new Logger("omniwork-agent");
  private readonly tmux = new TmuxManager();
  private readonly terminalProviders: TerminalProviderRegistry;
  private readonly workspaces: WorkspaceManager;
  private readonly sessionManager: SessionManager;
  private readonly resourceRequests: ResourceRequestHandler;
  private readonly sessionRequests: SessionRequestHandler;
  private readonly terminalFramePusher: TerminalFramePusher;
  private readonly terminalStreamPusher: TerminalStreamPusher;
  private readonly terminalBridge: TerminalBridge;
  private readonly appConnections: AppConnectionRegistry;
  private readonly agentMessages: AgentMessageService;
  private readonly security: AgentAppSecurityGateway;
  private readonly tunnelUpgrade: AgentTunnelUpgradeHandler;
  private readonly terminalRequests: TerminalRequestHandler;
  private readonly inbox: AgentInboxHandler;
  private readonly probeRuntime: AgentProbeRuntime;
  private readonly adminRuntime: AgentAdminRuntime;
  private readonly dispatcher: AgentMessageDispatcher;
  private readonly relayController: AgentRelayController;
  private readonly config: AgentConfig;
  private keyRecord: SessionKeyRecord | null = null;
  private agentStartedAt = Date.now();
  private agentInstanceId = "";
  private readonly logTransport =
    (process.env.OMNIWORK_LOG_TRANSPORT ?? "") === "1";

  constructor(config: AgentConfig) {
    this.config = config;
    this.agentMessages = new AgentMessageService({
      store: new AgentMessageStore(config.sessionStorePath),
      onMessage: (message) => this.broadcastAgentMessage(message),
      onNotification: (notification) => {
        this.logger.info("agent notification candidate ready", {
          message_id: notification.message_id,
          priority: notification.priority,
          action: notification.action,
        });
      },
    });
    this.appConnections = new AppConnectionRegistry({
      heartbeatIntervalMs: config.connectionHeartbeatMs,
      staleTimeoutMs: config.connectionStaleMs,
      disconnectTimeoutMs: config.connectionDisconnectMs,
    });
    this.terminalProviders = new TerminalProviderRegistry({
      providers: config.terminalProviders,
    });
    this.workspaces = new WorkspaceManager({
      defaultCwd: config.defaultCwd,
    });
    this.sessionManager = new SessionManager(
      new SQLiteSessionStore(config.sessionStorePath),
      this.tmux,
      this.terminalProviders,
      this.workspaces,
      {
        cwd: config.defaultCwd,
        terminalSize: config.terminalSize,
      },
    );
    this.terminalBridge = new TerminalBridge(this.tmux);

    this.probeRuntime = new AgentProbeRuntime({
      config,
      logger: this.logger,
      agentMessages: this.agentMessages,
      sessionManager: this.sessionManager,
      getKeyRecord: () => this.requireKeyRecord(),
    });
    this.security = new AgentAppSecurityGateway({
      config,
      logger: this.logger,
      appConnections: this.appConnections,
      getTransport: () => this.relayController.getTransport(),
      getKeyRecord: () => this.requireKeyRecord(),
      dispatchMessage: (message, context) =>
        this.dispatcher.dispatch(message, context),
      onSupersededConnection: (appConnectionId) =>
        this.tunnelUpgrade.detachConnection(appConnectionId),
    });
    this.tunnelUpgrade = new AgentTunnelUpgradeHandler({
      config,
      logger: this.logger,
      appConnections: this.appConnections,
      getTransport: () => this.relayController.getTransport(),
      sendToAppByConnectionId: (appConnectionId, message, channel, options) =>
        this.security.sendToAppByConnectionId(
          appConnectionId,
          message,
          channel,
          options,
        ),
    });
    this.resourceRequests = new ResourceRequestHandler({
      deviceId: config.deviceId,
      workspaces: this.workspaces,
      listWorkspaces: async () =>
        (await this.sessionManager.listWithWorkspaces()).workspaces,
      sendToApp: (context, message) => this.security.sendToApp(context, message),
    });
    this.terminalFramePusher = new TerminalFramePusher({
      deviceId: config.deviceId,
      logTransport: this.logTransport,
      logger: this.logger,
      sessionManager: this.sessionManager,
      terminalBridge: this.terminalBridge,
      getBufferedAmountForApp: (appConnectionId) =>
        this.relayController.getTransport()?.getBufferedAmountForApp(
          appConnectionId,
        ) ?? 0,
      emitDisplayFrameDeferred: (appConnectionId, bufferedAmount) =>
        this.relayController
          .getTransport()
          ?.emitDisplayFrameDeferred(appConnectionId, bufferedAmount),
      sendToAppByConnectionId: (appConnectionId, message, channel) =>
        this.security.sendToAppByConnectionId(
          appConnectionId,
          message,
          channel,
        ),
      onMissingTmuxTarget: (sessionId, error) =>
        this.terminalRequests.handleMissingTmuxTarget(sessionId, error),
    });
    this.terminalStreamPusher = new TerminalStreamPusher({
      deviceId: config.deviceId,
      enabled: config.terminalStreamEnabled,
      logger: this.logger,
      sessionManager: this.sessionManager,
      tmux: this.tmux,
      sendToAppByConnectionId: (appConnectionId, message, channel) =>
        this.security.sendToAppByConnectionId(
          appConnectionId,
          message,
          channel,
        ),
      onMissingTmuxTarget: (sessionId, error) =>
        this.terminalRequests.handleMissingTmuxTarget(sessionId, error),
    });
    this.terminalRequests = new TerminalRequestHandler({
      deviceId: config.deviceId,
      logger: this.logger,
      terminalBridge: this.terminalBridge,
      sessionManager: this.sessionManager,
      terminalFramePusher: this.terminalFramePusher,
      terminalStreamPusher: this.terminalStreamPusher,
      getSessionRequests: () => this.sessionRequests,
      send: (message) => this.security.send(message),
      sendToApp: (context, message) => this.security.sendToApp(context, message),
      publishLocalProbeEvent: (event) =>
        this.probeRuntime.publishLocalProbeEvent(event),
    });
    this.sessionRequests = new SessionRequestHandler({
      deviceId: config.deviceId,
      defaultCwd: config.defaultCwd,
      terminalProviders: this.terminalProviders,
      workspaces: this.workspaces,
      sessionManager: this.sessionManager,
      terminalFramePusher: this.terminalFramePusher,
      sendToApp: (context, message) => this.security.sendToApp(context, message),
      prepareTerminalProvider: (terminalProvider) =>
        this.probeRuntime.prepareTerminalProvider(terminalProvider),
      handleTerminalSnapshot: (message, context) =>
        this.terminalRequests.handleSnapshot(message, context),
    });
    this.inbox = new AgentInboxHandler({
      deviceId: config.deviceId,
      logger: this.logger,
      agentMessages: this.agentMessages,
      sendToApp: (context, message) => this.security.sendToApp(context, message),
    });
    this.dispatcher = new AgentMessageDispatcher({
      config,
      logger: this.logger,
      security: this.security,
      tunnelUpgrade: this.tunnelUpgrade,
      sessionRequests: this.sessionRequests,
      resourceRequests: this.resourceRequests,
      terminalRequests: this.terminalRequests,
      terminalStreamPusher: this.terminalStreamPusher,
      inbox: this.inbox,
    });
    this.relayController = new AgentRelayController({
      config,
      logger: this.logger,
      logTransport: this.logTransport,
      terminalProviders: this.terminalProviders,
      workspaces: this.workspaces,
      terminalStreamPusher: this.terminalStreamPusher,
      getKeyRecord: () => this.requireKeyRecord(),
      e2eSupport: () => this.security.e2eSupport(),
      onMessage: (message) => this.dispatcher.dispatch(message),
      onRelayUnavailable: () => {
        this.security.clearRelayAppConnectionState();
        this.tunnelUpgrade.clear();
      },
    });
    this.adminRuntime = new AgentAdminRuntime({
      config,
      logger: this.logger,
      appConnections: this.appConnections,
      getAgentInfo: () => this.agentInfo(),
      getRelayStatus: () => this.relayStatus(),
    });
  }

  async start(): Promise<void> {
    try {
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

      await this.probeRuntime.prepareTerminalProvider({
        kind: "codex",
        command: process.env.OMNIWORK_CODEX_COMMAND ?? "codex",
      });
      await this.probeRuntime.prepareTerminalProvider({
        kind: "claude",
        command:
          process.env.OMNIWORK_CLAUDE_COMMAND ??
          process.env.OMNIWORK_CLAUDECODE_COMMAND ??
          "claude",
      });

      const tmuxAvailable = await this.tmux.isAvailable();
      if (!tmuxAvailable) {
        this.logger.warn(
          "tmux is not available; session creation will fail until tmux is installed",
        );
      }

      await this.sessionManager.applyStartupPatches();
      await this.adminRuntime.start();
      await this.probeRuntime.start();
      this.relayController.start();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.relayController.stop();
    this.adminRuntime.close();
    this.probeRuntime.close();
  }

  private relayStatus(): AgentRelayRuntimeStatus {
    return this.relayController.statusSnapshot();
  }

  private agentInfo(): AgentInfo {
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

  private broadcastAgentMessage(message: AgentAppMessage): void {
    this.security.broadcastAgentMessage(message);
  }

  private requireKeyRecord(): SessionKeyRecord {
    if (!this.keyRecord) {
      throw new Error("Session key has not been generated");
    }
    return this.keyRecord;
  }
}
