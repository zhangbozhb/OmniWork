import {
  createMessage,
  createMessageId,
} from "@omni-work/protocol-ts";
import type {
  AgentAppMessage,
  AgentInteractionPayload,
  AgentPromptSubmitPayload,
  AgentSurfaceEventPayload,
} from "@omni-work/protocol-ts";
import type { AgentConfig } from "../config/config.ts";
import {
  createAndPersistSessionKey,
  type SessionKeyRecord,
} from "../auth-key/authKey.ts";
import { TerminalProviderRegistry } from "../terminal-provider/terminalProviderRegistry.ts";
import { SQLiteSessionStore } from "../session-store/sessionStore.ts";
import { TerminalBridge } from "../pty-bridge/terminalBridge.ts";
import { TmuxManager } from "../tmux-manager/tmuxManager.ts";
import { Logger } from "../telemetry/logger.ts";
import { AgentSurfaceRunner } from "../agent-surface/agentSurfaceRunner.ts";
import { AgentSurfaceEventStore } from "../agent-surface/agentSurfaceEventStore.ts";
import { AgentInteractionStore } from "../agent-surface/agentInteractionStore.ts";
import { AgentInteractionService } from "../agent-surface/agentInteractionService.ts";
import { AgentPromptContextResolver } from "../agent-surface/agentPromptContextResolver.ts";
import {
  createPairingQrDetails,
  printPairingDetailsWithoutRelay,
  printPairingQr,
} from "../pairing/pairingQr.ts";
import { WorkspaceManager } from "../workspace/workspaceManager.ts";
import { GitService } from "../git/gitService.ts";
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
import { AgentInteractionHandler } from "./agentInteractionHandler.ts";
import { AgentSurfaceSyncHandler } from "./agentSurfaceSyncHandler.ts";
import { AgentMessageDispatcher } from "./agentMessageDispatcher.ts";
import { AgentProbeRuntime } from "./agentProbeRuntime.ts";
import { AgentRelayController } from "./agentRelayController.ts";
import { AgentTunnelUpgradeHandler } from "./agentTunnelUpgradeHandler.ts";
import { TerminalRequestHandler } from "./terminalRequestHandler.ts";
import type {
  AgentInfo,
  AgentRelayRuntimeStatus,
} from "./agentRuntimeTypes.ts";

export interface AgentServiceOptions {
  onShutdownRequested?(reason: string): void;
}

export class AgentService {
  private readonly logger = new Logger("omniwork-agent");
  private readonly tmux = new TmuxManager();
  private readonly terminalProviders: TerminalProviderRegistry;
  private readonly workspaces: WorkspaceManager;
  private readonly git = new GitService();
  private readonly sessionManager: SessionManager;
  private readonly resourceRequests: ResourceRequestHandler;
  private readonly sessionRequests: SessionRequestHandler;
  private readonly terminalFramePusher: TerminalFramePusher;
  private readonly terminalStreamPusher: TerminalStreamPusher;
  private readonly terminalBridge: TerminalBridge;
  private readonly appConnections: AppConnectionRegistry;
  private readonly agentMessages: AgentMessageService;
  private readonly surfaceEvents: AgentSurfaceEventStore;
  private readonly interactions: AgentInteractionService;
  private readonly promptContext: AgentPromptContextResolver;
  private readonly security: AgentAppSecurityGateway;
  private readonly tunnelUpgrade: AgentTunnelUpgradeHandler;
  private readonly terminalRequests: TerminalRequestHandler;
  private readonly inbox: AgentInboxHandler;
  private readonly interactionHandler: AgentInteractionHandler;
  private readonly surfaceSync: AgentSurfaceSyncHandler;
  private readonly probeRuntime: AgentProbeRuntime;
  private readonly agentSurfaceRunner: AgentSurfaceRunner;
  private readonly adminRuntime: AgentAdminRuntime;
  private readonly dispatcher: AgentMessageDispatcher;
  private readonly relayController: AgentRelayController;
  private readonly config: AgentConfig;
  private keyRecord: SessionKeyRecord | null = null;
  private agentStartedAt = Date.now();
  private readonly logTransport =
    (process.env.OMNIWORK_LOG_TRANSPORT ?? "") === "1";
  private readonly onShutdownRequested?: (reason: string) => void;

