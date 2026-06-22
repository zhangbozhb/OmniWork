import {
  createMessage,
  parseMessageEnvelope,
  type MessageEnvelope,
  type P2pChannelKind,
  type SessionTransport,
  type TransportPath,
  type TransportPingPayload,
  type TransportPongPayload,
  type WebRtcPeerAdapter,
} from "@omniwork/protocol-ts";
import type { RelayCloseEvent } from "@omniwork/relay-client";
import type { MobileRelayPath } from "./relayPath.ts";

type MessageHandler = (envelope: MessageEnvelope) => void;
type PathChangeHandler = (path: TransportPath) => void;
type DowngradeReasonHandler = (reason: string) => void;
type ForceCloseHandler = (reason: string) => void;
type QueuedSend = {
  envelope: MessageEnvelope;
  channel?: P2pChannelKind;
};
type TransportEvent =
  | { type: "path_change"; from: TransportPath; to: TransportPath }
  | { type: "ping_timeout"; seq: number; count: number }
  | { type: "pong_received"; seq: number; rtt_ms: number }
  | { type: "downgrade"; reason: string }
  | { type: "force_close"; reason: string }
  | { type: "strict_send_blocked"; envelope_type: string }
  | {
      type: "pending_drop";
      reason: "queue_overflow" | "session_close" | "force_close";
      count: number;
    }
  | { type: "background_pause" }
  | { type: "background_resume" };
type TransportEventHandler = (event: TransportEvent) => void;

/**
 * 严格 P2P 模式下放行的控制面消息前缀；其余业务消息（session.x / terminal.x /
 * workspace.x / files.x / git.x / agent.x）必须在 currentPath === "p2p" 时才能 send。
 */
const STRICT_CONTROL_PREFIXES = ["tunnel.upgrade.", "transport."] as const;

