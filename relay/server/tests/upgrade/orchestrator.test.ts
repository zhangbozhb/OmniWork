import { strict as assert } from "node:assert";
import { setTimeout as wait } from "node:timers/promises";

import {
  createMessage,
  type MessageEnvelope,
  type TunnelUpgradeCommittedPayload,
  type TunnelUpgradeDowngradePayload,
} from "@omniwork/protocol-ts";
import {
  RelayUpgradeOrchestrator,
  type UpgradeOrchestratorConfig,
  type UpgradeOrchestratorConnection,
} from "../../src/upgrade/orchestrator.ts";

interface SendCall {
  connection: UpgradeOrchestratorConnection;
  envelope: MessageEnvelope;
}

const buildBaseConfig = (
  overrides: Partial<UpgradeOrchestratorConfig> = {},
): UpgradeOrchestratorConfig => ({
  enabled: true,
  rolloutPercent: 100,
  deviceBlocklist: new Set(),
  iceServers: [{ urls: "stun:stun.example:19302" }],
  proposeDelayMs: 5,
  respectClientPreference: true,
  ...overrides,
});

const makeMobile = (id = "conn_mobile"): UpgradeOrchestratorConnection => ({
  id,
  deviceId: "device-123",
});
const makeAgent = (id = "conn_agent"): UpgradeOrchestratorConnection => ({
  id,
  deviceId: "device-123",
});

// 1. 触发条件：默认 enabled/rollout=100 → proposeDelayMs 后双端 propose
{
  const sends: SendCall[] = [];
  const agent = makeAgent();
  const orchestrator = new RelayUpgradeOrchestrator({
    config: buildBaseConfig(),
    send: (connection, envelope) => sends.push({ connection, envelope }),
    getAgent: () => agent,
  });

  const mobile = makeMobile();
  orchestrator.notifyMobileAuthenticated("device-123", mobile);
  await wait(30);
  assert.equal(sends.length, 2, "expected propose to mobile + agent");
  for (const call of sends) {
    assert.equal(call.envelope.type, "tunnel.upgrade.propose");
  }
  const roles = sends.map(
    (call) => (call.envelope.payload as { role: string }).role,
  );
  assert.deepEqual(roles.sort(), ["answerer", "offerer"]);
  assert.equal(orchestrator.getMetrics().proposed, 1);
  orchestrator.dispose();
}

// 2. enabled=false → 不触发
{
  const sends: SendCall[] = [];
  const orchestrator = new RelayUpgradeOrchestrator({
    config: buildBaseConfig({ enabled: false }),
    send: (connection, envelope) => sends.push({ connection, envelope }),
    getAgent: () => makeAgent(),
  });
  orchestrator.notifyMobileAuthenticated("device-123", makeMobile());
  await wait(20);
  assert.equal(sends.length, 0);
  orchestrator.dispose();
}

// 3. rolloutPercent=0 → 不触发
{
  const sends: SendCall[] = [];
  const orchestrator = new RelayUpgradeOrchestrator({
    config: buildBaseConfig({ rolloutPercent: 0 }),
    send: (connection, envelope) => sends.push({ connection, envelope }),
    getAgent: () => makeAgent(),
  });
  orchestrator.notifyMobileAuthenticated("device-123", makeMobile());
  await wait(20);
  assert.equal(sends.length, 0);
  orchestrator.dispose();
}

// 4. blocklist 命中 → 不触发
{
  const sends: SendCall[] = [];
  const orchestrator = new RelayUpgradeOrchestrator({
    config: buildBaseConfig({
      deviceBlocklist: new Set(["device-123"]),
    }),
    send: (connection, envelope) => sends.push({ connection, envelope }),
    getAgent: () => makeAgent(),
  });
  orchestrator.notifyMobileAuthenticated("device-123", makeMobile());
  await wait(20);
  assert.equal(sends.length, 0);
  orchestrator.dispose();
}

