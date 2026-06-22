import {
  createMessage,
  type TerminalInputPayload,
  type TerminalResizePayload,
} from "@omniwork/protocol-ts";

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

export function terminalStreamStartRequest(deviceId: string, sessionId: string) {
  return createMessage("terminal.stream.start", { encoding: "utf8" }, {
    device_id: deviceId,
    session_id: sessionId,
  });
}

export function terminalStreamStopRequest(deviceId: string, sessionId: string) {
  return createMessage("terminal.stream.stop", {}, {
    device_id: deviceId,
    session_id: sessionId,
  });
}

export function terminalResizeRequest(
  deviceId: string,
  sessionId: string,
  payload: TerminalResizePayload,
) {
  return createMessage("terminal.resize", payload, {
    device_id: deviceId,
    session_id: sessionId,
  });
}
