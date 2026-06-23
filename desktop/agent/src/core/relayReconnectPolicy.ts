import type { RelayCloseEvent } from "@omniwork/relay-client";

export type RelayConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "terminal_error"
  | "stopped";

export type RelayCloseClassification = "retryable" | "terminal";

export const TERMINAL_RELAY_CLOSE_REASONS = [
  "agent_disabled",
  "ip_banned",
  "auth_failed",
  "wrong_endpoint",
  "protocol_unsupported",
] as const;

const terminalReasonSet = new Set<string>(TERMINAL_RELAY_CLOSE_REASONS);

const terminalCloseCodes = new Set([1008, 4001, 4003, 4401, 4403]);

const legacyTerminalTextKeywords = [
  "unauthorized",
  "forbidden",
  "policy violation",
  "rejected",
  "reject",
  "invalid token",
  "invalid device",
  "authentication failed",
  "wrong endpoint",
  "protocol_version_unsupported",
];

export function classifyRelayClose(
  event: RelayCloseEvent,
): RelayCloseClassification {
  if (event.code !== undefined && terminalCloseCodes.has(event.code)) {
    return "terminal";
  }
  return isTerminalRelayText(event.reason ?? "") ? "terminal" : "retryable";
}

export function isTerminalRelayConnectionError(error: unknown): boolean {
  return isTerminalRelayText(formatRelayConnectionError(error));
}

export function shouldLimitRelayReconnectAttempt(input: {
  reconnectForever: boolean;
  maxAttempts: number;
  nextAttempt: number;
}): boolean {
  return (
    !input.reconnectForever &&
    input.maxAttempts > 0 &&
    input.nextAttempt > input.maxAttempts
  );
}

export function relayReconnectAttemptLimitLabel(input: {
  reconnectForever: boolean;
  maxAttempts: number;
}): number | "unlimited" {
  if (input.reconnectForever || input.maxAttempts === 0) {
    return "unlimited";
  }
  return input.maxAttempts;
}

export function nextRelayReconnectDelayMs(input: {
  attempt: number;
  initialDelayMs: number;
  maxDelayMs: number;
  random?: () => number;
}): number {
  const exponent = Math.max(0, input.attempt - 1);
  const rawDelay = input.initialDelayMs * 2 ** exponent;
  const cappedDelay = Math.min(rawDelay, input.maxDelayMs);
  const random = input.random ?? Math.random;
  const jitterFactor = 0.8 + random() * 0.4;
  return Math.max(1, Math.round(cappedDelay * jitterFactor));
}

export function formatRelayConnectionError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isTerminalRelayText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (terminalReasonSet.has(normalized)) {
    return true;
  }
  return legacyTerminalTextKeywords.some((keyword) =>
    normalized.includes(keyword),
  );
}
