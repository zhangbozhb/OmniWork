import {
  createMessage,
  type AgentExperienceActivationSetPayload,
  type AgentExperienceLifecycleSetPayload,
  type AgentExperiencePayload,
  type AgentExperienceReviewSetPayload,
  type AgentExperienceShadowFeedbackSetPayload,
  type AgentExperienceSyncRequestPayload,
  type MessageEnvelope,
} from "@omni-work/protocol-ts";

import type {
  ExperienceCandidateChange,
  ExperienceCandidateStore,
} from "../learning/experienceCandidateStore.ts";
import type { ExperienceShadowStore } from "../learning/experienceShadowStore.ts";
import type { ExperienceActivationStore } from "../learning/experienceActivationStore.ts";
import type { ExperienceEvaluationStore } from "../learning/experienceEvaluationStore.ts";
import type { AgentDispatchContext } from "./agentRuntimeTypes.ts";

interface AgentExperienceHandlerOptions {
  deviceId: string;
  store: ExperienceCandidateStore;
  shadowStore: ExperienceShadowStore;
  activationStore: ExperienceActivationStore;
  evaluationStore: ExperienceEvaluationStore;
  onExperienceChange(change: ExperienceCandidateChange): void;
  sendToApp(
    context: AgentDispatchContext | undefined,
    message: MessageEnvelope,
  ): void;
}

export class AgentExperienceHandler {
  private readonly deviceId: string;
  private readonly store: ExperienceCandidateStore;
  private readonly shadowStore: ExperienceShadowStore;
  private readonly activationStore: ExperienceActivationStore;
  private readonly evaluationStore: ExperienceEvaluationStore;
  private readonly onExperienceChange: (
    change: ExperienceCandidateChange,
  ) => void;
  private readonly sendToApp: AgentExperienceHandlerOptions["sendToApp"];

  constructor(options: AgentExperienceHandlerOptions) {
    this.deviceId = options.deviceId;
    this.store = options.store;
    this.shadowStore = options.shadowStore;
    this.activationStore = options.activationStore;
    this.evaluationStore = options.evaluationStore;
    this.onExperienceChange = options.onExperienceChange;
    this.sendToApp = options.sendToApp;
  }

  handle(
    message: MessageEnvelope<AgentExperiencePayload>,
    context?: AgentDispatchContext,
  ): void {
    if (message.payload.kind === "sync_request") {
      this.handleSync(message.id, message.payload, context);
      return;
    }
    if (message.payload.kind === "review_set") {
      this.handleReview(message.id, message.payload, context);
      return;
    }
    if (message.payload.kind === "shadow_feedback_set") {
      this.handleShadowFeedback(message.id, message.payload, context);
      return;
    }
    if (message.payload.kind === "activation_set") {
      this.handleActivation(message.id, message.payload, context);
      return;
    }
    if (message.payload.kind === "lifecycle_set") {
      this.handleLifecycle(message.id, message.payload, context);
    }
  }

  private handleSync(
    requestId: string,
    payload: AgentExperienceSyncRequestPayload,
    context?: AgentDispatchContext,
  ): void {
    const candidates = this.store.list({
      projectId: payload.project_id,
      sessionId: payload.session_id,
      limit: payload.limit,
    });
    const projectIds = new Set(
      candidates.map((candidate) => candidate.project_id),
    );
    this.sendToApp(
      context,
      createMessage(
        "agent.experience",
        {
          kind: "sync_response",
          request_id: requestId,
          session_id: payload.session_id,
          candidates,
          shadow_runs: this.shadowStore.list({
            projectId: payload.project_id,
            sessionId: payload.session_id,
            limit: payload.limit,
          }),
          shadow_stats: this.shadowStore.stats({
            projectId: payload.project_id,
            sessionId: payload.session_id,
          }),
          activations: this.activationStore.list({
            projectId: payload.project_id,
            sessionId: payload.session_id,
          }),
          applications: this.activationStore.listApplications({
            projectId: payload.project_id,
            sessionId: payload.session_id,
            limit: payload.limit,
          }),
          evaluations: this.evaluationStore.list({
            projectId: payload.project_id,
            sessionId: payload.session_id,
            limit: payload.limit,
          }),
          effects: this.evaluationStore.listEffects({
            projectId: payload.project_id,
            sessionId: payload.session_id,
          }),
          promotions: this.store
            .listPromotionEligibility(payload.project_id)
            .filter((promotion) =>
              payload.session_id
                ? promotion.project_ids.some((projectId) =>
                    projectIds.has(projectId),
                  )
                : true,
            ),
        },
        {
          device_id: this.deviceId,
          session_id: payload.session_id,
        },
      ),
    );
  }

