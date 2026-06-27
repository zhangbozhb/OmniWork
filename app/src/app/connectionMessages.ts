export function formatErrorMessage(
  error: unknown,
  fallback = "Unknown error",
): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return fallback;
  }
}

export function formatRelayCloseMessage(event: {
  code?: number;
  reason?: string;
}): string {
  const reason = event.reason ? `: ${event.reason}` : "";
  return `Connection closed${event.code ? ` (${event.code})` : ""}${reason}`;
}

export function formatStrictForceCloseMessage(reason: string): string {
  if (reason.startsWith("strict_unavailable:")) {
    const cause = reason.slice("strict_unavailable:".length);
    if (cause === "relay_disabled") {
      return "Direct only is unavailable on this Relay. Switch Connection mode or contact the operator.";
    }
    if (cause === "blocklisted") {
      return "Direct only is unavailable: this device is blocked by the Relay.";
    }
    if (cause === "backoff_active") {
      return "Direct only is cooling down after recent failures. Retry in a few minutes or switch Connection mode.";
    }
    return `Direct only unavailable (${cause}). Switch Connection mode or reconnect.`;
  }
  switch (reason) {
    case "peer_unavailable":
      return "Direct connection unavailable. Check that the App and computer are reachable and try again.";
    case "create_offer_failed":
    case "handle_offer_failed":
    case "handle_answer_failed":
      return "Direct connection setup failed. Reconnect, and if the issue persists switch Connection mode.";
    case "timeout":
      return "Direct connection setup timed out. Check the network and retry.";
    case "pong_timeout":
      return "Direct connection lost (no heartbeat). Reconnect or switch Connection mode.";
    case "ice_failed":
    case "ice_disconnected":
      return "Direct connection lost. Reconnect or switch Connection mode.";
    case "buffered_overflow":
      return "Direct connection lost (send buffer overflow). Reconnect or switch Connection mode.";
    case "peer_closed":
    case "peer_missing":
      return "Direct connection closed unexpectedly. Reconnect or switch Connection mode.";
    default:
      return `Direct connection unavailable: ${reason}. Switch Connection mode or reconnect.`;
  }
}
