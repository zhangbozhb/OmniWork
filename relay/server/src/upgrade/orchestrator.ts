import { createHash, randomUUID } from "node:crypto";

import {
  createMessage,
  type IceServerConfig,
  type MessageEnvelope,
  type TransportPreference,
  type TunnelUpgradeDowngradePayload,
  type TunnelUpgradeProposePayload,
} from "@omniwork/protocol-ts";

/**
 * Orchestrator 关注的最小连接抽象：仅需 connection id 与可选 device id。
 * 这样 orchestrator 不依赖具体 socket 实现。
 *
 * `transportPreference` 由 mobile.connect 阶段缓存到 RelayConnection 上，
 * orchestrator 守门时按 auto / relay_only / prefer_p2p 三态调整策略。
 */
export interface UpgradeOrchestratorConnection {
  id: string;
  deviceId?: string;
  transportPreference?: TransportPreference;
}

/**
 * Orchestrator 配置。
 * - enabled: 全局开关；关闭时不会发起任何 upgrade。
 * - rolloutPercent: 灰度百分比 (0..100)，按 device_id sha1 哈希。
 * - deviceBlocklist: 永不参与升级的 device_id 集合。
 * - iceServers: propose 阶段下发给 App/Agent 的 STUN/TURN 列表。
 * - proposeDelayMs: 鉴权完成后的稳定窗口；默认 3000ms。
 * - respectClientPreference: 是否尊重 App 端 transport_preference；默认 true。
 */
export interface UpgradeOrchestratorConfig {
  enabled: boolean;
  rolloutPercent: number;
  deviceBlocklist: Set<string>;
  iceServers: IceServerConfig[];
  proposeDelayMs: number;
  respectClientPreference: boolean;
}

interface BackoffEntry {
  failures: number;
  nextAvailableAt: number;
}

interface InFlightEntry {
  deviceId: string;
  appConnectionId: string;
  mobileConnectionId: string;
  agentConnectionId: string;
  startedAt: number;
  committedCount: number;
}

interface OrchestratorMetricsState {
  proposed: number;
  committed: number;
  failed: Record<string, number>;
  downgrade: Record<string, number>;
  /** 按 transport_preference 三态统计 mobile 鉴权后落到 orchestrator 的次数。 */
  prefs: Record<TransportPreference, number>;
  /** 因 transport_preference=relay_only 而跳过 propose 的次数。 */
  skipped_by_pref: number;
}

export interface UpgradeDurationStats {
  count: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
}

export interface OrchestratorMetricsSnapshot extends OrchestratorMetricsState {
  in_flight: number;
  active_p2p: number;
  durations: UpgradeDurationStats;
}

/**
 * 保留最近 N 次升级耗时（committed 双端确认 - propose 时刻），
 * 仅用于 /metrics 输出 p50/p95/max；超过窗口大小后丢弃最旧值。
 */
const UPGRADE_DURATION_WINDOW = 100;
const BACKOFF_EXEMPT_REASONS = new Set([
  "app_background",
  "foreground_resume",
  "network_changed",
  "client_closing",
]);

export interface RelayUpgradeOrchestratorOptions {
  config: UpgradeOrchestratorConfig;
  /** 通过外部注入的发送函数，避免 orchestrator 与底层 socket 实现耦合。 */
  send: (
    connection: UpgradeOrchestratorConnection,
    envelope: MessageEnvelope,
  ) => void;
  /** 通过 device_id 查找 agent 连接（定时器触发时需要）。 */
  getAgent: (deviceId: string) => UpgradeOrchestratorConnection | undefined;
  /** 用于测试注入的时钟。 */
  now?: () => number;
}

/**
 * Relay 端的升级编排器：
 * - 监听 mobile 鉴权成功事件，按灰度 / 退避 / 黑名单决定是否发起 upgrade
 * - 透传 committed/downgrade 控制消息更新统计与退避
 * - 提供 metrics 快照用于 /metrics endpoint
 */
export class RelayUpgradeOrchestrator {
  private readonly config: UpgradeOrchestratorConfig;
  private readonly sendFn: RelayUpgradeOrchestratorOptions["send"];
  private readonly getAgent: RelayUpgradeOrchestratorOptions["getAgent"];
  private readonly nowFn: () => number;

