import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RelayDeviceStatusStore } from "../src/relayDeviceStatusStore.ts";

const dir = mkdtempSync(join(tmpdir(), "omniwork-relay-devices-"));

try {
  const path = join(dir, "relay-device-status.sqlite");
  const store = new RelayDeviceStatusStore(path);

  store.upsert({
    deviceId: "device-1",
    status: "online",
    seenAt: 1000,
    lastAgentInstanceId: "agent-instance-1",
    lastAgentRemoteIp: "203.0.113.10",
  });
  store.addTraffic("device-1", {
    bytesIn: 128,
    bytesOut: 256,
    messagesIn: 1,
    messagesOut: 2,
  }, 1500);
  store.upsert({
    deviceId: "device-1",
    status: "offline",
    seenAt: 2000,
    offlineAt: 2000,
    lastCloseRole: "agent",
  });

  const records = new RelayDeviceStatusStore(path).list({
    includeOffline: true,
    limit: 10,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.device_id, "device-1");
  assert.equal(records[0]?.status, "offline");
  assert.equal(records[0]?.first_seen_at, 1000);
  assert.equal(records[0]?.last_seen_at, 2000);
  assert.equal(records[0]?.offline_at, 2000);
  assert.equal(records[0]?.last_agent_instance_id, "agent-instance-1");
  assert.equal(records[0]?.last_agent_remote_ip, "203.0.113.10");
  assert.equal(records[0]?.last_close_role, "agent");
  assert.equal(records[0]?.bytes_in, 128);
  assert.equal(records[0]?.bytes_out, 256);
  assert.equal(records[0]?.messages_in, 1);
  assert.equal(records[0]?.messages_out, 2);

  const summary = store.summary();
  assert.equal(summary.known_device_count, 1);
  assert.equal(summary.offline_device_count, 1);
  assert.equal(store.pruneOffline(1999), 0);
  assert.equal(store.pruneOffline(2001), 1);
  assert.equal(store.summary().known_device_count, 0);

  console.log("relay device status store tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
