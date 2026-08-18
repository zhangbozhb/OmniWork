import {
  createMessage,
  createMessageId,
  type DeliveryEpisodeSummary,
  type DeliveryOutcome,
  type ExperienceCandidateSummary,
  type ExperienceShadowFeedback,
  type AgentInteractionAnswerPayload,
  type AgentInteractionRequestPayload,
  type AgentMessageDeliveredPayload,
  type AgentMessageListRequestPayload,
  type AgentNotificationSettingsPayload,
  type AgentSurfaceSyncRequestPayload,
  type AgentDeliveryOutcomeSetPayload,
  type AgentExperienceReviewSetPayload,
  type AgentExperienceShadowFeedbackSetPayload,
  type AgentExperienceActivationSetPayload,
  type AgentExperienceLifecycleSetPayload,
} from "@omni-work/protocol-ts";

export function agentMessageListRequest(
  deviceId: string,
  payload: AgentMessageListRequestPayload = {},
) {
  return createMessage("agent.message.list", payload, {
    device_id: deviceId,
  });
}

export function agentDeliverySyncRequest(
  deviceId: string,
  sessionId: string,
  surfaceId: string,
) {
  return createMessage(
    "agent.delivery",
    {
      kind: "sync_request" as const,
      session_id: sessionId,
      surface_id: surfaceId,
      limit: 100,
    },
    {
      device_id: deviceId,
      session_id: sessionId,
      surface_id: surfaceId,
    },
  );
}

export function agentDeliveryOutcomeSet(
  deviceId: string,
  episode: DeliveryEpisodeSummary,
  outcome: DeliveryOutcome,
  note?: string,
) {
  const payload: AgentDeliveryOutcomeSetPayload = {
    kind: "outcome_set",
    episode_id: episode.episode_id,
    session_id: episode.session_id,
    surface_id: episode.surface_id,
    client_action_id: createMessageId(),
    outcome,
    ...(note?.trim() ? { note: note.trim() } : {}),
    created_at: new Date().toISOString(),
  };
  return createMessage("agent.delivery", payload, {
    device_id: deviceId,
    session_id: episode.session_id,
    surface_id: episode.surface_id,
  });
}

export function agentExperienceSyncRequest(
  deviceId: string,
  sessionId: string,
) {
  return createMessage(
    "agent.experience",
    {
      kind: "sync_request" as const,
      session_id: sessionId,
      limit: 100,
    },
    {
      device_id: deviceId,
      session_id: sessionId,
    },
  );
}

export function agentExperienceReviewSet(
  deviceId: string,
  candidate: ExperienceCandidateSummary,
  decision: "approved" | "rejected",
  trigger: string,
  guidance: string,
  note?: string,
) {
  const payload: AgentExperienceReviewSetPayload = {
    kind: "review_set",
    candidate_id: candidate.candidate_id,
    project_id: candidate.project_id,
    client_action_id: createMessageId(),
    decision,
    trigger: trigger.trim(),
    guidance: guidance.trim(),
    ...(note?.trim() ? { note: note.trim() } : {}),
    created_at: new Date().toISOString(),
  };
  return createMessage("agent.experience", payload, {
    device_id: deviceId,
  });
}

export function agentExperienceShadowFeedbackSet(
  deviceId: string,
  runId: string,
  candidateId: string,
  feedback: ExperienceShadowFeedback,
) {
  const payload: AgentExperienceShadowFeedbackSetPayload = {
    kind: "shadow_feedback_set",
    run_id: runId,
    candidate_id: candidateId,
    client_action_id: createMessageId(),
    feedback,
    created_at: new Date().toISOString(),
  };
  return createMessage("agent.experience", payload, {
    device_id: deviceId,
  });
}

export function agentExperienceActivationSet(
  deviceId: string,
  projectId: string,
  enabled: boolean,
) {
  const payload: AgentExperienceActivationSetPayload = {
    kind: "activation_set",
    project_id: projectId,
    client_action_id: createMessageId(),
    enabled,
    created_at: new Date().toISOString(),
  };
  return createMessage("agent.experience", payload, {
    device_id: deviceId,
  });
}

export function agentExperienceLifecycleSet(
  deviceId: string,
  candidate: ExperienceCandidateSummary,
  action: AgentExperienceLifecycleSetPayload["action"],
  note?: string,
) {
  const payload: AgentExperienceLifecycleSetPayload = {
    kind: "lifecycle_set",
    candidate_id: candidate.candidate_id,
    project_id: candidate.project_id,
    client_action_id: createMessageId(),
    action,
    ...(note?.trim() ? { note: note.trim() } : {}),
    created_at: new Date().toISOString(),
  };
  return createMessage("agent.experience", payload, {
    device_id: deviceId,
  });
}

export function agentInteractionSyncRequest(deviceId: string) {
  return createMessage(
    "agent.interaction",
    { kind: "sync_request" as const },
    { device_id: deviceId },
  );
}

export function agentInteractionAnswer(
  deviceId: string,
  interaction: AgentInteractionRequestPayload,
  decision: AgentInteractionAnswerPayload["decision"],
  answers?: Record<string, string[]>,
) {
  const payload: AgentInteractionAnswerPayload = {
    kind: "answer",
    interaction_id: interaction.interaction_id,
    session_id: interaction.session_id,
    surface_id: interaction.surface_id,
    client_action_id: createMessageId(),
    decision,
    ...(answers ? { answers } : {}),
    created_at: new Date().toISOString(),
  };
  return createMessage("agent.interaction", payload, {
    device_id: deviceId,
    session_id: interaction.session_id,
    surface_id: interaction.surface_id,
  });
}

export function getAgentNotificationSettingsRequest(deviceId: string) {
  return createMessage("agent.notification.settings.get", {}, {
    device_id: deviceId,
  });
}

export function setAgentNotificationSettingsRequest(
  deviceId: string,
  payload: AgentNotificationSettingsPayload,
) {
  return createMessage("agent.notification.settings.set", payload, {
    device_id: deviceId,
  });
}

export function agentMessageDeliveredRequest(
  deviceId: string,
  payload: AgentMessageDeliveredPayload,
) {
  return createMessage("agent.message.delivered", payload, {
    device_id: deviceId,
  });
}

export function agentSurfaceSyncRequest(
  deviceId: string,
  sessionId: string,
  surfaceId: string,
  afterCursor = 0,
) {
  const payload: AgentSurfaceSyncRequestPayload = {
    kind: "request",
    session_id: sessionId,
    surface_id: surfaceId,
    after_cursor: afterCursor,
    limit: 100,
  };
  return createMessage("agent.surface.sync", payload, {
    device_id: deviceId,
    session_id: sessionId,
    surface_id: surfaceId,
  });
}