  private readonly sessionTimers = new Map<string, NodeJS.Timeout>();
  private readonly backoffByApp = new Map<string, BackoffEntry>();
  private readonly inFlightUpgrades = new Map<string, InFlightEntry>();
  /** 当前已完成升级（双端 committed）且尚未降级的 App 连接集合。 */
  private readonly activeP2pApps = new Set<string>();
  /** 最近 N 次升级耗时（毫秒），FIFO 截断。 */
  private readonly upgradeSessionDurations: number[] = [];
  private readonly metrics: OrchestratorMetricsState = {
    proposed: 0,
    committed: 0,
    failed: {},
    downgrade: {},
    prefs: { auto: 0, relay_only: 0, prefer_p2p: 0 },
    skipped_by_pref: 0,
  };

  constructor(options: RelayUpgradeOrchestratorOptions) {
    this.config = options.config;
    this.sendFn = options.send;
    this.getAgent = options.getAgent;
    this.nowFn = options.now ?? Date.now;
  }

  /**
   * mobile 鉴权成功后调用：判定是否在 proposeDelayMs 后触发 upgrade。
   * 不通过的原因（enabled/灰度/blocklist/退避/客户端偏好）会被静默忽略，
   * 但客户端偏好会写入 metrics.prefs / metrics.skipped_by_pref 供观测。
   */
  notifyMobileAuthenticated(
    deviceId: string,
    mobile: UpgradeOrchestratorConnection,
  ): void {
    const preference = this.resolvePreference(mobile);
    this.metrics.prefs[preference] += 1;

    if (!this.config.enabled) {
      // strict (prefer_p2p) 偏好下，全局开关关闭也意味着"无法升级 P2P"——
      // 必须主动下发 downgrade 让 mobile 立即触发 forceClose，避免业务消息
      // 持续暂存到 strictPendingQueue 直到超时。
      this.notifyStrictUnavailable(
        deviceId,
        mobile,
        preference,
        "relay_disabled",
      );
      return;
    }
    if (this.config.deviceBlocklist.has(deviceId)) {
      this.notifyStrictUnavailable(deviceId, mobile, preference, "blocklisted");
      return;
    }

    if (preference === "relay_only") {
      // App 显式禁用 P2P 升级：跳过 propose，不退避不计 metrics 失败。
      this.metrics.skipped_by_pref += 1;
      return;
    }

    if (
      preference !== "prefer_p2p" &&
      !shouldRollout(deviceId, this.config.rolloutPercent)
    ) {
      // auto 模式继续走灰度；prefer_p2p 跳过 rollout 守门，
      // 但仍受 enabled / blocklist / backoff 约束。
      return;
    }

    const appKey = sessionKey(deviceId, mobile.id);
    const backoff = this.backoffByApp.get(appKey);
    if (backoff && backoff.nextAvailableAt > this.nowFn()) {
      this.notifyStrictUnavailable(
        deviceId,
        mobile,
        preference,
        "backoff_active",
      );
      return;
    }

    const key = appKey;
    const existing = this.sessionTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.sessionTimers.delete(key);
      const agent = this.getAgent(deviceId);
      if (!agent) {
        return;
      }
      // 触发前再校验一次退避，避免 propose 期间被 recordFailure 推迟。
      const current = this.backoffByApp.get(appKey);
      if (current && current.nextAvailableAt > this.nowFn()) {
        return;
      }
      this.triggerUpgrade(deviceId, mobile, agent, preference === "prefer_p2p");
    }, this.config.proposeDelayMs);
    this.sessionTimers.set(key, timer);
  }

  /**
   * 根据 respectClientPreference 配置和 mobile 的 transportPreference 字段
   * 解析最终生效偏好。客户端缺省值为 "auto"。
   */
  private resolvePreference(
    mobile: UpgradeOrchestratorConnection,
  ): TransportPreference {
    if (!this.config.respectClientPreference) {
      return "auto";
    }
    return mobile.transportPreference ?? "auto";
  }

  /**
   * mobile 断开：清理 pending timer 与 in-flight 中相关条目。
   */
  notifyMobileDisconnected(
    deviceId: string,
    mobile: UpgradeOrchestratorConnection,
  ): void {
    const key = sessionKey(deviceId, mobile.id);
    const timer = this.sessionTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.sessionTimers.delete(key);
    }
    for (const [upgradeId, entry] of this.inFlightUpgrades) {
      if (
        entry.deviceId === deviceId &&
        entry.mobileConnectionId === mobile.id
      ) {
        this.inFlightUpgrades.delete(upgradeId);
      }
    }
    // mobile 断开 = 该 App 连接的 P2P 链路必然失效；仅清理 active_p2p 状态，
    // 不计入 downgrade 统计（断线不是协议层降级；下次 mobile 连上后会重新走 propose）。
    this.activeP2pApps.delete(key);
  }

  /**
   * agent 断开：清理 in-flight 中该 device 的所有条目；
   * 同时清理还未到期的 mobile pending timers（agent 不在线再 propose 也无意义）。
   */
  notifyAgentDisconnected(deviceId: string): void {
    for (const [upgradeId, entry] of this.inFlightUpgrades) {
      if (entry.deviceId === deviceId) {
        this.inFlightUpgrades.delete(upgradeId);
      }
    }
    const prefix = `${deviceId}|`;
    for (const [key, timer] of this.sessionTimers) {
      if (key.startsWith(prefix)) {
        clearTimeout(timer);
        this.sessionTimers.delete(key);
      }
    }
    for (const key of [...this.activeP2pApps]) {
      if (key.startsWith(prefix)) {
        this.activeP2pApps.delete(key);
      }
    }
  }

  /**
   * App 端在前台恢复或网络变化时调用：清理该 App 连接的 P2P 退避，并在
   * E2E/agent 已就绪时立即发起新一轮 propose，避免等待下一次被动触发。
   */
  handleConnectivityChanged(
    deviceId: string,
    mobile: UpgradeOrchestratorConnection,
  ): string | null {
    const preference = this.resolvePreference(mobile);
    const appKey = sessionKey(deviceId, mobile.id);
    this.backoffByApp.delete(appKey);
    this.activeP2pApps.delete(appKey);

    if (!this.config.enabled) {
      this.notifyStrictUnavailable(
        deviceId,
        mobile,
        preference,
        "relay_disabled",
      );
      return null;
    }
    if (this.config.deviceBlocklist.has(deviceId)) {
      this.notifyStrictUnavailable(deviceId, mobile, preference, "blocklisted");
      return null;
    }
    if (preference === "relay_only") {
      return null;
    }
    if (
      preference !== "prefer_p2p" &&
      !shouldRollout(deviceId, this.config.rolloutPercent)
    ) {
      return null;
    }
    if (this.hasInFlightForApp(deviceId, mobile.id)) {
      return null;
    }
    const agent = this.getAgent(deviceId);
    if (!agent) {
      return null;
    }
    return this.triggerUpgrade(deviceId, mobile, agent, preference === "prefer_p2p");
  }

  /**
   * 处理 Relay 透传的 tunnel.upgrade.committed / tunnel.upgrade.downgrade。
   * 其他升级控制消息（offer/answer/candidate）不会进入 metrics 统计。
   */
  handleControlMessage(message: MessageEnvelope): void {
    if (message.type === "tunnel.upgrade.committed") {
      const upgradeId = (message.payload as { upgrade_id?: string })
        ?.upgrade_id;
      if (!upgradeId) {
        return;
      }
      this.metrics.committed += 1;
      const entry = this.inFlightUpgrades.get(upgradeId);
      if (!entry) {
        return;
      }
      entry.committedCount += 1;
      if (entry.committedCount >= 2) {
        const durationMs = this.nowFn() - entry.startedAt;
        this.recordDuration(durationMs);
        this.activeP2pApps.add(sessionKey(entry.deviceId, entry.appConnectionId));
        this.inFlightUpgrades.delete(upgradeId);
        // 双端确认升级成功 → 重置该 App 连接的退避。
        this.backoffByApp.delete(sessionKey(entry.deviceId, entry.appConnectionId));
      }
      return;
    }

    if (message.type === "tunnel.upgrade.downgrade") {
      const payload = message.payload as {
        upgrade_id?: string;
        app_connection_id?: string;
        reason?: string;
      };
      const upgradeId = payload?.upgrade_id;
      const reason = payload?.reason ?? "unknown";
      let deviceId: string | undefined = message.device_id;
      if (upgradeId) {
        const entry = this.inFlightUpgrades.get(upgradeId);
        if (entry) {
          deviceId = entry.deviceId;
          this.inFlightUpgrades.delete(upgradeId);
        }
      }
      this.metrics.downgrade[reason] =
        (this.metrics.downgrade[reason] ?? 0) + 1;
      if (deviceId) {
        const appConnectionId = payload?.app_connection_id;
        // 既可能是协商期失败、也可能是运行期主动降级；两种情况都要清理 active_p2p。
        if (appConnectionId) {
          this.activeP2pApps.delete(sessionKey(deviceId, appConnectionId));
        }
        // client_closing 是用户主动行为（切换 transport_preference、退出账号
        // 等触发 App 端 transport.close 时主动通知对端的礼貌降级），不是协议
        // 失败；不应纳入 backoff 表，否则 prefer_p2p ↔ relay_only 反复切换时
        // 第二次切回 prefer_p2p 会落入 backoff_active 永远不发 propose，
        // strict 模式下业务消息全部堆积在 strictPendingQueue 触发 UI 卡死。
        if (!BACKOFF_EXEMPT_REASONS.has(reason)) {
          this.recordFailure(deviceId, reason, appConnectionId);
        }
      }
    }
  }

  /**
   * 记一次失败，并按文档 4.2 的退避表更新 backoffByApp：
   * 1 次 → 30s，2 次 → 2min，3 次 → 10min，4+ → MAX_SAFE_INTEGER。
   *
   */
  recordFailure(
    deviceId: string,
    reason: string,
    appConnectionId = "*",
  ): void {
    this.metrics.failed[reason] = (this.metrics.failed[reason] ?? 0) + 1;
    const key = sessionKey(deviceId, appConnectionId);
    const entry = this.backoffByApp.get(key) ?? {
      failures: 0,
      nextAvailableAt: 0,
    };
    entry.failures += 1;
    const now = this.nowFn();
    if (entry.failures === 1) {
      entry.nextAvailableAt = now + 30_000;
    } else if (entry.failures === 2) {
      entry.nextAvailableAt = now + 120_000;
    } else if (entry.failures === 3) {
      entry.nextAvailableAt = now + 600_000;
    } else {
      entry.nextAvailableAt = Number.MAX_SAFE_INTEGER;
    }
    this.backoffByApp.set(key, entry);
  }

  private hasInFlightForApp(deviceId: string, appConnectionId: string): boolean {
    for (const entry of this.inFlightUpgrades.values()) {
      if (
        entry.deviceId === deviceId &&
        entry.appConnectionId === appConnectionId
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * 直接发起一次 upgrade：向 mobile (offerer) + agent (answerer) 同时发 propose。
   * 返回生成的 upgrade_id；外部 /debug/upgrade 也通过此入口触发以纳入 metrics。
   *
   * `strict` 在 mobile 端 transport_preference="prefer_p2p" 时为 true，会被
   * 透传到双端 propose payload，触发严格 P2P 行为（详见协议 TunnelUpgradeProposePayload.strict）。
   */
  triggerUpgrade(
    deviceId: string,
    mobile: UpgradeOrchestratorConnection,
    agent: UpgradeOrchestratorConnection,
    strict = false,
  ): string {
    const upgradeId = randomUUID();
    const iceServers = this.config.iceServers;

    this.sendFn(
      mobile,
      createMessage<TunnelUpgradeProposePayload>(
        "tunnel.upgrade.propose",
        {
          upgrade_id: upgradeId,
          app_connection_id: mobile.id,
          ice_servers: iceServers,
          role: "offerer",
          ...(strict ? { strict: true } : {}),
        },
        { device_id: deviceId },
      ),
    );
    this.sendFn(
      agent,
      createMessage<TunnelUpgradeProposePayload>(
        "tunnel.upgrade.propose",
        {
          upgrade_id: upgradeId,
          app_connection_id: mobile.id,
          ice_servers: iceServers,
          role: "answerer",
          ...(strict ? { strict: true } : {}),
        },
        { device_id: deviceId },
      ),
    );

    this.inFlightUpgrades.set(upgradeId, {
      deviceId,
      appConnectionId: mobile.id,
      mobileConnectionId: mobile.id,
      agentConnectionId: agent.id,
      startedAt: this.nowFn(),
      committedCount: 0,
    });
    this.metrics.proposed += 1;
    return upgradeId;
  }

  /** 返回 metrics 快照（深拷贝），用于 /metrics endpoint。 */
  getMetrics(): OrchestratorMetricsSnapshot {
    return {
      proposed: this.metrics.proposed,
      committed: this.metrics.committed,
      failed: { ...this.metrics.failed },
      downgrade: { ...this.metrics.downgrade },
      prefs: { ...this.metrics.prefs },
      skipped_by_pref: this.metrics.skipped_by_pref,
      in_flight: this.inFlightUpgrades.size,
      active_p2p: this.activeP2pApps.size,
      durations: this.computeDurationStats(),
    };
  }

  /** 释放所有 timer，便于优雅关停或测试。 */
  dispose(): void {
    for (const timer of this.sessionTimers.values()) {
      clearTimeout(timer);
    }
    this.sessionTimers.clear();
    this.inFlightUpgrades.clear();
    this.activeP2pApps.clear();
  }

  /**
   * strict (transport_preference="prefer_p2p") 偏好下被 enabled / blocklist /
   * backoff 命中时，必须主动下发 tunnel.upgrade.downgrade(reason="strict_unavailable")
   * 给 mobile：mobile 端 upgradeCoordinator.downgrade() 会因 strict=false 不触发
   * forceClose，但 App 级 onMessage 路由会把它转成"严格 P2P 不可用"的 UI 提示。
   *
   * 同时记一笔 metrics.downgrade["strict_unavailable:<reason>"] 便于排查。
   */
  private notifyStrictUnavailable(
    deviceId: string,
    mobile: UpgradeOrchestratorConnection,
    preference: TransportPreference,
    cause: string,
  ): void {
    if (preference !== "prefer_p2p") {
      return;
    }
    const upgradeId = randomUUID();
    this.sendFn(
      mobile,
      createMessage<TunnelUpgradeDowngradePayload>(
        "tunnel.upgrade.downgrade",
        {
          upgrade_id: upgradeId,
          app_connection_id: mobile.id,
          reason: `strict_unavailable:${cause}`,
        },
        { device_id: deviceId },
      ),
    );
    const key = `strict_unavailable:${cause}`;
    this.metrics.downgrade[key] = (this.metrics.downgrade[key] ?? 0) + 1;
  }

  private recordDuration(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return;
    }
    this.upgradeSessionDurations.push(durationMs);
    if (this.upgradeSessionDurations.length > UPGRADE_DURATION_WINDOW) {
      this.upgradeSessionDurations.shift();
    }
  }

  private computeDurationStats(): UpgradeDurationStats {
    const samples = this.upgradeSessionDurations;
    if (samples.length === 0) {
      return { count: 0, p50_ms: 0, p95_ms: 0, max_ms: 0 };
    }
    const sorted = [...samples].sort((a, b) => a - b);
    return {
      count: sorted.length,
      p50_ms: percentile(sorted, 0.5),
      p95_ms: percentile(sorted, 0.95),
      max_ms: sorted[sorted.length - 1] ?? 0,
    };
  }
}

/**
 * 在已排序数组上计算分位数：使用最近邻取整，避免引入插值依赖。
 * sorted 必须升序且非空。
 */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length === 1) {
    return sorted[0] ?? 0;
  }
  const clamped = Math.min(1, Math.max(0, q));
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(clamped * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function sessionKey(deviceId: string, mobileConnectionId: string): string {
  return `${deviceId}|${mobileConnectionId}`;
}

/**
 * 灰度判定：sha1(deviceId) 前 4 字节作为 uint32，模 100 后与 percent 比较。
 * percent=0 → 永远不通过；percent=100 → 永远通过。
 */
export function shouldRollout(deviceId: string, percent: number): boolean {
  if (percent <= 0) {
    return false;
  }
  if (percent >= 100) {
    return true;
  }
  const digest = createHash("sha1").update(deviceId).digest();
  const bucket = digest.readUInt32BE(0) % 100;
  return bucket < percent;
}
