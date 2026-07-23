import type {
  MessageEnvelope,
  P2pChannelKind,
} from "@omni-work/protocol-ts";
import { isStrictTransportControlMessage } from "@omni-work/protocol-ts";

export function isStrictControlMessage(envelopeType: string): boolean {
  return isStrictTransportControlMessage(envelopeType);
}

export function getEnvelopeAppConnectionId(
  envelope: MessageEnvelope,
): string | undefined {
  const payload = envelope.payload as { app_connection_id?: unknown };
  return typeof payload?.app_connection_id === "string"
    ? payload.app_connection_id
    : undefined;
}

function channelForEnvelope(envelope: MessageEnvelope): P2pChannelKind {
  switch (envelope.type) {
    case "terminal.input":
    case "terminal.resize":
    case "terminal.stream.start":
    case "terminal.stream.stop":
      return "input";
    case "terminal.frame":
    case "terminal.stream.data":
      return "display";
    default:
      return "control";
  }
}

export function channelForP2pEnvelope(
  envelope: MessageEnvelope,
  channel?: P2pChannelKind,
): P2pChannelKind {
  if (envelope.type === "e2e.message") {
    // Current E2E replay protection requires a single strictly ordered stream.
    return "control";
  }
  return channel ?? channelForEnvelope(envelope);
}
