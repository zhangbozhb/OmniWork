import type { MessageEnvelope } from "./index.ts";
import type { P2pChannelKind } from "./webrtc.ts";

export type TransportPath = "relay" | "p2p";
export type UpgradeState =
  | "idle"
  | "proposed"
  | "negotiating"
  | "committing"
  | "upgraded"
  | "failed";

const UPGRADE_STATE_TRANSITIONS: Record<
  UpgradeState,
  readonly UpgradeState[]
> = {
  idle: ["proposed"],
  proposed: ["negotiating", "failed", "idle"],
  negotiating: ["committing", "failed", "idle"],
  committing: ["upgraded", "failed", "idle"],
  upgraded: ["idle"],
  failed: ["idle"],
};

export function transitionUpgradeState(
  current: UpgradeState,
  next: UpgradeState,
): UpgradeState {
  if (current === next) {
    return current;
  }
  if (!UPGRADE_STATE_TRANSITIONS[current].includes(next)) {
    throw new Error(`Invalid upgrade state transition: ${current} -> ${next}`);
  }
  return next;
}

const STRICT_CONTROL_PREFIXES = ["tunnel.upgrade.", "transport."] as const;

export function isStrictTransportControlMessage(
  envelopeType: string,
): boolean {
  return STRICT_CONTROL_PREFIXES.some((prefix) =>
    envelopeType.startsWith(prefix),
  );
}

export const TRANSPORT_HEALTH_POLICY = {
  drainDelayMs: 100,
  pingIntervalMs: 5_000,
  pingTimeoutMs: 2_500,
  pingTimeoutThreshold: 4,
  strictPingIntervalMs: 4_000,
  strictPingTimeoutMs: 5_000,
  strictPingTimeoutThreshold: 6,
  pingTimerStallGraceMs: 5_000,
  strictPingTimerStallGraceMs: 8_000,
  bufferedAmountLimit: 1_000_000,
  displayFrameBufferedAmountLimit: 256_000,
  bufferedAmountSampleIntervalMs: 1_000,
  bufferedAmountOverflowSeconds: 5,
  iceDisconnectedGraceMs: 8_000,
  strictIceDisconnectedGraceMs: 16_000,
  strictPendingQueueLimit: 256,
} as const;

export interface SessionTransport {
  send(envelope: MessageEnvelope, channel?: P2pChannelKind): void;
  onMessage(handler: (envelope: MessageEnvelope) => void): () => void;
  onPathChange(handler: (path: TransportPath) => void): () => void;
  getCurrentPath(): TransportPath;
  close(reason: string): void;
}
