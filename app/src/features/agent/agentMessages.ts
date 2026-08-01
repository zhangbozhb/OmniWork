import {
  createMessage,
  createMessageId,
  type AgentInteractionAnswerPayload,
  type AgentInteractionRequestPayload,
  type AgentMessageDeliveredPayload,
  type AgentNotificationSettingsPayload,
  type AgentSurfaceSyncRequestPayload,
} from "@omni-work/protocol-ts";

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
