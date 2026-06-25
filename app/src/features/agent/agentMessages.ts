import {
  createMessage,
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
