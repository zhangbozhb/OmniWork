import type {
  MessageEnvelope,
  P2pChannelKind,
  TransportPath,
  WebRtcPeerAdapter,
} from "@omni-work/protocol-ts";
import { TRANSPORT_HEALTH_POLICY } from "@omni-work/protocol-ts";

export type MessageHandler = (envelope: MessageEnvelope) => void;
export type PathChangeHandler = (path: TransportPath) => void;
export type DowngradeReasonHandler = (reason: string) => void;
export type ForceCloseHandler = (reason: string) => void;

export type QueuedSend = {
  envelope: MessageEnvelope;
  channel?: P2pChannelKind;
};

export type SendOptions = {
  strictBypass?: boolean;
};

export interface PeerRouteState {
  peer: WebRtcPeerAdapter;
  detach: () => void;
  onDowngrade: DowngradeReasonHandler | null;
  upgradeId: string | null;
}

export interface AppRouteState {
  currentPath: TransportPath;
  strictP2p: boolean;
  forceCloseHandler: ForceCloseHandler | null;
  forceClosed: boolean;
  pendingQueue: QueuedSend[];
  switching: boolean;
  outboundQueue: QueuedSend[] | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  pingSeq: number;
  pendingPings: Map<
    number,
    {
      sentAt: number;
      timeout: ReturnType<typeof setTimeout>;
    }
  >;
  pongTimeoutCount: number;
  bufferedSampleTimer: ReturnType<typeof setInterval> | null;
  bufferedOverflowSeconds: number;
  iceDisconnectedTimer: ReturnType<typeof setTimeout> | null;
}

export type TransportEvent =
  | { type: "path_change"; from: TransportPath; to: TransportPath }
  | { type: "ping_timeout"; seq: number; count: number }
  | { type: "pong_received"; seq: number; rtt_ms: number }
  | { type: "downgrade"; reason: string }
  | { type: "force_close"; reason: string }
  | { type: "strict_send_blocked"; envelope_type: string }
  | {
      type: "display_frame_deferred";
      app_connection_id: string;
      buffered_amount: number;
    }
  | {
      type: "pending_drop";
      reason: "queue_overflow" | "session_close" | "force_close";
      count: number;
    };

export type TransportEventHandler = (event: TransportEvent) => void;

export interface AttachP2pPeerOptions {
  appConnectionId?: string;
  /**
   * 当传输层检测到需要降级（pong 超时 / bufferedAmount / ICE 异常）时回调，
   * 由外部（通常是 UpgradeCoordinator.downgrade）执行真正的协议降级动作。
   */
  onDowngrade?: DowngradeReasonHandler;
  /** 当前 upgrade_id，会写入 transport.ping 的 payload，便于 Relay/对端审计。 */
  upgradeId?: string;
}

export const {
  bufferedAmountLimit: BUFFERED_AMOUNT_LIMIT,
  bufferedAmountOverflowSeconds: BUFFERED_AMOUNT_OVERFLOW_SECONDS,
  bufferedAmountSampleIntervalMs: BUFFERED_AMOUNT_SAMPLE_INTERVAL_MS,
  displayFrameBufferedAmountLimit: DISPLAY_FRAME_BUFFERED_AMOUNT_LIMIT,
  drainDelayMs: DRAIN_DELAY_MS,
  iceDisconnectedGraceMs: ICE_DISCONNECTED_GRACE_MS,
  pingIntervalMs: PING_INTERVAL_MS,
  pingTimeoutMs: PING_TIMEOUT_MS,
  pingTimeoutThreshold: PING_TIMEOUT_THRESHOLD,
  pingTimerStallGraceMs: PING_TIMER_STALL_GRACE_MS,
  strictIceDisconnectedGraceMs: STRICT_ICE_DISCONNECTED_GRACE_MS,
  strictPendingQueueLimit: STRICT_PENDING_QUEUE_LIMIT,
  strictPingIntervalMs: STRICT_PING_INTERVAL_MS,
  strictPingTimeoutMs: STRICT_PING_TIMEOUT_MS,
  strictPingTimeoutThreshold: STRICT_PING_TIMEOUT_THRESHOLD,
  strictPingTimerStallGraceMs: STRICT_PING_TIMER_STALL_GRACE_MS,
} = TRANSPORT_HEALTH_POLICY;