  constructor(config: AgentConfig, options: AgentServiceOptions = {}) {
    this.config = config;
    this.onShutdownRequested = options.onShutdownRequested;
    this.surfaceEvents = new AgentSurfaceEventStore(config.sessionStorePath);
    this.interactions = new AgentInteractionService({
      store: new AgentInteractionStore(config.sessionStorePath),
      onRequest: (request) => {
        this.broadcastAgentInteraction(request);
        this.agentMessages.publishInteractionRequest(request);
      },
      onResult: (result) => this.broadcastAgentInteraction(result),
    });
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
    this.promptContext = new AgentPromptContextResolver({
      getSession: (sessionId) => this.sessionManager.get(sessionId),
      getWorkspace: (path) => this.workspaces.get(path),
    });
    this.terminalBridge = new TerminalBridge(this.tmux);

    this.probeRuntime = new AgentProbeRuntime({
      config,
      logger: this.logger,
      agentMessages: this.agentMessages,
      sessionManager: this.sessionManager,
      getKeyRecord: () => this.requireKeyRecord(),
      onSurfaceEvent: (event) => this.broadcastAgentSurfaceEvent(event),
    });
    this.agentSurfaceRunner = new AgentSurfaceRunner({
      logger: this.logger,
      getSession: (sessionId) => this.sessionManager.get(sessionId),
      onSurfaceEvent: (event) => this.broadcastAgentSurfaceEvent(event),
      requestInteraction: (request) => this.interactions.request(request),
    });
    this.security = new AgentAppSecurityGateway({
      config,
      logger: this.logger,
      appConnections: this.appConnections,
      getTransport: () => this.relayController.getTransport(),
      getKeyRecord: () => this.requireKeyRecord(),
      getAgentConnectionId: () => this.relayController.getAgentConnectionId(),
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
      git: this.git,
      listWorkspaces: async () =>
        (await this.sessionManager.listWithWorkspaces()).workspaces,
      sendToApp: (context, message) =>
        this.security.sendToApp(context, message),
    });
    this.terminalFramePusher = new TerminalFramePusher({
      deviceId: config.deviceId,
      logTransport: this.logTransport,
      logger: this.logger,
      sessionManager: this.sessionManager,
      terminalBridge: this.terminalBridge,
      getBufferedAmountForApp: (appConnectionId) =>
        this.relayController
          .getTransport()
          ?.getBufferedAmountForApp(appConnectionId) ?? 0,
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
      sendToApp: (context, message) =>
        this.security.sendToApp(context, message),
      publishLocalProbeEvent: (event) =>
        this.probeRuntime.publishLocalProbeEvent(event),
    });
    this.sessionRequests = new SessionRequestHandler({
      deviceId: config.deviceId,
      defaultCwd: config.defaultCwd,
      terminalProviders: this.terminalProviders,
      workspaces: this.workspaces,
      git: this.git,
      sessionManager: this.sessionManager,
      terminalFramePusher: this.terminalFramePusher,
      sendToApp: (context, message) =>
        this.security.sendToApp(context, message),
      prepareTerminalProvider: (terminalProvider) =>
        this.probeRuntime.prepareTerminalProvider(terminalProvider),
      closeAgentSurfaceSession: (sessionId) => {
        this.interactions.cancelSession(sessionId);
        this.agentSurfaceRunner.closeSession(sessionId);
      },
      handleTerminalSnapshot: (message, context) =>
        this.terminalRequests.handleSnapshot(message, context),
    });
    this.inbox = new AgentInboxHandler({
      deviceId: config.deviceId,
      logger: this.logger,
      agentMessages: this.agentMessages,
      sendToApp: (context, message) =>
        this.security.sendToApp(context, message),
    });
    this.interactionHandler = new AgentInteractionHandler({
      deviceId: config.deviceId,
      interactions: this.interactions,
      sendToApp: (context, message) =>
        this.security.sendToApp(context, message),
    });
    this.surfaceSync = new AgentSurfaceSyncHandler({
      deviceId: config.deviceId,
      store: this.surfaceEvents,
      sendToApp: (context, message) =>
        this.security.sendToApp(context, message),
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
      interactions: this.interactionHandler,
      surfaceSync: this.surfaceSync,
      publishAgentSurfaceEvent: (event) =>
        this.broadcastAgentSurfaceEvent(event),
      submitAgentPrompt: (payload) => this.submitAgentPrompt(payload),
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
      onRelayShutdownRequested: (reason) => {
        this.logger.error("stopping agent after relay shutdown request", {
          reason,
        });
        this.stop();
        this.onShutdownRequested?.(reason);
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
      this.agentStartedAt = Date.now();
      this.keyRecord = await createAndPersistSessionKey({
        path: this.config.sessionKeyPath,
        relayUrl: this.config.relayUrl,
      });

      this.logger.info("generated temporary session key", {
        key_path: this.config.sessionKeyPath,
      });
      const pairingQr = createPairingQrDetails(this.config, this.keyRecord);
      if (pairingQr) {
        printPairingQr(pairingQr);
      } else {
        printPairingDetailsWithoutRelay(this.config, this.keyRecord);
      }

      for (const terminalProvider of this.terminalProviders.providers()) {
        await this.probeRuntime.prepareTerminalProvider({
          kind: terminalProvider.kind,
          command: terminalProvider.defaultCommand,
        });
      }

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
    this.agentSurfaceRunner.close();
  }

  private relayStatus(): AgentRelayRuntimeStatus {
    return this.relayController.statusSnapshot();
  }

  private agentInfo(): AgentInfo {
    return {
      device_id: this.config.deviceId,
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

  private broadcastAgentSurfaceEvent(event: AgentSurfaceEventPayload): void {
    this.surfaceEvents.put(event);
    this.security.send(
      createMessage("agent.surface.event", event, {
        device_id: this.config.deviceId,
        session_id: event.session_id,
        surface_id: event.surface_id,
      }),
    );
  }

  private broadcastAgentInteraction(payload: AgentInteractionPayload): void {
    this.security.send(
      createMessage("agent.interaction", payload, {
        device_id: this.config.deviceId,
        session_id:
          "session_id" in payload ? payload.session_id : undefined,
        surface_id:
          "surface_id" in payload ? payload.surface_id : undefined,
      }),
    );
  }

  private submitAgentPrompt(payload: AgentPromptSubmitPayload): void {
    void this.promptContext
      .resolve(payload)
      .then((prompt) => {
        this.agentSurfaceRunner.submitPrompt({
          sessionId: payload.session_id,
          surfaceId: payload.surface_id,
          prompt,
        });
      })
      .catch((error: unknown) => {
        this.broadcastAgentSurfaceEvent({
          session_id: payload.session_id,
          surface_id: payload.surface_id,
          provider: "omniwork",
          event_id: createMessageId(),
          event_type: "agent.failed",
          title: "Prompt context failed",
          summary:
            error instanceof Error
              ? error.message
              : "Prompt context could not be resolved.",
          payload: {
            context_file_count: payload.context_files?.length ?? 0,
          },
          source: { kind: "process" },
          created_at: new Date().toISOString(),
        });
      });
  }

  private requireKeyRecord(): SessionKeyRecord {
    if (!this.keyRecord) {
      throw new Error("Session key has not been generated");
    }
    return this.keyRecord;
  }
}
