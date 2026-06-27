import type {
  MessageEnvelope,
  P2pChannelKind,
} from "@omniwork/protocol-ts";

/**
 * 严格 P2P 模式下放行的控制面消息前缀；其余业务消息（session.x / terminal.x /
 * workspace.x / files.x / git.x / agent.x）必须在 currentPath === "p2p" 时才能 send。
 */
const STRICT_CONTROL_PREFIXES = ["tunnel.upgrade.", "transport."] as const;

export function isStrictControlMessage(envelopeType: string): boolean {
  for (const prefix of STRICT_CONTROL_PREFIXES) {
    if (envelopeType.startsWith(prefix)) {
      return true;
    }
  }
  return false;
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
