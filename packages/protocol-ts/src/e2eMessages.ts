import {
  INNER_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type InnerEnvelope,
  type MessageEnvelope,
} from "./index.ts";

export function isE2EBusinessMessage(type: string): boolean {
  return (
    type.startsWith("session.") ||
    type.startsWith("terminal.") ||
    type.startsWith("workspace.") ||
    type.startsWith("files.") ||
    type.startsWith("git.") ||
    type.startsWith("codex.") ||
    type.startsWith("app.connection.") ||
    type.startsWith("tunnel.upgrade.")
  );
}

export function messageToInner(message: MessageEnvelope): InnerEnvelope {
  return {
    v: INNER_PROTOCOL_VERSION,
    id: message.id,
    type: message.type,
    created_at: message.ts,
    seq: message.seq,
    session_id: message.session_id,
    payload: message.payload,
  };
}

export function innerToMessage(
  inner: InnerEnvelope,
  deviceId: string,
): MessageEnvelope {
  return {
    v: PROTOCOL_VERSION,
    id: inner.id,
    type: inner.type,
    device_id: deviceId,
    session_id: inner.session_id,
    seq: inner.seq,
    ts: inner.created_at,
    payload: inner.payload,
  };
}
