import {
  createMessage,
  type IceServerConfig,
  type MessageEnvelope,
  type TransportPath,
  type TunnelUpgradeAnswerPayload,
  type TunnelUpgradeCandidatePayload,
  type TunnelUpgradeCommittedPayload,
  type TunnelUpgradeDowngradePayload,
  type TunnelUpgradeOfferPayload,
  type TunnelUpgradeProposePayload,
  type WebRtcPeerAdapter,
} from "@omniwork/protocol-ts";

export type UpgradeState =
  | "idle"
  | "proposed"
  | "negotiating"
  | "committing"
  | "upgraded"
  | "failed";

export type UpgradeRole = "offerer" | "answerer";

export interface UpgradePeerFactoryOptions {
  iceServers: IceServerConfig[];
  role: UpgradeRole;
}

export type UpgradePeerFactory = (
  opts: UpgradePeerFactoryOptions,
) => Promise<WebRtcPeerAdapter | null> | WebRtcPeerAdapter | null;

/**
 * UpgradeCoordinator 对外暴露的可观测事件，供业务层订阅打日志。
 * 与 SessionTransport.onEvent 聚焦健康/路径切换不同，这里聚焦"升级生命周期"。
 */
export type UpgradeCoordinatorEvent =
  | { type: "propose"; upgrade_id: string; role: UpgradeRole }
  | { type: "upgrade_success"; upgrade_id: string }
  | { type: "upgrade_failed"; upgrade_id: string | null; reason: string };

export type UpgradeCoordinatorEventHandler = (
  event: UpgradeCoordinatorEvent,
) => void;

export interface UpgradeCoordinatorOptions {
  role: UpgradeRole;
  peerFactory: UpgradePeerFactory;
  sendControl: (envelope: MessageEnvelope) => void;
  onSwitchPath: (path: TransportPath) => void;
  /**
   * 严格 P2P 模式下，协商失败/运行期降级不再回退到 Relay；
   * 改为调用此回调让 agentService 关闭并清理对应 session（forceClose）。
   * 调用前仍会向 Relay 发送 tunnel.upgrade.downgrade，仅用于 metrics + backoff。
   */
  onForceClose?: (reason: string) => void;
  deviceId: string;
  timeoutMs?: number;
}