  private handleLifecycle(
    requestId: string,
    payload: AgentExperienceLifecycleSetPayload,
    context?: AgentDispatchContext,
  ): void {
    const result = this.store.setLifecycle(payload);
    if (result.result === "applied" || result.result === "duplicate") {
      this.sendToApp(
        context,
        createMessage(
          "agent.experience",
          {
            kind: "lifecycle_result",
            request_id: requestId,
            client_action_id: payload.client_action_id,
            candidate: result.candidate,
          },
          { device_id: this.deviceId },
        ),
      );
      this.onExperienceChange({
        kind: "updated",
        candidate: result.candidate,
      });
      return;
    }
    const message =
      result.result === "not_found"
        ? "The experience candidate was not found in this project."
        : result.result === "invalid_state"
          ? "The lifecycle action is not valid for the current status."
          : "The lifecycle action identifier conflicts with another action.";
    this.sendToApp(
      context,
      createMessage(
        "agent.experience",
        {
          kind: "error",
          request_id: requestId,
          client_action_id: payload.client_action_id,
          candidate_id: payload.candidate_id,
          code: result.result,
          message,
        },
        { device_id: this.deviceId },
      ),
    );
  }

  private handleShadowFeedback(
    requestId: string,
    payload: AgentExperienceShadowFeedbackSetPayload,
    context?: AgentDispatchContext,
  ): void {
    const result = this.shadowStore.setFeedback(payload);
    if (result.result === "applied" || result.result === "duplicate") {
      this.sendToApp(
        context,
        createMessage(
          "agent.experience",
          {
            kind: "shadow_feedback_result",
            request_id: requestId,
            client_action_id: payload.client_action_id,
            run: result.run,
            shadow_stats: this.shadowStore.stats({
              sessionId: result.run.session_id,
            }),
            activation: this.activationStore.get(result.run.project_id),
          },
          {
            device_id: this.deviceId,
            session_id: result.run.session_id,
            surface_id: result.run.surface_id,
          },
        ),
      );
      return;
    }
    this.sendToApp(
      context,
      createMessage(
        "agent.experience",
        {
          kind: "error",
          request_id: requestId,
          client_action_id: payload.client_action_id,
          candidate_id: payload.candidate_id,
          code: result.result,
          message:
            result.result === "not_found"
              ? "The Shadow match was not found."
              : "The feedback action identifier conflicts with another action.",
        },
        { device_id: this.deviceId },
      ),
    );
  }

  private handleActivation(
    requestId: string,
    payload: AgentExperienceActivationSetPayload,
    context?: AgentDispatchContext,
  ): void {
    const result = this.activationStore.setActivation(payload);
    if (result.result === "applied" || result.result === "duplicate") {
      this.sendToApp(
        context,
        createMessage(
          "agent.experience",
          {
            kind: "activation_result",
            request_id: requestId,
            client_action_id: payload.client_action_id,
            activation: result.activation,
          },
          { device_id: this.deviceId },
        ),
      );
      return;
    }
    this.sendToApp(
      context,
      createMessage(
        "agent.experience",
        {
          kind: "error",
          request_id: requestId,
          client_action_id: payload.client_action_id,
          code: result.result,
          message:
            result.result === "gate_not_ready"
              ? "Shadow feedback has not reached the activation gate."
              : "The activation action identifier conflicts with another action.",
        },
        { device_id: this.deviceId },
      ),
    );
  }

  private handleReview(
    requestId: string,
    payload: AgentExperienceReviewSetPayload,
    context?: AgentDispatchContext,
  ): void {
    const result = this.store.setReview(payload);
    if (result.result === "applied" || result.result === "duplicate") {
      this.sendToApp(
        context,
        createMessage(
          "agent.experience",
          {
            kind: "review_result",
            request_id: requestId,
            client_action_id: payload.client_action_id,
            candidate: result.candidate,
          },
          { device_id: this.deviceId },
        ),
      );
      this.onExperienceChange({
        kind: "updated",
        candidate: result.candidate,
      });
      return;
    }

    const errorMessage =
      result.result === "not_found"
        ? "The experience candidate was not found in this project."
        : result.result === "invalid_state"
          ? "This experience candidate cannot be reviewed in its current state."
          : "The review action conflicts with an existing candidate or action.";
    this.sendToApp(
      context,
      createMessage(
        "agent.experience",
        {
          kind: "error",
          request_id: requestId,
          client_action_id: payload.client_action_id,
          candidate_id: payload.candidate_id,
          code: result.result,
          message: errorMessage,
        },
        { device_id: this.deviceId },
      ),
    );
  }
}
