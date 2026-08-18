import { createMessage, createMessageId } from "@omni-work/protocol-ts";
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
import { AgentObservationStore } from "../learning/agentObservationStore.ts";
import {
  DeliveryEpisodeStore,
  type DeliveryEpisode,
} from "../learning/deliveryEpisodeStore.ts";
import {
  ExperienceCandidateStore,
  type ExperienceCandidateChange,
} from "../learning/experienceCandidateStore.ts";
import { ExperienceShadowStore } from "../learning/experienceShadowStore.ts";
import { ExperienceActivationStore } from "../learning/experienceActivationStore.ts";
import {
  ExperienceEvaluationStore,
  type ExperienceEvaluationResult,
} from "../learning/experienceEvaluationStore.ts";
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
import { AgentDeliveryHandler } from "./agentDeliveryHandler.ts";
import { AgentExperienceHandler } from "./agentExperienceHandler.ts";
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
  private readonly observations: AgentObservationStore;
  private readonly episodes: DeliveryEpisodeStore;
  private readonly experienceCandidates: ExperienceCandidateStore;
  private readonly experienceShadow: ExperienceShadowStore;
  private readonly experienceActivation: ExperienceActivationStore;
  private readonly experienceEvaluation: ExperienceEvaluationStore;
  private readonly interactions: AgentInteractionService;
  private readonly promptContext: AgentPromptContextResolver;
  private readonly security: AgentAppSecurityGateway;
  private readonly tunnelUpgrade: AgentTunnelUpgradeHandler;
  private readonly terminalRequests: TerminalRequestHandler;
  private readonly inbox: AgentInboxHandler;
  private readonly deliveryHandler: AgentDeliveryHandler;
  private readonly experienceHandler: AgentExperienceHandler;
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
    this.observations = new AgentObservationStore(config.sessionStorePath);
    this.episodes = new DeliveryEpisodeStore(config.sessionStorePath);
    this.experienceCandidates = new ExperienceCandidateStore(
      config.sessionStorePath,
    );
    this.experienceShadow = new ExperienceShadowStore(
      config.sessionStorePath,
      this.experienceCandidates,
    );
    this.experienceActivation = new ExperienceActivationStore(
      config.sessionStorePath,
      this.experienceShadow,
      this.experienceCandidates,
    );
    this.experienceEvaluation = new ExperienceEvaluationStore(
      config.sessionStorePath,
      this.experienceCandidates,
    );
    for (const episode of this.episodes.listWithOutcomes()) {
      this.experienceCandidates.reconcileEpisode(episode);
    }
    this.experienceEvaluation.backfill();
    this.experienceCandidates.applyStaleness(new Date().toISOString());
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
      getSession: async (sessionId) =>
        this.sessionManager.getKnown(sessionId) ??
        (await this.sessionManager.get(sessionId)),
      getWorkspace: (path) => this.workspaces.get(path),
    });
    this.terminalBridge = new TerminalBridge(this.tmux);

    this.probeRuntime = new AgentProbeRuntime({
      config,
      logger: this.logger,
      agentMessages: this.agentMessages,
      sessionManager: this.sessionManager,
      getKeyRecord: () => this.requireKeyRecord(),
      onObservation: (event) =>
        this.applyLearningObservation(this.observations.putProbeEvent(event)),
      onSurfaceEvent: (event) => this.broadcastAgentSurfaceEvent(event),
    });
    this.agentSurfaceRunner = new AgentSurfaceRunner({
      logger: this.logger,
      getSession: async (sessionId) =>
        this.sessionManager.getKnown(sessionId) ??
        (await this.sessionManager.get(sessionId)),
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
    this.deliveryHandler = new AgentDeliveryHandler({
      deviceId: config.deviceId,
      store: this.episodes,
      candidateStore: this.experienceCandidates,
      evaluationStore: this.experienceEvaluation,
      onExperienceChange: (change) => this.publishExperienceChange(change),
      onEvaluation: (result) => this.publishEvaluation(result),
      sendToApp: (context, message) =>
        this.security.sendToApp(context, message),
    });
    this.experienceHandler = new AgentExperienceHandler({
      deviceId: config.deviceId,
      store: this.experienceCandidates,
      shadowStore: this.experienceShadow,
      activationStore: this.experienceActivation,
      evaluationStore: this.experienceEvaluation,
      onExperienceChange: (change) => this.publishExperienceChange(change),
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
      delivery: this.deliveryHandler,
      experience: this.experienceHandler,
      interactions: this.interactionHandler,
      surfaceSync: this.surfaceSync,
      publishAgentSurfaceEvent: (event) =>
        this.broadcastAgentSurfaceEvent(event),
      prepareAgentPrompt: (payload) => this.prepareExperiencePrompt(payload),
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
        key: this.config.sessionKey,
        relayUrl: this.config.relayUrl,
      });

      this.logger.info(
        this.config.sessionKey
          ? "persisted configured session key"
          : "generated temporary session key",
        {
          key_path: this.config.sessionKeyPath,
        },
      );
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
      if (tmuxAvailable) {
        await this.sessionManager.listWithWorkspaces();
      }
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
    const session = this.sessionManager.getKnown(event.session_id);
    const observation = this.observations.putSurfaceEvent(
      event,
      session?.workspace_path ?? session?.cwd,
    );
    this.applyLearningObservation(observation);
    this.security.send(
      createMessage("agent.surface.event", event, {
        device_id: this.config.deviceId,
        session_id: event.session_id,
        surface_id: event.surface_id,
      }),
    );
  }

  private publishEpisodeUpdate(episode: DeliveryEpisode | undefined): void {
    if (!episode || episode.status === "working") {
      return;
    }
    this.security.send(
      createMessage(
        "agent.delivery",
        {
          kind: "episode_updated",
          episode: this.episodes.toSummary(episode),
        },
        {
          device_id: this.config.deviceId,
          session_id: episode.sessionId,
          surface_id: episode.surfaceId,
        },
      ),
    );
  }

  private applyLearningObservation(
    observation: ReturnType<AgentObservationStore["putSurfaceEvent"]>,
  ): void {
    const revised = this.episodes.recordGitReviewRevision(observation);
    if (revised) {
      this.publishEpisodeUpdate(revised);
      if (
        revised.outcomeSource === "git_review" &&
        revised.outcome &&
        revised.outcomeAt
      ) {
        const evaluation = this.experienceEvaluation.evaluateEpisode({
          episodeId: revised.episodeId,
          outcome: revised.outcome,
          outcomeAt: revised.outcomeAt,
          sourceActionId: `inferred:git_review:${observation.observationKey}`,
        });
        if (evaluation) {
          this.publishEvaluation(evaluation);
        }
      }
    }
    this.publishEpisodeUpdate(this.episodes.apply(observation));
  }

  private publishExperienceChange(change: ExperienceCandidateChange): void {
    const payload =
      change.kind === "updated"
        ? {
            kind: "candidate_updated" as const,
            candidate: change.candidate,
          }
        : {
            kind: "candidate_removed" as const,
            candidate_id: change.candidateId,
            project_id: change.projectId,
          };
    this.security.send(
      createMessage("agent.experience", payload, {
        device_id: this.config.deviceId,
      }),
    );
  }

  private publishEvaluation(result: ExperienceEvaluationResult): void {
    for (const change of result.candidateChanges) {
      this.publishExperienceChange(change);
    }
    this.security.send(
      createMessage(
        "agent.experience",
        {
          kind: "evaluation_recorded",
          evaluation: result.evaluation,
          effect: result.effect,
        },
        {
          device_id: this.config.deviceId,
        },
      ),
    );
  }

  private prepareExperiencePrompt(
    payload: AgentPromptSubmitPayload,
  ): AgentPromptSubmitPayload {
    const episode = this.episodes.findWorkingForSurface(
      payload.session_id,
      payload.surface_id,
    );
    if (!episode?.projectId || !episode.objective) {
      return payload;
    }
    const evaluation = this.experienceShadow.evaluate({
      episodeId: episode.episodeId,
      projectId: episode.projectId,
      sessionId: episode.sessionId,
      surfaceId: episode.surfaceId,
      prompt: episode.objective,
      createdAt: episode.startedAt,
    });
    for (const candidate of evaluation.updatedCandidates) {
      this.publishExperienceChange({ kind: "updated", candidate });
    }
    this.security.send(
      createMessage(
        "agent.experience",
        {
          kind: "shadow_result",
          run: evaluation.run,
        },
        {
          device_id: this.config.deviceId,
          session_id: episode.sessionId,
          surface_id: episode.surfaceId,
        },
      ),
    );
    const prepared = this.experienceActivation.prepareApplication({
      run: evaluation.run,
      prompt: payload.prompt,
      createdAt: episode.startedAt,
    });
    for (const candidateId of prepared.updatedCandidateIds) {
      const candidate = this.experienceCandidates.get(candidateId);
      if (candidate) {
        this.publishExperienceChange({ kind: "updated", candidate });
      }
    }
    if (prepared.application) {
      this.security.send(
        createMessage(
          "agent.experience",
          {
            kind: "application_recorded",
            application: prepared.application,
          },
          {
            device_id: this.config.deviceId,
            session_id: episode.sessionId,
            surface_id: episode.surfaceId,
          },
        ),
      );
    }
    return prepared.prompt === payload.prompt
      ? payload
      : { ...payload, prompt: prepared.prompt };
  }

  private broadcastAgentInteraction(payload: AgentInteractionPayload): void {
    this.security.send(
      createMessage("agent.interaction", payload, {
        device_id: this.config.deviceId,
        session_id: "session_id" in payload ? payload.session_id : undefined,
        surface_id: "surface_id" in payload ? payload.surface_id : undefined,
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
