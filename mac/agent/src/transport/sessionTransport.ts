import {
  createMessage,
  type MessageEnvelope,
  type SessionTransport,
  type TransportPath,
  type TransportPingPayload,
  type TransportPongPayload,
  type WebRtcPeerAdapter,
} from "../../../../packages/protocol-ts/src/index.ts";
import type { AgentRelayPath } from "./relayPath.ts";

type MessageHandler = (envelope: MessageEnvelope) => void;
type PathChangeHandler = (path: TransportPath) => void;
type DowngradeReasonHandler = (reason: string) => void;
type ForceCloseHandler = (reason: string) => void;
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
    };
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
const PING_TIMEOUT_MS = 1_000;
const PING_TIMEOUT_THRESHOLD = 3;
/**
 * strict 模式下心跳采用更宽松的阈值，避免 4G/5G 弱网偶发丢包就触发不可恢复的 forceClose。
 * - INTERVAL 缩短到 3s：仍然在合理范围内快速发现连接断裂；
 * - TIMEOUT 放宽到 3s：覆盖 RTT 较高的跨大洲 / 移动网络场景；
 * - THRESHOLD 提升到 5：单次成功收到 pong 即清零，连续 5 次未收到才算"真死"。
 */
const STRICT_PING_INTERVAL_MS = 3_000;
const STRICT_PING_TIMEOUT_MS = 3_000;
const STRICT_PING_TIMEOUT_THRESHOLD = 5;
const BUFFERED_AMOUNT_LIMIT = 1_000_000;
const BUFFERED_AMOUNT_SAMPLE_INTERVAL_MS = 1_000;
const BUFFERED_AMOUNT_OVERFLOW_SECONDS = 5;
const ICE_DISCONNECTED_GRACE_MS = 3_000;
/**
 * strict 模式下 ICE disconnected → connected 的容忍窗口拉长到 10s，
 * 避免移动端 LTE/Wi-Fi 漫游瞬间的 ICE 抖动直接 forceClose。
 */
const STRICT_ICE_DISCONNECTED_GRACE_MS = 10_000;
/**
 * strict 模式下 P2P 未就绪期间业务消息暂存队列的上限。超过此上限说明
 * 协商窗口异常长，继续累积只会让 flush 时 burst 写入 DataChannel 触发
 * buffered_overflow，直接 forceClose 让上层重建 session 更安全。
 */
const STRICT_PENDING_QUEUE_LIMIT = 256;

export interface AttachP2pPeerOptions {
  /**
   * 当传输层检测到需要降级（pong 超时 / bufferedAmount / ICE 异常）时回调，
   * 由外部（通常是 UpgradeCoordinator.downgrade）执行真正的协议降级动作。
   */
  onDowngrade?: DowngradeReasonHandler;
  /** 当前 upgrade_id，会写入 transport.ping 的 payload，便于 Relay/对端审计。 */
  upgradeId?: string;
}

export interface AgentSessionTransportOptions {
  /**
   * 严格 P2P 模式标记，由 mobile.connect.transport_preference="prefer_p2p"
   * 通过 tunnel.upgrade.propose.strict 透传。strict 模式下 transport 行为：
   * - 升级前 send() 拒绝业务消息（仅放行 tunnel.upgrade.* / transport.*）
   * - 升级后任何健康降级理由都改为 forceClose，不会切回 relay
   */
  strictP2p?: boolean;
  /**
   * strict 模式下 transport 触发"严格 P2P 失败"时调用，由上层（通常是
   * agentService）清理与该 mobile 相关的会话状态。
   */
  onForceClose?: ForceCloseHandler;
}

export class AgentSessionTransport implements SessionTransport {
  private readonly relayPath: AgentRelayPath;
  private currentPath: TransportPath = "relay";
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly pathChangeHandlers = new Set<PathChangeHandler>();
  private readonly eventHandlers = new Set<TransportEventHandler>();
  private closed = false;
  private peer: WebRtcPeerAdapter | null = null;
  private detachPeerListeners: (() => void) | null = null;
  private outboundQueue: MessageEnvelope[] | null = null;
  /**
   * 严格 P2P 模式下、currentPath !== "p2p" 时业务消息的暂存队列。
   * - 升级到 p2p 后由 switchPath() flush；
   * - forceClose / configureStrictP2p / close 时清空，由上层重建会话后再发。
   */
  private strictPendingQueue: MessageEnvelope[] = [];
  private switching = false;
  private downgradeHandler: DowngradeReasonHandler | null = null;
  private upgradeId: string | null = null;
  private strictP2p: boolean;
  private forceCloseHandler: ForceCloseHandler | null;
  private forceClosed = false;

