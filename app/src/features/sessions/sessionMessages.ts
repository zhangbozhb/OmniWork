import { createMessage, type SessionCreatePayload } from "@omniwork/protocol-ts";

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

export function renameSessionRequest(
  deviceId: string,
  sessionId: string,
  title: string,
) {
  return createMessage(
    "session.rename",
    { session_id: sessionId, title },
    { device_id: deviceId, session_id: sessionId },
  );
}

export function killTerminalSessionRequest(deviceId: string, sessionId: string) {
  return createMessage(
    "session.kill_terminal",
    { session_id: sessionId },
    { device_id: deviceId, session_id: sessionId },
  );
}