function isStrictControlMessage(envelopeType: string): boolean {
  for (const prefix of STRICT_CONTROL_PREFIXES) {
    if (envelopeType.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

const DRAIN_DELAY_MS = 100;
const PING_INTERVAL_MS = 5_000;
const PING_TIMEOUT_MS = 2_500;
const PING_TIMEOUT_THRESHOLD = 4;
/**
 * strict 模式下心跳采用更宽松的阈值，避免 4G/5G 弱网偶发丢包就触发不可恢复的 forceClose。
 * - INTERVAL 使用 4s：降低移动弱网和 JS 短暂停顿下的探测噪声；
 * - TIMEOUT 放宽到 5s：覆盖 RTT 较高的跨大洲 / 移动网络场景；
 * - THRESHOLD 提升到 6：单次成功收到 pong 即清零，连续 6 次未收到才算"真死"。
 */
const STRICT_PING_INTERVAL_MS = 4_000;
const STRICT_PING_TIMEOUT_MS = 5_000;
const STRICT_PING_TIMEOUT_THRESHOLD = 6;
const PING_TIMER_STALL_GRACE_MS = 5_000;
const STRICT_PING_TIMER_STALL_GRACE_MS = 8_000;
const BUFFERED_AMOUNT_LIMIT = 1_000_000;
const BUFFERED_AMOUNT_SAMPLE_INTERVAL_MS = 1_000;
const BUFFERED_AMOUNT_OVERFLOW_SECONDS = 5;
const ICE_DISCONNECTED_GRACE_MS = 8_000;
/**
 * strict 模式下 ICE disconnected → connected 的容忍窗口拉长到 16s，
 * 避免移动端 LTE/Wi-Fi 漫游瞬间的 ICE 抖动直接 forceClose。
 */
const STRICT_ICE_DISCONNECTED_GRACE_MS = 16_000;
/**
 * strict 模式下 P2P 未就绪期间业务消息暂存队列的上限。超过此上限说明
 * 协商窗口异常长（>10s 的 negotiation 超时配合上层重试已足够暴露问题），
 * 此时继续累积只会让 flush 时 burst 写入 DataChannel 触发 buffered_overflow，
 * 直接 forceClose 让上层重建 session 更安全。
 */
const STRICT_PENDING_QUEUE_LIMIT = 256;

export interface AttachP2pPeerOptions {
  /** 由 UpgradeCoordinator.downgrade 提供的降级回调；transport 检测到健康异常时调用。 */
  onDowngrade?: DowngradeReasonHandler;
  upgradeId?: string;
}

/**
 * 由外部（通常是 App.tsx wiring）订阅的"严格 P2P 失败"通知；
 * transport 检测到健康异常或被 coordinator 标记 forceClose 时调用，
 * 由上层负责清理 session/workspace 状态并对 UI 透出错误原因。
 */
export type ForceCloseReason =
  | "peer_unavailable"
  | "ice_failed"
  | "ice_disconnected"
  | "pong_timeout"
  | "buffered_overflow"
  | "peer_closed"
  | "timeout"
  | "create_offer_failed"
  | "handle_offer_failed"
  | "handle_answer_failed"
  | "peer_state"
  | "strict_p2p_unreachable"
  | (string & {});

export interface MobileSessionTransportOptions {
  /**
   * 严格 P2P 模式标记，由 mobile.connect.transport_preference="prefer_p2p" 推导。
   * - 升级前 send() 会拒绝业务消息（仅放行 tunnel.upgrade.* / transport.*）
   * - 升级后任何健康降级理由都改为 forceClose，不会切回 relay
   */
  strictP2p?: boolean;
  /**
   * strict 模式下当协商或运行期失败需要"关闭整个 session"时调用；
   * 上层负责清理 session/workspace 状态 + UI 错误提示。
   */
  onForceClose?: ForceCloseHandler;
}

export class MobileSessionTransport implements SessionTransport {
  private readonly relayPath: MobileRelayPath;
  private currentPath: TransportPath = "relay";
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly pathChangeHandlers = new Set<PathChangeHandler>();
  private readonly eventHandlers = new Set<TransportEventHandler>();
  private closed = false;
  private peer: WebRtcPeerAdapter | null = null;
  private detachPeerListeners: (() => void) | null = null;
  private outboundQueue: QueuedSend[] | null = null;
  /**
   * 严格 P2P 模式下、currentPath !== "p2p" 时业务消息的暂存队列。
   * - 升级到 p2p 后由 switchPath() flush；
   * - 如果 P2P 先于 E2E ready，flush 会重新入队，等 onBusinessReady 再发送；
   * - forceClose / close 时丢弃（业务上层会重建 session 后重新发起请求）。
   */
  private strictPendingQueue: QueuedSend[] = [];
  private switching = false;
  private downgradeHandler: DowngradeReasonHandler | null = null;
  private upgradeId: string | null = null;
  private readonly strictP2p: boolean;
  private readonly forceCloseHandler: ForceCloseHandler | null;
  private forceClosed = false;
  private backgroundPaused = false;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSeq = 0;
  private pendingPings = new Map<
    number,
    {
      sentAt: number;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private pongTimeoutCount = 0;

  private bufferedSampleTimer: ReturnType<typeof setInterval> | null = null;
  private bufferedOverflowSeconds = 0;

  private iceDisconnectedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    relayPath: MobileRelayPath,
    options: MobileSessionTransportOptions = {},
  ) {
    this.relayPath = relayPath;
    this.strictP2p = options.strictP2p ?? false;
    this.forceCloseHandler = options.onForceClose ?? null;
    this.relayPath.onMessage((message) => this.dispatch(message));
    this.relayPath.onBusinessReady(() => {
      if (this.currentPath === "p2p") {
        this.flushPendingP2pBusinessMessages();
      }
    });
  }

  send(envelope: MessageEnvelope, channel?: P2pChannelKind): void {
    if (this.closed) {
      throw new Error("MobileSessionTransport is closed");
    }
    // strict 模式：业务消息在 P2P 未就绪前进入暂存队列，等 switchPath('p2p') 后 flush。
    // 控制面消息（tunnel.upgrade.* / transport.*）始终允许直接走当前路径。
    if (
      this.strictP2p &&
      this.currentPath !== "p2p" &&
      !isStrictControlMessage(envelope.type)
    ) {
      if (this.forceClosed) {
        // session 已经被 strict force_close，业务上层会重连重发；这里直接静默丢弃。
        this.emitEvent({
          type: "strict_send_blocked",
          envelope_type: envelope.type,
        });
        return;
      }
      // 暂存队列上限保护：超过 STRICT_PENDING_QUEUE_LIMIT 视作协商窗口异常，
      // 直接 forceClose 让上层重建 session，避免后续 flush 触发 buffered_overflow。
      if (this.strictPendingQueue.length >= STRICT_PENDING_QUEUE_LIMIT) {
        const dropped = this.strictPendingQueue.length;
        this.strictPendingQueue = [];
        this.emitEvent({
          type: "pending_drop",
          reason: "queue_overflow",
          count: dropped,
        });
        this.forceClose("strict_pending_overflow");
        return;
      }
      this.queuePendingBusinessSend(envelope, channel);
      return;
    }
    if (this.outboundQueue) {
      this.outboundQueue.push({ envelope, channel });
      return;
    }
    this.dispatchSend(envelope, channel);
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onPathChange(handler: PathChangeHandler): () => void {
    this.pathChangeHandlers.add(handler);
    return () => {
      this.pathChangeHandlers.delete(handler);
    };
  }

  onEvent(handler: TransportEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  getCurrentPath(): TransportPath {
    return this.currentPath;
  }

  /**
   * 释放传输层所有资源（detach peer、清队列、清监听器）。
   *
   * 与 `forceClose` 正交：`close` 表示"上层主动结束 transport 生命周期"
   * （比如 wiring 切偏好重建、App 退出），不会再触发 forceCloseHandler；
   * `forceClose` 表示"strict 模式下 session 不可用"，会 emit force_close
   * 事件并通知 forceCloseHandler 让上层清理 session。两者的共同清理动作
   * （detach peer / 清 strictPendingQueue / 清 outboundQueue）保持一致。
   *
   * 若 close 时 strictPendingQueue 仍有未 flush 的业务消息，会先发出
   * `pending_drop(reason="session_close")` 事件让上层有机会记录/告警。
   */
  close(_reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.detachP2pPeer();
    if (this.strictPendingQueue.length > 0) {
      const dropped = this.strictPendingQueue.length;
      this.strictPendingQueue = [];
      this.emitEvent({
        type: "pending_drop",
        reason: "session_close",
        count: dropped,
      });
    }
    this.messageHandlers.clear();
    this.pathChangeHandlers.clear();
    this.eventHandlers.clear();
    this.outboundQueue = null;
  }

  onClose(handler: (event: RelayCloseEvent) => void): () => void {
    return this.relayPath.onClose(handler);
  }

  attachP2pPeer(
    peer: WebRtcPeerAdapter,
    options: AttachP2pPeerOptions = {},
  ): void {
    this.detachP2pPeer();
    this.peer = peer;
    this.downgradeHandler = options.onDowngrade ?? null;
    this.upgradeId = options.upgradeId ?? null;

    const offMessage = peer.onDataMessage((data) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(data);
      } catch {
        decoded = null;
      }
      const envelope = parseMessageEnvelope(decoded);
      if (!envelope) {
        return;
      }
      if (envelope.type === "transport.ping") {
        this.handleIncomingPing(
          envelope as MessageEnvelope<TransportPingPayload>,
        );
        return;
      }
      if (envelope.type === "transport.pong") {
        this.handleIncomingPong(
          envelope as MessageEnvelope<TransportPongPayload>,
        );
        return;
      }
      this.relayPath.receiveFromP2p(envelope);
    });
    const offState = peer.onStateChange((state) => {
      if (state === "failed") {
        this.handleHealthDowngrade("ice_failed");
        return;
      }
      if (state === "disconnected") {
        this.armIceDisconnectedTimer();
        return;
      }
      if (state === "connected") {
        this.clearIceDisconnectedTimer();
        return;
      }
      if (state === "closed") {
        if (this.currentPath === "p2p") {
          this.handleHealthDowngrade("peer_closed");
        } else {
          this.detachP2pPeer();
        }
      }
    });
    this.detachPeerListeners = () => {
      offMessage();
      offState();
    };
  }

  detachP2pPeer(): void {
    this.stopPingLoop();
    this.stopBufferedSampler();
    this.clearIceDisconnectedTimer();
    if (this.detachPeerListeners) {
      this.detachPeerListeners();
      this.detachPeerListeners = null;
    }
    this.peer = null;
    this.downgradeHandler = null;
    this.upgradeId = null;
  }

  /**
   * 由外部（例如 AppState background）调用，主动触发降级；
   * 等价于内部健康检查触发的 downgrade，确保事件统计与 onDowngrade 调用路径一致。
   */
  forceDowngrade(reason: string): void {
    this.handleHealthDowngrade(reason);
  }

  /**
   * strict 模式下"严格 P2P 不可用"的唯一统一入口。所有触发源都汇聚到这里：
   *
   * 1. coordinator 协商失败（peer_unavailable / timeout / create_offer_failed
   *    等）→ wiring 经 onForceClose → 调本方法
   * 2. transport 运行期健康降级（pong_timeout / buffered_overflow / ice_failed
   *    / ice_disconnected / peer_closed）→ handleHealthDowngrade 调本方法
   * 3. Relay 主动下发 `tunnel.upgrade.downgrade(reason="strict_unavailable:*")`
   *    → wiring 路由分支调本方法
   * 4. dispatchSend 检测到 strict + currentPath==='p2p' + peer===null 的脱钩
   *    状态 → 调本方法（reason="peer_missing"）
   *
   * 本方法负责完成所有清理 / 通知职责：
   * - 通过 downgradeHandler 让 coordinator 发出 `tunnel.upgrade.downgrade`
   *   给 Relay 用于 metrics + backoff（idempotent：coordinator 已是 idle 时
   *   会自行 return）
   * - emit `force_close` 事件供业务层日志
   * - detach peer / 完整 reset 路径状态 / 清空 strictPendingQueue（非空时
   *   emit `pending_drop`）
   * - 通知 forceCloseHandler 让上层（App.tsx）清理 session
   *
   * 非 strict 模式调用本方法直接 no-op。多次调用幂等（forceClosed 标记）。
   */
  forceClose(reason: string): void {
    if (!this.strictP2p) {
      return;
    }
    if (this.forceClosed) {
      return;
    }
    this.forceClosed = true;
    // 先取出 downgradeHandler，detachP2pPeer 会把它清成 null。
    const downgradeHandler = this.downgradeHandler;
    this.emitEvent({ type: "force_close", reason });
    // detach peer + 完整 reset 路径状态（含 currentPath 切回 relay、清空
    // outboundQueue / switching），让 transport 处于"刚创建未升级"的初始态；
    // 后续 mobile 重连或上层重建 session 时不会落入"currentPath==='p2p'
    // 但 peer===null"的奇怪状态。
    this.detachP2pPeer();
    this.resetPathState();
    if (this.strictPendingQueue.length > 0) {
      const dropped = this.strictPendingQueue.length;
      this.strictPendingQueue = [];
      this.emitEvent({
        type: "pending_drop",
        reason: "force_close",
        count: dropped,
      });
    }
    // 让 coordinator 发出 tunnel.upgrade.downgrade 给 Relay 用于 metrics + backoff。
    // coordinator.downgrade 是 idempotent，由 (1) 链路传入时 coordinator 已经
    // 处理过、再次调用会从 idle 状态直接 return；由 (2)/(3)/(4) 链路传入时
    // 这是首次发出。
    if (downgradeHandler) {
      try {
        downgradeHandler(reason);
      } catch (error) {
        console.warn(
          "[omniwork-mobile-transport] forceClose downgrade handler failed",
          { error: (error as Error)?.message },
        );
      }
    }
    if (this.forceCloseHandler) {
      try {
        this.forceCloseHandler(reason);
      } catch (error) {
        console.warn("[omniwork-mobile-transport] forceClose handler failed", {
          error: (error as Error)?.message,
        });
      }
    }
  }

  /**
   * 把 currentPath 切回 "relay" 并清掉切换/出站队列状态；用于 forceClose
   * 后让 transport 状态机回归初始态，避免后续 dispatchSend / switchPath
   * 因脏 currentPath 而落入错误分支。
   */
  private resetPathState(): void {
    this.outboundQueue = null;
    this.switching = false;
    if (this.currentPath !== "relay") {
      const previous = this.currentPath;
      this.currentPath = "relay";
      for (const handler of this.pathChangeHandlers) {
        handler("relay");
      }
      this.emitEvent({ type: "path_change", from: previous, to: "relay" });
    }
  }

  /**
   * AppState 进后台时调用：strict 模式下不能让 session 继续走 P2P，但
   * 也不算"协商失败"——只是暂停 ping/buffered 采样并标记 currentPath 回到 relay
   * 入口（业务消息仍受 strict 准入门保护，不会真的发到 relay）。
   * 前台恢复后由 resumeForForeground() 清理标记并等待 Relay 下一轮 propose。
   */
  pauseForBackground(): void {
    if (this.backgroundPaused || !this.strictP2p) {
      return;
    }
    this.backgroundPaused = true;
    this.detachP2pPeer();
    const previous = this.currentPath;
    if (previous !== "relay") {
      this.currentPath = "relay";
      for (const handler of this.pathChangeHandlers) {
        handler("relay");
      }
      this.emitEvent({ type: "path_change", from: previous, to: "relay" });
    }
    this.emitEvent({ type: "background_pause" });
  }

  resumeForForeground(): void {
    if (!this.backgroundPaused) {
      return;
    }
    this.backgroundPaused = false;
    this.emitEvent({ type: "background_resume" });
  }

  /**
   * 前台恢复 / 网络变化时主动放弃旧 P2P peer，等待 Relay 立即下发新 propose。
   * strict 模式下 currentPath 会标回 relay 入口，但业务消息仍受 strict 守门
   * 暂存，不会回退到 relay path 发送。
   */
  prepareForReconnect(reason: string): void {
    this.emitEvent({ type: "downgrade", reason });
    this.detachP2pPeer();
    this.resetPathState();
  }

  isStrictP2p(): boolean {
    return this.strictP2p;
  }

  isForceClosed(): boolean {
    return this.forceClosed;
  }

  async switchPath(target: TransportPath): Promise<void> {
    if (this.closed || this.currentPath === target || this.switching) {
      return;
    }
    if (target === "p2p" && !this.peer) {
      console.warn("[omniwork-mobile-transport] cannot switch to p2p: no peer");
      return;
    }
    // strict 模式下永远不允许把业务路径切回 relay；只能升级到 p2p。
    if (this.strictP2p && target === "relay") {
      console.warn(
        "[omniwork-mobile-transport] strict_p2p mode rejects switchPath('relay')",
      );
      return;
    }
    this.switching = true;
    this.outboundQueue = [];
    const previous = this.currentPath;
    try {
      await delay(DRAIN_DELAY_MS);
      this.currentPath = target;
      for (const handler of this.pathChangeHandlers) {
        handler(target);
      }
      this.emitEvent({ type: "path_change", from: previous, to: target });
      const queued = this.outboundQueue;
      this.outboundQueue = null;
      if (queued) {
        for (const item of queued) {
          this.dispatchSend(item.envelope, item.channel);
        }
      }
      if (target === "p2p") {
        this.startPingLoop();
        this.startBufferedSampler();
        // strict 模式下业务消息暂存队列在 P2P 就绪后一次性 flush。
        if (this.strictPendingQueue.length > 0) {
          this.flushPendingP2pBusinessMessages();
        }
      } else {
        this.stopPingLoop();
        this.stopBufferedSampler();
      }
    } finally {
      this.switching = false;
    }
  }

  private dispatchSend(
    envelope: MessageEnvelope,
    channel?: P2pChannelKind,
  ): void {
    if (this.currentPath === "p2p" && this.peer) {
      const encoded = this.relayPath.encodeForP2p(envelope);
      if (!encoded) {
        this.queuePendingBusinessSend(envelope, channel);
        return;
      }
      this.peer.send(
        JSON.stringify(encoded),
        channelForP2pEnvelope(envelope, encoded, channel),
      );
      return;
    }
    // strict 模式守门：currentPath 已经升到 p2p 但 peer 已被 detach（例如健康
    // 降级竞态、forceClose 后还没复位 currentPath）时，绝不允许 fallback 到
    // relay——这会让"业务消息只走 DataChannel"的契约破产。直接发出 force_close
    // 并丢弃当前消息，由上层重建 session。
    if (this.strictP2p && this.currentPath === "p2p" && !this.peer) {
      this.emitEvent({
        type: "strict_send_blocked",
        envelope_type: envelope.type,
      });
      this.forceClose("peer_missing");
      return;
    }
    this.relayPath.send(envelope);
  }

  private queuePendingBusinessSend(
    envelope: MessageEnvelope,
    channel?: P2pChannelKind,
  ): void {
    if (this.strictPendingQueue.length >= STRICT_PENDING_QUEUE_LIMIT) {
      const dropped = this.strictPendingQueue.length;
      this.strictPendingQueue = [];
      this.emitEvent({
        type: "pending_drop",
        reason: "queue_overflow",
        count: dropped,
      });
      this.forceClose("strict_pending_overflow");
      return;
    }
    this.strictPendingQueue.push({ envelope, channel });
  }

  private flushPendingP2pBusinessMessages(): void {
    const pending = this.strictPendingQueue;
    this.strictPendingQueue = [];
    for (const item of pending) {
      this.dispatchSend(item.envelope, item.channel);
    }
  }

  private dispatch(message: MessageEnvelope): void {
    if (this.closed) {
      return;
    }
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  // ---- ping/pong ----

  private startPingLoop(): void {
    if (this.pingTimer || !this.peer) {
      return;
    }
    this.pongTimeoutCount = 0;
    const interval = this.strictP2p
      ? STRICT_PING_INTERVAL_MS
      : PING_INTERVAL_MS;
    this.pingTimer = setInterval(() => {
      this.sendPing();
    }, interval);
  }

  private stopPingLoop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const entry of this.pendingPings.values()) {
      clearTimeout(entry.timeout);
    }
    this.pendingPings.clear();
    this.pongTimeoutCount = 0;
  }

  private sendPing(): void {
    if (!this.peer || this.currentPath !== "p2p") {
      return;
    }
    const seq = ++this.pingSeq;
    const sentAt = Date.now();
    const envelope = createMessage<TransportPingPayload>("transport.ping", {
      upgrade_id: this.upgradeId ?? undefined,
      seq,
      sent_at: new Date(sentAt).toISOString(),
    });
    try {
      this.peer.send(JSON.stringify(envelope), "control");
    } catch {
      /* ignore */
    }
    const timeoutMs = this.strictP2p ? STRICT_PING_TIMEOUT_MS : PING_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      this.handlePongTimeout(seq);
    }, timeoutMs);
    this.pendingPings.set(seq, { sentAt, timeout });
  }

  private handleIncomingPing(
    envelope: MessageEnvelope<TransportPingPayload>,
  ): void {
    if (!this.peer || this.currentPath !== "p2p") {
      return;
    }
    const reply = createMessage<TransportPongPayload>("transport.pong", {
      upgrade_id: envelope.payload.upgrade_id,
      seq: envelope.payload.seq,
      sent_at: envelope.payload.sent_at,
      received_at: new Date().toISOString(),
    });
    try {
      this.peer.send(JSON.stringify(reply), "control");
    } catch {
      /* ignore */
    }
  }

  private handleIncomingPong(
    envelope: MessageEnvelope<TransportPongPayload>,
  ): void {
    const seq = envelope.payload.seq;
    const pending = this.pendingPings.get(seq);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingPings.delete(seq);
    this.pongTimeoutCount = 0;
    const rtt = Date.now() - pending.sentAt;
    this.emitEvent({ type: "pong_received", seq, rtt_ms: rtt });
  }

  private handlePongTimeout(seq: number): void {
    const pending = this.pendingPings.get(seq);
    if (!pending) {
      return;
    }
    this.pendingPings.delete(seq);
    const timeoutMs = this.strictP2p ? STRICT_PING_TIMEOUT_MS : PING_TIMEOUT_MS;
    const stallGraceMs = this.strictP2p
      ? STRICT_PING_TIMER_STALL_GRACE_MS
      : PING_TIMER_STALL_GRACE_MS;
    if (Date.now() - pending.sentAt > timeoutMs + stallGraceMs) {
      // JS 线程被 GC / 后台恢复 / 长任务卡住时，timeout 回调会延迟触发。
      // 这种情况先丢弃本次探测，等待下一轮 ping 验证，避免误判链路死亡。
      return;
    }
    this.pongTimeoutCount += 1;
    this.emitEvent({
      type: "ping_timeout",
      seq,
      count: this.pongTimeoutCount,
    });
    if (
      this.pongTimeoutCount >=
      (this.strictP2p ? STRICT_PING_TIMEOUT_THRESHOLD : PING_TIMEOUT_THRESHOLD)
    ) {
      this.handleHealthDowngrade("pong_timeout");
    }
  }

  // ---- bufferedAmount sampler ----

  private startBufferedSampler(): void {
    if (this.bufferedSampleTimer || !this.peer) {
      return;
    }
    this.bufferedOverflowSeconds = 0;
    this.bufferedSampleTimer = setInterval(() => {
      this.sampleBufferedAmount();
    }, BUFFERED_AMOUNT_SAMPLE_INTERVAL_MS);
  }

  private stopBufferedSampler(): void {
    if (this.bufferedSampleTimer) {
      clearInterval(this.bufferedSampleTimer);
      this.bufferedSampleTimer = null;
    }
    this.bufferedOverflowSeconds = 0;
  }

  private sampleBufferedAmount(): void {
    if (!this.peer) {
      return;
    }
    const amount = this.peer.getBufferedAmount();
    if (amount > BUFFERED_AMOUNT_LIMIT) {
      this.bufferedOverflowSeconds += 1;
      if (this.bufferedOverflowSeconds >= BUFFERED_AMOUNT_OVERFLOW_SECONDS) {
        this.handleHealthDowngrade("buffered_overflow");
      }
    } else {
      this.bufferedOverflowSeconds = 0;
    }
  }

  // ---- ICE disconnected grace ----

  private armIceDisconnectedTimer(): void {
    if (this.iceDisconnectedTimer) {
      return;
    }
    const graceMs = this.strictP2p
      ? STRICT_ICE_DISCONNECTED_GRACE_MS
      : ICE_DISCONNECTED_GRACE_MS;
    this.iceDisconnectedTimer = setTimeout(() => {
      this.iceDisconnectedTimer = null;
      this.handleHealthDowngrade("ice_disconnected");
    }, graceMs);
  }

  private clearIceDisconnectedTimer(): void {
    if (this.iceDisconnectedTimer) {
      clearTimeout(this.iceDisconnectedTimer);
      this.iceDisconnectedTimer = null;
    }
  }

  private handleHealthDowngrade(reason: string): void {
    if (this.currentPath !== "p2p") {
      return;
    }
    // strict 模式：升级后任何健康异常都不能回退到 relay，必须 forceClose。
    // forceClose 会经 downgradeHandler 让 coordinator 发出 tunnel.upgrade.downgrade
    // 用于 metrics + backoff，并完成 detach / pending_drop / forceCloseHandler。
    if (this.strictP2p) {
      this.emitEvent({ type: "downgrade", reason });
      this.forceClose(reason);
      return;
    }
    const handler = this.downgradeHandler;
    this.emitEvent({ type: "downgrade", reason });
    void this.switchPath("relay");
    this.detachP2pPeer();
    if (handler) {
      try {
        handler(reason);
      } catch (error) {
        console.warn("[omniwork-mobile-transport] downgrade handler failed", {
          error: (error as Error)?.message,
        });
      }
    }
  }

  private emitEvent(event: TransportEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        /* ignore */
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

function channelForP2pEnvelope(
  original: MessageEnvelope,
  encoded: MessageEnvelope,
  channel?: P2pChannelKind,
): P2pChannelKind {
  if (encoded.type === "e2e.message") {
    // Current E2E replay protection requires a single strictly ordered stream.
    return "control";
  }
  return channel ?? channelForEnvelope(original);
}
