import { createMessage, type TerminalInputPayload } from "../../../../packages/protocol-ts/src/index.ts";

export function terminalInputRequest(
  deviceId: string,
  sessionId: string,
  payload: TerminalInputPayload,
) {
  return createMessage("terminal.input", payload, {
    device_id: deviceId,
    session_id: sessionId,
  });
}

export function terminalSnapshotRequest(deviceId: string, sessionId: string) {
  return createMessage("terminal.snapshot", {}, {
    device_id: deviceId,
    session_id: sessionId,
  });
}
