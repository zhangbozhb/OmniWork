import { createMessage, type SessionCreatePayload } from "../../../../packages/protocol-ts/src/index.ts";

export function createSessionRequest(deviceId: string, payload: SessionCreatePayload = {}) {
  return createMessage("session.create", payload, { device_id: deviceId });
}

export function listSessionsRequest(deviceId: string) {
  return createMessage("session.list", {}, { device_id: deviceId });
}

export function closeSessionRequest(deviceId: string, sessionId: string) {
  return createMessage(
    "session.close",
    { session_id: sessionId },
    { device_id: deviceId, session_id: sessionId },
  );
}
