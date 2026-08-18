import {
  createMessage,
  type AgentDeliveryOutcomeSetPayload,
  type AgentDeliveryPayload,
  type AgentDeliverySyncRequestPayload,
  type MessageEnvelope,
} from "@omni-work/protocol-ts";

import type { DeliveryEpisodeStore } from "../learning/deliveryEpisodeStore.ts";
import type {
  ExperienceCandidateChange,
  ExperienceCandidateStore,
} from "../learning/experienceCandidateStore.ts";
import type {
  ExperienceEvaluationResult,
  ExperienceEvaluationStore,
} from "../learning/experienceEvaluationStore.ts";
import type { AgentDispatchContext } from "./agentRuntimeTypes.ts";

interface AgentDeliveryHandlerOptions {
  deviceId: string;
  store: DeliveryEpisodeStore;
  candidateStore: ExperienceCandidateStore;
  evaluationStore: ExperienceEvaluationStore;
  onExperienceChange(change: ExperienceCandidateChange): void;
  onEvaluation(result: ExperienceEvaluationResult): void;
  sendToApp(
    context: AgentDispatchContext | undefined,
    message: MessageEnvelope,
  ): void;
}

export class AgentDeliveryHandler {
  private readonly deviceId: string;
  private readonly store: DeliveryEpisodeStore;
  private readonly candidateStore: ExperienceCandidateStore;
  private readonly evaluationStore: ExperienceEvaluationStore;
  private readonly onExperienceChange: (
    change: ExperienceCandidateChange,
  ) => void;
  private readonly onEvaluation: (
    result: ExperienceEvaluationResult,
  ) => void;
  private readonly sendToApp: AgentDeliveryHandlerOptions["sendToApp"];

  constructor(options: AgentDeliveryHandlerOptions) {
    this.deviceId = options.deviceId;
    this.store = options.store;
    this.candidateStore = options.candidateStore;
    this.evaluationStore = options.evaluationStore;
    this.onExperienceChange = options.onExperienceChange;
    this.onEvaluation = options.onEvaluation;
    this.sendToApp = options.sendToApp;
  }

  handle(
    message: MessageEnvelope<AgentDeliveryPayload>,
    context?: AgentDispatchContext,
  ): void {
    if (message.payload.kind === "sync_request") {
      this.handleSync(message.id, message.payload, context);
      return;
    }
    if (message.payload.kind === "outcome_set") {
      this.handleOutcome(message.id, message.payload, context);
    }
  }

  private handleSync(
    requestId: string,
    payload: AgentDeliverySyncRequestPayload,
    context?: AgentDispatchContext,
  ): void {
    this.sendToApp(
      context,
      createMessage(
        "agent.delivery",
        {
          kind: "sync_response",
          request_id: requestId,
          episodes: this.store
            .list({
              sessionId: payload.session_id,
              surfaceId: payload.surface_id,
              limit: payload.limit,
            })
            .map((episode) => this.store.toSummary(episode)),
        },
        {
          device_id: this.deviceId,
          session_id: payload.session_id,
          surface_id: payload.surface_id,
        },
      ),
    );
  }

  private handleOutcome(
    requestId: string,
    payload: AgentDeliveryOutcomeSetPayload,
    context?: AgentDispatchContext,
  ): void {
    const result = this.store.setOutcome(payload);
    if (result.result === "applied" || result.result === "duplicate") {
      for (const change of this.candidateStore.reconcileEpisode(
        result.episode,
      )) {
        this.onExperienceChange(change);
      }
      if (result.episode.outcome && result.episode.outcomeAt) {
        const evaluation = this.evaluationStore.evaluateEpisode({
          episodeId: result.episode.episodeId,
          outcome: result.episode.outcome,
          outcomeAt: result.episode.outcomeAt,
          sourceActionId: payload.client_action_id,
        });
        if (evaluation) {
          this.onEvaluation(evaluation);
        }
      }
      this.sendToApp(
        context,
        createMessage(
          "agent.delivery",
          {
            kind: "outcome_result",
            request_id: requestId,
            client_action_id: payload.client_action_id,
            episode: this.store.toSummary(result.episode),
          },
          {
            device_id: this.deviceId,
            session_id: payload.session_id,
            surface_id: payload.surface_id,
          },
        ),
      );
      return;
    }

    const message =
      result.result === "not_found"
        ? "The delivery episode was not found for this session and surface."
        : result.result === "invalid_state"
          ? "Only delivered episodes can receive user outcomes."
          : "The action identifier was already used with different content.";
    this.sendToApp(
      context,
      createMessage(
        "agent.delivery",
        {
          kind: "error",
          request_id: requestId,
          client_action_id: payload.client_action_id,
          episode_id: payload.episode_id,
          code: result.result,
          message,
        },
        { device_id: this.deviceId },
      ),
    );
  }
}