interface TimerLike {
  ref?: () => unknown;
  unref?: () => unknown;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class UpgradeCoordinator {
  private readonly role: UpgradeRole;
  private readonly peerFactory: UpgradePeerFactory;
  private readonly sendControl: (envelope: MessageEnvelope) => void;
  private readonly onSwitchPath: (path: TransportPath) => void;
  private readonly onForceClose: ((reason: string) => void) | null;
  private readonly deviceId: string;
  private readonly timeoutMs: number;

  private state: UpgradeState = "idle";
  private peer: WebRtcPeerAdapter | null = null;
  private upgradeId: string | null = null;
  private appConnectionId: string | null = null;
  private strict = false;
  private localCommitted = false;
  private remoteCommitted = false;
  private negotiationTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly eventHandlers = new Set<UpgradeCoordinatorEventHandler>();
  private successEmitted = false;

  constructor(opts: UpgradeCoordinatorOptions) {
    this.role = opts.role;
    this.peerFactory = opts.peerFactory;
    this.sendControl = opts.sendControl;
    this.onSwitchPath = opts.onSwitchPath;
    this.onForceClose = opts.onForceClose ?? null;
    this.deviceId = opts.deviceId;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  getState(): UpgradeState {
    return this.state;
  }

  getPeer(): WebRtcPeerAdapter | null {
    return this.peer;
  }

  getUpgradeId(): string | null {
    return this.upgradeId;
  }

  /**
   * 订阅升级生命周期事件（propose / upgrade_success / upgrade_failed）。
   * 业务层通常在此打 info 日志，便于排查整次升级的成败。
   */
  onEvent(handler: UpgradeCoordinatorEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  close(): void {
    this.cleanupPeer();
    this.resetToIdle();
  }

  async propose(payload: TunnelUpgradeProposePayload): Promise<void> {
    if (this.state !== "idle") {
      console.warn(
        "[omniwork-upgrade] propose ignored: coordinator not idle",
        { state: this.state },
      );
      return;
    }

    this.upgradeId = payload.upgrade_id;
    this.appConnectionId = payload.app_connection_id;
    this.strict = payload.strict === true;
    this.state = "proposed";
    this.successEmitted = false;
    this.emitEvent({
      type: "propose",
      upgrade_id: payload.upgrade_id,
      role: this.role,
    });

    const peer = await this.peerFactory({
      iceServers: payload.ice_servers,
      role: this.role,
    });
    if (!peer) {
      this.fail("peer_unavailable");
      return;
    }
    this.attachPeer(peer);

    if (this.role === "offerer") {
      try {
        const sdp = await peer.createOffer();
        this.sendUpgrade<TunnelUpgradeOfferPayload>("tunnel.upgrade.offer", {
          upgrade_id: payload.upgrade_id,
          app_connection_id: payload.app_connection_id,
          sdp,
        });
        this.enterNegotiating();
      } catch (error) {
        console.warn("[omniwork-upgrade] createOffer failed", {
          error: (error as Error)?.message,
        });
        this.fail("create_offer_failed");
      }
    } else {
      // answerer 等 offer 到达后再进 negotiating
      this.enterNegotiating();
    }
  }

  async handleOffer(payload: TunnelUpgradeOfferPayload): Promise<void> {
    if (this.role !== "answerer") {
      return;
    }
    if (
      !this.peer ||
      this.upgradeId !== payload.upgrade_id ||
      this.appConnectionId !== payload.app_connection_id
    ) {
      console.warn("[omniwork-upgrade] offer ignored", {
        upgrade_id: payload.upgrade_id,
        current: this.upgradeId,
      });
      return;
    }
    try {
      await this.peer.setRemoteDescription(payload.sdp, "offer");
      const sdp = await this.peer.createAnswer();
      this.sendUpgrade<TunnelUpgradeAnswerPayload>(
        "tunnel.upgrade.answer",
        {
          upgrade_id: payload.upgrade_id,
          app_connection_id: payload.app_connection_id,
          sdp,
        },
      );
    } catch (error) {
      console.warn("[omniwork-upgrade] handleOffer failed", {
        error: (error as Error)?.message,
      });
      this.fail("handle_offer_failed");
    }
  }

  async handleAnswer(payload: TunnelUpgradeAnswerPayload): Promise<void> {
    if (this.role !== "offerer") {
      return;
    }
    if (
      !this.peer ||
      this.upgradeId !== payload.upgrade_id ||
      this.appConnectionId !== payload.app_connection_id
    ) {
      return;
    }
    try {
      await this.peer.setRemoteDescription(payload.sdp, "answer");
    } catch (error) {
      console.warn("[omniwork-upgrade] handleAnswer failed", {
        error: (error as Error)?.message,
      });
      this.fail("handle_answer_failed");
    }
  }

  async handleCandidate(
    payload: TunnelUpgradeCandidatePayload,
  ): Promise<void> {
    if (
      !this.peer ||
      this.upgradeId !== payload.upgrade_id ||
      this.appConnectionId !== payload.app_connection_id
    ) {
      return;
    }
    try {
      await this.peer.addIceCandidate({
        candidate: payload.candidate,
        sdpMid: payload.sdp_mid,
        sdpMLineIndex: payload.sdp_mline_index,
      });
    } catch (error) {
      console.warn("[omniwork-upgrade] addIceCandidate failed", {
        error: (error as Error)?.message,
      });
    }
  }

  handleCommitted(payload: TunnelUpgradeCommittedPayload): void {
    if (
      this.upgradeId !== payload.upgrade_id ||
      this.appConnectionId !== payload.app_connection_id
    ) {
      return;
    }
    this.remoteCommitted = true;
    this.maybeUpgrade();
  }

  localCommit(): void {
    if (
      !this.upgradeId ||
      this.state === "upgraded" ||
      this.state === "failed" ||
      this.state === "idle"
    ) {
      return;
    }
    if (this.localCommitted) {
      return;
    }
    this.localCommitted = true;
    this.state = "committing";
    this.sendUpgrade<TunnelUpgradeCommittedPayload>(
      "tunnel.upgrade.committed",
      {
        upgrade_id: this.upgradeId,
        app_connection_id: this.requireAppConnectionId(),
      },
    );
    this.maybeUpgrade();
  }

  downgrade(reason: string): void {
    if (this.state === "idle") {
      return;
    }
    const upgradeId = this.upgradeId;
    const strict = this.strict;
    if (upgradeId) {
      this.sendUpgrade<TunnelUpgradeDowngradePayload>(
        "tunnel.upgrade.downgrade",
        {
          upgrade_id: upgradeId,
          app_connection_id: this.requireAppConnectionId(),
          reason,
        },
      );
    }
    // 仅在尚未发出 upgrade_success 时认为是失败；升级成功后再降级算"运行期降级"，
    // 由 SessionTransport 的 downgrade 事件覆盖。
    if (!this.successEmitted) {
      this.emitEvent({
        type: "upgrade_failed",
        upgrade_id: upgradeId,
        reason,
      });
    }
    this.cleanupPeer();
    if (strict && this.onForceClose) {
      // 严格 P2P：失败/降级不回退 Relay，由上层 wiring 关闭并清理 session
      this.resetToIdle();
      try {
        this.onForceClose(reason);
      } catch (error) {
        console.warn("[omniwork-upgrade] onForceClose failed", {
          error: (error as Error)?.message,
        });
      }
      return;
    }
    this.onSwitchPath("relay");
    this.resetToIdle();
  }

  private fail(reason: string): void {
    this.state = "failed";
    this.downgrade(reason);
  }

  private attachPeer(peer: WebRtcPeerAdapter): void {
    this.peer = peer;
    peer.onLocalCandidate((c) => {
      if (!this.upgradeId) {
        return;
      }
      this.sendUpgrade<TunnelUpgradeCandidatePayload>(
        "tunnel.upgrade.candidate",
        {
          upgrade_id: this.upgradeId,
          app_connection_id: this.requireAppConnectionId(),
          candidate: c.candidate,
          sdp_mid: c.sdpMid,
          sdp_mline_index: c.sdpMLineIndex,
        },
      );
    });
    peer.onStateChange((state) => {
      if (state === "connected") {
        this.localCommit();
      } else if (
        state === "failed" ||
        state === "disconnected" ||
        state === "closed"
      ) {
        if (this.state !== "upgraded" && this.state !== "idle") {
          this.downgrade("peer_state");
        }
      }
    });
  }

  private enterNegotiating(): void {
    if (this.state !== "negotiating") {
      this.state = "negotiating";
    }
    this.armTimeout();
  }

  private armTimeout(): void {
    this.clearTimeout();
    const timer = setTimeout(() => {
      if (this.state !== "upgraded" && this.state !== "idle") {
        console.warn("[omniwork-upgrade] timeout", {
          state: this.state,
          upgrade_id: this.upgradeId,
        });
        this.downgrade("timeout");
      }
    }, this.timeoutMs);
    // 在 Node 中允许进程提前退出
    const handle = timer as unknown as TimerLike;
    handle.unref?.();
    this.negotiationTimer = timer;
  }

  private clearTimeout(): void {
    if (this.negotiationTimer) {
      clearTimeout(this.negotiationTimer);
      this.negotiationTimer = null;
    }
  }

  private maybeUpgrade(): void {
    if (this.localCommitted && this.remoteCommitted) {
      this.state = "upgraded";
      this.clearTimeout();
      const upgradeId = this.upgradeId;
      // 先触发路径切换，再 emit upgrade_success：让订阅方观察到 success 时
      // transport 已经在切到 p2p（path_change 已触发或正在 drain），避免出现
      // "success 但 currentPath 仍是 relay"的中间态语义。
      this.onSwitchPath("p2p");
      if (upgradeId && !this.successEmitted) {
        this.successEmitted = true;
        this.emitEvent({ type: "upgrade_success", upgrade_id: upgradeId });
      }
    }
  }

  private cleanupPeer(): void {
    this.clearTimeout();
    if (this.peer) {
      try {
        this.peer.close();
      } catch {
        /* ignore */
      }
      this.peer = null;
    }
  }

  private resetToIdle(): void {
    this.state = "idle";
    this.upgradeId = null;
    this.appConnectionId = null;
    this.strict = false;
    this.localCommitted = false;
    this.remoteCommitted = false;
  }

  private sendUpgrade<TPayload>(
    type:
      | "tunnel.upgrade.offer"
      | "tunnel.upgrade.answer"
      | "tunnel.upgrade.candidate"
      | "tunnel.upgrade.committed"
      | "tunnel.upgrade.downgrade",
    payload: TPayload,
  ): void {
    try {
      this.sendControl(
        createMessage<TPayload>(type, payload, { device_id: this.deviceId }),
      );
    } catch (error) {
      console.warn("[omniwork-upgrade] send control failed", {
        type,
        error: (error as Error)?.message,
      });
    }
  }

  private requireAppConnectionId(): string {
    if (!this.appConnectionId) {
      throw new Error("Missing app_connection_id for P2P upgrade.");
    }
    return this.appConnectionId;
  }

  private emitEvent(event: UpgradeCoordinatorEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        /* ignore */
      }
    }
  }
}
