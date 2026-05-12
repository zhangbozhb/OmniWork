import { createMessage, type SessionCreatePayload } from "../../../../packages/protocol-ts/src/index.ts";

export function createSessionRequest(deviceId: string, payload: SessionCreatePayload = {}) {
  return createMessage("session.create", payload, { device_id: deviceId });
}

export function listSessionsRequest(deviceId: string) {
  return createMessage("session.list", {}, { device_id: deviceId });
}
