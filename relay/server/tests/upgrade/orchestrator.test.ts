import { strict as assert } from "node:assert";
import { setTimeout as wait } from "node:timers/promises";

import {
  createMessage,
  type MessageEnvelope,
  type TunnelUpgradeCommittedPayload,
  type TunnelUpgradeDowngradePayload,
} from "../../../../packages/protocol-ts/src/index.ts";
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
  orchestrator2.recordFailure("device-123", "ice_failed");
  orchestrator2.recordFailure("device-123", "ice_failed");
  orchestrator2.recordFailure("device-123", "ice_failed");
  // 推进 9 分钟，仍在退避内。
  fakeNow += 9 * 60_000;
  orchestrator2.notifyMobileAuthenticated("device-123", makeMobile());
  await wait(20);
  assert.equal(sends.length, 0, "still in backoff at 9min");

  // 第 4 次失败 → 永久退避。
  orchestrator2.recordFailure("device-123", "ice_failed");
  fakeNow = Number.MAX_SAFE_INTEGER - 1; // 即便走到最大值附近也不放行
  orchestrator2.notifyMobileAuthenticated("device-123", makeMobile("conn_2"));
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
    { upgrade_id: upgradeId },
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
    { upgrade_id: upgradeId2, reason: "ice_failed" },
    { device_id: "device-123" },
  );
  orchestrator.handleControlMessage(downgrade);
  const final = orchestrator.getMetrics();
  assert.equal(final.downgrade.ice_failed, 1);
  assert.equal(final.failed.ice_failed, 1);
  assert.equal(final.in_flight, 0);
  orchestrator.dispose();
}

console.log("relay-orchestrator tests passed");
