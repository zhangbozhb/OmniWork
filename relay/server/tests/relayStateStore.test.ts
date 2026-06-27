import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { E2E_SUPPORT_V1, type MessageEnvelope } from "@omniwork/protocol-ts";

import { RelayDeviceStatusStore } from "../src/relayDeviceStatusStore.ts";
import { RelayStateStore } from "../src/relayStateStore.ts";
import type { RelayConnection } from "../src/relayTypes.ts";

const dir = mkdtempSync(join(tmpdir(), "omniwork-relay-state-"));

try {
  const deviceStore = new RelayDeviceStatusStore(
    join(dir, "relay-device-status.sqlite"),
  );
  const state = new RelayStateStore({ deviceStatusStore: deviceStore });
  const agent = createAgentConnection("conn_agent_1", "device_1");
  const mobile = createMobileConnection("conn_mobile_1", "device_1");

  state.registerConnection(agent);
  state.registerConnection(mobile);
  state.registerAgent(agent);
  state.authenticateApp(mobile, agent);
  state.recordIngress(
    mobile,
    {
      type: "e2e.message",
      payload: {},
      device_id: "device_1",
      app_connection_id: mobile.id,
    } as MessageEnvelope,
    128,
  );
  state.flushDeviceStatus(3000);

  assert.equal(state.runtimeSnapshot().totals.device_count, 1);
  assert.equal(state.linksSnapshot().summary.link_count, 1);

  state.closeConnection(mobile);
  assert.equal(state.linksSnapshot().summary.link_count, 0);
  assert.equal(state.agentAppsSnapshot(agent.id).summary.app_count, 0);
  assert.equal(state.runtimeSnapshot().totals.device_count, 1);

  state.closeConnection(agent);
  assert.equal(state.runtimeSnapshot().totals.device_count, 0);
  assert.equal(state.agentsSnapshot().summary.agent_count, 0);

  const devices = state.devicesSnapshot({ includeOffline: true, limit: 10 });
  assert.equal(devices.summary.active_device_count, 0);
  assert.equal(devices.summary.offline_device_count, 1);
  assert.equal(devices.devices.length, 1);
  assert.equal(devices.devices[0]?.device_id, "device_1");
  assert.equal(devices.devices[0]?.source, "persisted");
  assert.equal(devices.devices[0]?.status, "offline");
  assert.equal(devices.devices[0]?.last_agent_instance_id, "agent_instance_1");
  assert.equal(devices.devices[0]?.last_app_remote_ip, "198.51.100.10");
  assert.equal(devices.devices[0]?.counters.bytes_in, 128);

  state.sweep({ now: Date.now() + 10_000, offlineDeviceRetentionMs: 1 });
  assert.equal(
    state.devicesSnapshot({ includeOffline: true, limit: 10 }).devices.length,
    0,
  );

  console.log("relay state store tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function createAgentConnection(id: string, deviceId: string): RelayConnection {
  return {
    id,
    endpoint: "agent",
    role: "agent",
    state: "registered_agent",
    socket: createNoopSocket(),
    deviceId,
    agentInstanceId: "agent_instance_1",
    keyId: "key_1",
    businessSecurityMode: "e2e_required",
    e2e: E2E_SUPPORT_V1,
    authenticated: true,
    remoteIp: "203.0.113.10",
    observations: [],
    connectedAt: 1000,
    lastSeenAt: 2000,
    authState: "verified",
    transportPath: "relay",
  };
}

function createMobileConnection(id: string, deviceId: string): RelayConnection {
  return {
    id,
    endpoint: "mobile",
    role: "mobile",
    state: "e2e_ready",
    socket: createNoopSocket(),
    deviceId,
    authenticated: true,
    remoteIp: "198.51.100.10",
    observations: [],
    connectedAt: 1100,
    lastSeenAt: 2100,
    authState: "verified",
    transportPath: "relay",
    appInfo: {
      instanceId: "app-instance",
      runtimeId: "app-runtime",
    },
  };
}

function createNoopSocket(): RelayConnection["socket"] {
  return {
    onMessage: () => () => {},
    onClose: () => () => {},
    sendText: () => {},
    close: () => {},
  };
}
