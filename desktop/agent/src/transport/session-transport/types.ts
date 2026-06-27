import type {
  MessageEnvelope,
  P2pChannelKind,
  TransportPath,
  WebRtcPeerAdapter,
} from "@omniwork/protocol-ts";

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

export const DRAIN_DELAY_MS = 100;
export const PING_INTERVAL_MS = 5_000;
export const PING_TIMEOUT_MS = 2_500;
export const PING_TIMEOUT_THRESHOLD = 4;

/**
 * strict 模式下心跳采用更宽松的阈值，避免 4G/5G 弱网偶发丢包就触发不可恢复的 forceClose。
 * - INTERVAL 使用 4s：降低移动弱网和 JS 短暂停顿下的探测噪声；
 * - TIMEOUT 放宽到 5s：覆盖 RTT 较高的跨大洲 / 移动网络场景；
 * - THRESHOLD 提升到 6：单次成功收到 pong 即清零，连续 6 次未收到才算"真死"。
 */
export const STRICT_PING_INTERVAL_MS = 4_000;
export const STRICT_PING_TIMEOUT_MS = 5_000;
export const STRICT_PING_TIMEOUT_THRESHOLD = 6;
export const PING_TIMER_STALL_GRACE_MS = 5_000;
export const STRICT_PING_TIMER_STALL_GRACE_MS = 8_000;
export const BUFFERED_AMOUNT_LIMIT = 1_000_000;
export const DISPLAY_FRAME_BUFFERED_AMOUNT_LIMIT = 256_000;
export const BUFFERED_AMOUNT_SAMPLE_INTERVAL_MS = 1_000;
export const BUFFERED_AMOUNT_OVERFLOW_SECONDS = 5;
export const ICE_DISCONNECTED_GRACE_MS = 8_000;

/**
 * strict 模式下 ICE disconnected → connected 的容忍窗口拉长到 16s，
 * 避免移动端 LTE/Wi-Fi 漫游瞬间的 ICE 抖动直接 forceClose。
 */
export const STRICT_ICE_DISCONNECTED_GRACE_MS = 16_000;

/**
 * strict 模式下 P2P 未就绪期间业务消息暂存队列的上限。超过此上限说明
 * 协商窗口异常长，继续累积只会让 flush 时 burst 写入 DataChannel 触发
 * buffered_overflow，直接 forceClose 让上层重建 session 更安全。
 */
export const STRICT_PENDING_QUEUE_LIMIT = 256;
