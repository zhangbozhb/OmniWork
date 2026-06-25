import {
  createMessage,
  type AgentMessageDeliveredPayload,
  type AgentNotificationSettingsPayload,
} from "@omniwork/protocol-ts";

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
