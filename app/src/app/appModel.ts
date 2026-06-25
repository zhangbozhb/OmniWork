import type { TerminalSession } from "@omniwork/protocol-ts";
import type { PairingConfig } from "../features/auth/types";
import type { AppView, PrimaryTabView } from "./appTypes";

export function upsertSession(
  sessions: TerminalSession[],
  nextSession: TerminalSession,
): TerminalSession[] {
  const index = sessions.findIndex(
    (session) => session.session_id === nextSession.session_id,
  );
  if (index < 0) {
    return [nextSession, ...sessions];
  }

  const nextSessions = [...sessions];
  nextSessions[index] = nextSession;
  return nextSessions;
}

export function upsertPairing(
  pairings: PairingConfig[],
  nextPairing: PairingConfig,
): PairingConfig[] {
  const index = pairings.findIndex((pairing) =>
    isSamePairing(pairing, nextPairing),
  );
  if (index < 0) {
    return [...pairings, nextPairing];
  }

  const nextPairings = [...pairings];
  nextPairings[index] = nextPairing;
  return nextPairings;
}

export function isSamePairing(
  left: PairingConfig,
  right: PairingConfig,
): boolean {
  return left.relayUrl === right.relayUrl && left.deviceId === right.deviceId;
}

export function getPairingDisplayName(pairing: PairingConfig): string {
  return pairing.displayName?.trim() || pairing.deviceId;
}

export function getHeaderSubtitle(
  view: AppView,
  deviceCount: number,
  activePairing: PairingConfig | null,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (view === "devices") {
    return t("app.subtitle.linkedDevices", { count: deviceCount });
  }
  if (view === "settings") {
    return t("app.subtitle.globalPreferences");
  }
  if (view === "messages") {
    return t("app.subtitle.agentMessages");
  }
  if (view === "connectionPreference") {
    return t("app.subtitle.connectionSettings");
  }

  return activePairing ? getPairingDisplayName(activePairing) : "";
}

export function isPrimaryTabView(view: AppView): view is PrimaryTabView {
  return view === "devices" || view === "messages" || view === "settings";
}

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

export function isTransitionalSessionStatus(
  status: TerminalSession["status"],
): boolean {
  return status === "created" || status === "starting";
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
      return "Direct connection unavailable. Check that the App and Mac Agent are reachable and try again.";
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