// 5. 退避计算：3 次后 nextAvailableAt > now+9min；4 次后 = MAX_SAFE_INTEGER
{
  let fakeNow = 1_000_000;
  const orchestrator = new RelayUpgradeOrchestrator({
    config: buildBaseConfig(),
    send: () => {},
    getAgent: () => undefined,
    now: () => fakeNow,
  });

  orchestrator.recordFailure("device-x", "ice_failed");
  orchestrator.recordFailure("device-x", "ice_failed");
  orchestrator.recordFailure("device-x", "ice_failed");
  // 通过 metrics 间接断言失败计数。
  assert.equal(orchestrator.getMetrics().failed.ice_failed, 3);

  // 用 reflective 访问 backoffByDevice 不便，改为构造场景：
  // 第 3 次失败应当是 +10min，下次可用时间应 > now+9min。
  // 用 notifyMobileAuthenticated 在 9min 内不该触发（rolloutPercent=100），
  // 在 11min 后该触发；这里只验证 9min 边界。
  const sends: SendCall[] = [];
  const orchestrator2 = new RelayUpgradeOrchestrator({
    config: buildBaseConfig(),
    send: (connection, envelope) => sends.push({ connection, envelope }),
    getAgent: () => makeAgent(),
    now: () => fakeNow,
  });
  orchestrator2.recordFailure("device-123", "ice_failed", "conn_mobile");
  orchestrator2.recordFailure("device-123", "ice_failed", "conn_mobile");
  orchestrator2.recordFailure("device-123", "ice_failed", "conn_mobile");
  // 推进 9 分钟，仍在退避内。
  fakeNow += 9 * 60_000;
  orchestrator2.notifyMobileAuthenticated("device-123", makeMobile());
  await wait(20);
  assert.equal(sends.length, 0, "still in backoff at 9min");

  // 第 4 次失败 → 永久退避。
  orchestrator2.recordFailure("device-123", "ice_failed", "conn_mobile");
  fakeNow = Number.MAX_SAFE_INTEGER - 1; // 即便走到最大值附近也不放行
  orchestrator2.notifyMobileAuthenticated("device-123", makeMobile());
  await wait(20);
  assert.equal(sends.length, 0, "permanent backoff after 4 failures");
  orchestrator.dispose();
  orchestrator2.dispose();
}

// 6. handleControlMessage 处理 committed/downgrade
{
  const sends: SendCall[] = [];
  const orchestrator = new RelayUpgradeOrchestrator({
    config: buildBaseConfig(),
    send: (connection, envelope) => sends.push({ connection, envelope }),
    getAgent: () => makeAgent(),
  });
  const upgradeId = orchestrator.triggerUpgrade(
    "device-123",
    makeMobile(),
    makeAgent(),
  );
  assert.equal(orchestrator.getMetrics().proposed, 1);
  assert.equal(orchestrator.getMetrics().in_flight, 1);

  const committed = createMessage<TunnelUpgradeCommittedPayload>(
    "tunnel.upgrade.committed",
    { upgrade_id: upgradeId, app_connection_id: "conn_mobile" },
    { device_id: "device-123" },
  );
  orchestrator.handleControlMessage(committed);
  orchestrator.handleControlMessage(committed);
  const after = orchestrator.getMetrics();
  assert.equal(after.committed, 2);
  assert.equal(after.in_flight, 0);

  // downgrade 计数 + 失败累积
  const upgradeId2 = orchestrator.triggerUpgrade(
    "device-123",
    makeMobile("conn_2"),
    makeAgent(),
  );
  const downgrade = createMessage<TunnelUpgradeDowngradePayload>(
    "tunnel.upgrade.downgrade",
    {
      upgrade_id: upgradeId2,
      app_connection_id: "conn_2",
      reason: "ice_failed",
    },
    { device_id: "device-123" },
  );
  orchestrator.handleControlMessage(downgrade);
  const final = orchestrator.getMetrics();
  assert.equal(final.downgrade.ice_failed, 1);
  assert.equal(final.failed.ice_failed, 1);
  assert.equal(final.in_flight, 0);
  orchestrator.dispose();
}

