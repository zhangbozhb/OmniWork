import {
  createMessage,
  type TerminalInputPayload,
  type TerminalResizePayload,
} from "@omniwork/protocol-ts";

export function terminalInputRequest(
  deviceId: string,
  sessionId: string,
  surfaceId: string,
  payload: TerminalInputPayload,
) {
  return createMessage("terminal.input", payload, {
    device_id: deviceId,
    session_id: sessionId,
    surface_id: surfaceId,
  });
}

export function terminalSnapshotRequest(
  deviceId: string,
  sessionId: string,
  surfaceId: string,
) {
  return createMessage("terminal.snapshot", {}, {
    device_id: deviceId,
    session_id: sessionId,
    surface_id: surfaceId,
  });
}

export function terminalStreamStartRequest(
  deviceId: string,
  sessionId: string,
  surfaceId: string,
) {
  return createMessage("terminal.stream.start", { encoding: "utf8" }, {
    device_id: deviceId,
    session_id: sessionId,
    surface_id: surfaceId,
  });
}

export function terminalStreamStopRequest(
  deviceId: string,
  sessionId: string,
  surfaceId: string,
) {
  return createMessage("terminal.stream.stop", {}, {
    device_id: deviceId,
    session_id: sessionId,
    surface_id: surfaceId,
  });
}

export function terminalResizeRequest(
  deviceId: string,
  sessionId: string,
  surfaceId: string,
  payload: TerminalResizePayload,
) {
  return createMessage("terminal.resize", payload, {
    device_id: deviceId,
    session_id: sessionId,
    surface_id: surfaceId,
  });
}