  // Ping/pong 心跳状态
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

  // bufferedAmount 采样状态
  private bufferedSampleTimer: ReturnType<typeof setInterval> | null = null;
  private bufferedOverflowSeconds = 0;

  // ICE disconnected grace
  private iceDisconnectedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    relayPath: AgentRelayPath,
    options: AgentSessionTransportOptions = {},
  ) {
    this.relayPath = relayPath;
    this.strictP2p = options.strictP2p ?? false;
    this.forceCloseHandler = options.onForceClose ?? null;
    this.relayPath.onMessage((message) => this.dispatch(message));
  }

  /**
   * agent 端的 transport 复用同一实例横跨多次 mobile 连接：
   * 当协议层从 propose.strict 解析出新一轮 strict 模式时，需要在握手前
   * 把状态切到 strict；非 strict 时也要复位 forceClosed 标记，避免误判。
   *
   * 同时对 transport 运行期状态做完整 reset（detach peer / 切回 relay
   * path / 清空所有队列与计数），让本次 mobile 进入握手前状态机回归初始态，
   * 避免上一轮残留导致 switchPath 被 short-circuit 或 currentPath 与 peer
   * 脱钩等"虚连"问题。
   */
  configureStrictP2p(
    strictP2p: boolean,
    onForceClose: ForceCloseHandler | null = null,
  ): void {
    this.strictP2p = strictP2p;
    this.forceCloseHandler = onForceClose;
    this.forceClosed = false;
    this.detachP2pPeer();
    this.resetPathState();
    this.strictPendingQueue = [];
  }

  send(envelope: MessageEnvelope): void {
    if (this.closed) {
      throw new Error("AgentSessionTransport is closed");
    }
    if (
      this.strictP2p &&
      this.currentPath !== "p2p" &&
      !isStrictControlMessage(envelope.type)
    ) {
      if (this.forceClosed) {
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
      this.strictPendingQueue.push(envelope);
      return;
    }
    if (this.outboundQueue) {
      this.outboundQueue.push(envelope);
      return;
    }
    this.dispatchSend(envelope);
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
   * 释放传输层所有资源。与 `forceClose` 正交：`close` 表示"上层主动结束 transport
   * 生命周期"（agentService 退出 / relay 重建），不会触发 forceCloseHandler；
   * `forceClose` 表示"strict 模式下 session 不可用"，会 emit force_close 并
   * 通知 forceCloseHandler 让 agentService 清理对应 mobile 的 session 状态。
   *
   * 若 close 时 strictPendingQueue 非空，先发出 `pending_drop(reason="session_close")`
   * 让上层日志可见。
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

  attachP2pPeer(
    peer: WebRtcPeerAdapter,
    options: AttachP2pPeerOptions = {},
  ): void {
    this.detachP2pPeer();
    this.peer = peer;
    this.downgradeHandler = options.onDowngrade ?? null;
    this.upgradeId = options.upgradeId ?? null;

    const offMessage = peer.onDataMessage((data) => {
      let envelope: MessageEnvelope | null = null;
      try {
        envelope = JSON.parse(data) as MessageEnvelope;
      } catch {
        envelope = null;
      }
      if (!envelope) {
        return;
      }
      // ping/pong 是传输层内部消息，不进入业务分发。
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
      this.dispatch(envelope);
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

  async switchPath(target: TransportPath): Promise<void> {
    if (this.closed || this.currentPath === target || this.switching) {
      return;
    }
    if (target === "p2p" && !this.peer) {
      console.warn("[omniwork-agent-transport] cannot switch to p2p: no peer");
      return;
    }
    if (this.strictP2p && target === "relay") {
      console.warn(
        "[omniwork-agent-transport] strict_p2p mode rejects switchPath('relay')",
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
        for (const envelope of queued) {
          this.dispatchSend(envelope);
        }
      }
      if (target === "p2p") {
        this.startPingLoop();
        this.startBufferedSampler();
        // strict 模式下业务消息暂存队列在 P2P 就绪后一次性 flush。
        if (this.strictPendingQueue.length > 0) {
          const pending = this.strictPendingQueue;
          this.strictPendingQueue = [];
          for (const envelope of pending) {
            this.dispatchSend(envelope);
          }
        }
      } else {
        this.stopPingLoop();
        this.stopBufferedSampler();
      }
    } finally {
      this.switching = false;
    }
  }

  private dispatchSend(envelope: MessageEnvelope): void {
    if (this.currentPath === "p2p" && this.peer) {
      this.peer.send(JSON.stringify(envelope));
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
    const timer = setInterval(() => {
      this.sendPing();
    }, interval);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.pingTimer = timer;
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
      this.peer.send(JSON.stringify(envelope));
    } catch {
      /* ignore: 下次 timeout 会触发降级 */
    }
    const timeoutMs = this.strictP2p ? STRICT_PING_TIMEOUT_MS : PING_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      this.handlePongTimeout(seq);
    }, timeoutMs);
    (timeout as unknown as { unref?: () => void }).unref?.();
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
      this.peer.send(JSON.stringify(reply));
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
    const timer = setInterval(() => {
      this.sampleBufferedAmount();
    }, BUFFERED_AMOUNT_SAMPLE_INTERVAL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.bufferedSampleTimer = timer;
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
    const timer = setTimeout(() => {
      this.iceDisconnectedTimer = null;
      this.handleHealthDowngrade("ice_disconnected");
    }, graceMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.iceDisconnectedTimer = timer;
  }

  private clearIceDisconnectedTimer(): void {
    if (this.iceDisconnectedTimer) {
      clearTimeout(this.iceDisconnectedTimer);
      this.iceDisconnectedTimer = null;
    }
  }

  /**
   * strict 模式下"严格 P2P 不可用"的唯一统一入口。所有触发源都汇聚到这里：
   *
   * 1. coordinator 协商失败（peer_unavailable / timeout / handle_offer_failed
   *    等）→ agentService onForceClose → 调本方法
   * 2. transport 运行期健康降级（pong_timeout / buffered_overflow / ice_failed
   *    / ice_disconnected / peer_closed）→ handleHealthDowngrade 调本方法
   * 3. dispatchSend 检测到 strict + currentPath==='p2p' + peer===null 的脱钩
   *    状态 → 调本方法（reason="peer_missing"）
   *
   * 本方法负责完成所有清理 / 通知职责：
   * - 通过 downgradeHandler 让 coordinator 发出 `tunnel.upgrade.downgrade`
   *   给 Relay 用于 metrics + backoff（idempotent）
   * - emit `force_close` 事件 / detach peer / 完整 reset 路径状态
   * - strictPendingQueue 非空时 emit `pending_drop(reason="force_close")`
   * - 通知 forceCloseHandler 让 agentService 清理 mobile 关联会话
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
    const downgradeHandler = this.downgradeHandler;
    const forceCloseHandler = this.forceCloseHandler;
    this.emitEvent({ type: "force_close", reason });
    // detach peer + 完整 reset 路径状态：让 transport 处于"刚创建未升级"
    // 的初始态，避免下一轮 mobile 复连时 switchPath('p2p') 因 currentPath
    // 残留为 "p2p" 而被 short-circuit、或 dispatchSend 落入"无 peer 的
    // p2p path"分支。
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
    // strict 守门状态退出：本次 strict P2P 会话已经终结，transport 已回退到
    // relay path（mobile 端会用新偏好重连）。若不重置，下一轮 mobile 连接
    // 若选择 relay_only 偏好则不会触发 configureStrictP2p，残留的 strictP2p
    // + forceClosed 会让 send() 把 auth.ok / session.list 等业务消息当成
    // strict 期间需要暂存的非控制面消息，命中 strict_send_blocked 静默丢弃，
    // 表现为 App 端永远收不到 auth.ok、UI 卡在 Connecting。下一轮若仍是
    // prefer_p2p，propose 路径上的 configureStrictP2p 会重新置回 true。
    this.strictP2p = false;
    this.forceCloseHandler = null;
    if (downgradeHandler) {
      try {
        downgradeHandler(reason);
      } catch (error) {
        console.warn(
          "[omniwork-agent-transport] forceClose downgrade handler failed",
          { error: (error as Error)?.message },
        );
      }
    }
    if (forceCloseHandler) {
      try {
        forceCloseHandler(reason);
      } catch (error) {
        console.warn("[omniwork-agent-transport] forceClose handler failed", {
          error: (error as Error)?.message,
        });
      }
    }
  }

  /**
   * 把 currentPath 切回 "relay" 并清掉切换/出站队列状态；用于 forceClose
   * 与 configureStrictP2p 后让 transport 状态机回归初始态。
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

  isStrictP2p(): boolean {
    return this.strictP2p;
  }

  isForceClosed(): boolean {
    return this.forceClosed;
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
        console.warn("[omniwork-agent-transport] downgrade handler failed", {
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
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}