// 7. transport_preference=relay_only → 跳过 propose，不入退避，metrics 累计
{
  const sends: SendCall[] = [];
  const orchestrator = new RelayUpgradeOrchestrator({
    config: buildBaseConfig(),
    send: (connection, envelope) => sends.push({ connection, envelope }),
    getAgent: () => makeAgent(),
  });
  const mobile: UpgradeOrchestratorConnection = {
    ...makeMobile(),
    transportPreference: "relay_only",
  };
  orchestrator.notifyMobileAuthenticated("device-123", mobile);
  await wait(30);
  assert.equal(sends.length, 0, "relay_only must skip propose");
  const metrics = orchestrator.getMetrics();
  assert.equal(metrics.proposed, 0);
  assert.equal(metrics.prefs.relay_only, 1);
  assert.equal(metrics.skipped_by_pref, 1);
  assert.equal(
    Object.keys(metrics.failed).length,
    0,
    "relay_only must not record any failure",
  );
  orchestrator.dispose();
}

// 8. transport_preference=prefer_p2p → 跳过 rollout 灰度（仍受 enabled/blocklist/backoff）
{
  // rolloutPercent=0 时 auto 不会触发，prefer_p2p 仍应触发
  const sends: SendCall[] = [];
  const orchestrator = new RelayUpgradeOrchestrator({
    config: buildBaseConfig({ rolloutPercent: 0 }),
    send: (connection, envelope) => sends.push({ connection, envelope }),
    getAgent: () => makeAgent(),
  });
  const mobile: UpgradeOrchestratorConnection = {
    ...makeMobile(),
    transportPreference: "prefer_p2p",
  };
  orchestrator.notifyMobileAuthenticated("device-123", mobile);
  await wait(30);
  assert.equal(sends.length, 2, "prefer_p2p must bypass rollout");
  assert.equal(orchestrator.getMetrics().prefs.prefer_p2p, 1);
  // strict 标记必须透传到双端 propose
  for (const call of sends) {
    const payload = call.envelope.payload as { strict?: boolean };
    assert.equal(
      payload.strict,
      true,
      "prefer_p2p must propagate strict=true on propose payload",
    );
  }

  // 但 enabled=false 时 strict 不能静默吞掉：应主动下发 strict_unavailable
  // 让 mobile 立即触发 forceClose，避免业务消息持续暂存超时。
  const sends2: SendCall[] = [];
  const orchestrator2 = new RelayUpgradeOrchestrator({
    config: buildBaseConfig({ enabled: false }),
    send: (connection, envelope) => sends2.push({ connection, envelope }),
    getAgent: () => makeAgent(),
  });
  orchestrator2.notifyMobileAuthenticated("device-123", {
    ...makeMobile(),
    transportPreference: "prefer_p2p",
  });
  await wait(20);
  assert.equal(
    sends2.length,
    1,
    "prefer_p2p + enabled=false must emit strict_unavailable downgrade",
  );
  assert.equal(sends2[0]?.envelope.type, "tunnel.upgrade.downgrade");
  assert.equal(
    (sends2[0]?.envelope.payload as { reason: string }).reason,
    "strict_unavailable:relay_disabled",
  );

  // blocklist 命中：同样要主动 downgrade。
  const sends3: SendCall[] = [];
  const orchestrator3 = new RelayUpgradeOrchestrator({
    config: buildBaseConfig({
      deviceBlocklist: new Set(["device-123"]),
    }),
    send: (connection, envelope) => sends3.push({ connection, envelope }),
    getAgent: () => makeAgent(),
  });
  orchestrator3.notifyMobileAuthenticated("device-123", {
    ...makeMobile(),
    transportPreference: "prefer_p2p",
  });
  await wait(20);
  assert.equal(
    sends3.length,
    1,
    "prefer_p2p + blocklist must emit strict_unavailable downgrade",
  );
  assert.equal(
    (sends3[0]?.envelope.payload as { reason: string }).reason,
    "strict_unavailable:blocklisted",
  );

  // backoff 命中：prefer_p2p 触发过失败、还在退避窗口内时也要主动 downgrade。
  let fakeNow = 1_000_000;
  const sends4: SendCall[] = [];
  const orchestrator4 = new RelayUpgradeOrchestrator({
    config: buildBaseConfig(),
    send: (connection, envelope) => sends4.push({ connection, envelope }),
    getAgent: () => makeAgent(),
    now: () => fakeNow,
  });
  orchestrator4.recordFailure("device-123", "ice_failed", "conn_mobile");
  // 第一次失败 → 30s 退避；推进 5s 仍在窗内。
  fakeNow += 5_000;
  orchestrator4.notifyMobileAuthenticated("device-123", {
    ...makeMobile(),
    transportPreference: "prefer_p2p",
  });
  await wait(20);
  assert.equal(
    sends4.length,
    1,
    "prefer_p2p + backoff must emit strict_unavailable downgrade",
  );
  assert.equal(
    (sends4[0]?.envelope.payload as { reason: string }).reason,
    "strict_unavailable:backoff_active",
  );

  orchestrator.dispose();
  orchestrator2.dispose();
  orchestrator3.dispose();
  orchestrator4.dispose();
}

// 9. respectClientPreference=false → 客户端偏好被忽略，统一按 auto 处理
{
  // relay_only 在 respectClientPreference=false 时应仍然发起 propose
  const sends: SendCall[] = [];
  const orchestrator = new RelayUpgradeOrchestrator({
    config: buildBaseConfig({ respectClientPreference: false }),
    send: (connection, envelope) => sends.push({ connection, envelope }),
    getAgent: () => makeAgent(),
  });
  orchestrator.notifyMobileAuthenticated("device-123", {
    ...makeMobile(),
    transportPreference: "relay_only",
  });
  await wait(30);
  assert.equal(
    sends.length,
    2,
    "respectClientPreference=false must override relay_only",
  );
  // 当 respectClientPreference=false 时，preference 被强制视为 auto，propose
  // 不应携带 strict=true（即使 mobile 上送了 prefer_p2p）。
  for (const call of sends) {
    const payload = call.envelope.payload as { strict?: boolean };
    assert.notEqual(
      payload.strict,
      true,
      "respectClientPreference=false must drop strict flag",
    );
  }
  const metrics = orchestrator.getMetrics();
  assert.equal(
    metrics.skipped_by_pref,
    0,
    "no preference skip when respectClientPreference=false",
  );
  // 计数仍按 auto 累计
  assert.equal(metrics.prefs.auto, 1);
  assert.equal(metrics.prefs.relay_only, 0);

  // prefer_p2p 在 respectClientPreference=false 时也按 auto 处理：rolloutPercent=0 应当不触发
  const sends2: SendCall[] = [];
  const orchestrator2 = new RelayUpgradeOrchestrator({
    config: buildBaseConfig({
      respectClientPreference: false,
      rolloutPercent: 0,
    }),
    send: (connection, envelope) => sends2.push({ connection, envelope }),
    getAgent: () => makeAgent(),
  });
  orchestrator2.notifyMobileAuthenticated("device-123", {
    ...makeMobile(),
    transportPreference: "prefer_p2p",
  });
  await wait(20);
  assert.equal(
    sends2.length,
    0,
    "prefer_p2p must fall back to auto rollout when override disabled",
  );
  assert.equal(orchestrator2.getMetrics().prefs.auto, 1);

  orchestrator.dispose();
  orchestrator2.dispose();
}

console.log("relay-orchestrator tests passed");
