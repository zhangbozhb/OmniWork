import { strict as assert } from "node:assert";
import { test } from "node:test";

import { AppConnectionRegistry } from "../src/core/appConnectionRegistry.ts";

test("AppConnectionRegistry creates connections from authenticated relay links", () => {
  const registry = new AppConnectionRegistry({
    heartbeatIntervalMs: 10000,
    staleTimeoutMs: 30000,
    disconnectTimeoutMs: 90000,
  });

  const connection = registry.acceptAuthenticatedConnection({
    relayConnectionId: "relay-app-1",
    keyId: "key-1",
    appInfo: {
      instance_id: "app-instance-1",
      runtime_id: "runtime-1",
    },
    now: 1000,
  });

  assert.equal(connection.trusted, true);
  assert.equal(connection.relay_connection_id, "relay-app-1");
  assert.equal(connection.app_instance_id, "app-instance-1");
  assert.equal(connection.app_runtime_id, "runtime-1");
  assert.equal(connection.client_info_available, true);
  assert.equal(connection.security.mode, "plaintext");
  assert.equal(connection.security.encrypted, false);
  assert.equal(registry.hasAuthenticatedConnection("relay-app-1"), true);
});

test("AppConnectionRegistry records authenticated connection metadata", () => {
  const registry = new AppConnectionRegistry({
    heartbeatIntervalMs: 10000,
    staleTimeoutMs: 30000,
    disconnectTimeoutMs: 90000,
  });

  const connection = registry.acceptAuthenticatedConnection({
    relayConnectionId: "relay-app-1",
    keyId: "key-1",
    appInfo: {
      instance_id: "app-instance-1",
      runtime_id: "runtime-1",
      name: "OmniWork iOS",
      platform: "ios",
    },
    now: 1000,
  });

  assert.equal(connection.app_instance_id, "app-instance-1");
  assert.equal(connection.app_name, "OmniWork iOS");
  assert.equal(connection.app_platform, "ios");
  assert.equal(connection.timing.connected_at, 1000);
  assert.equal(connection.client_info_available, true);
});

test("AppConnectionRegistry upgrades authenticated connections to e2e", () => {
  const registry = new AppConnectionRegistry({
    heartbeatIntervalMs: 10000,
    staleTimeoutMs: 30000,
    disconnectTimeoutMs: 90000,
  });

  registry.acceptAuthenticatedConnection({
    relayConnectionId: "relay-app-1",
    keyId: "key-1",
    appInfo: {
      instance_id: "app-instance-1",
      runtime_id: "runtime-1",
    },
    now: 1000,
  });
  registry.markE2EReady("relay-app-1", 2000);
  registry.recordMessage("relay-app-1", "in", true);

  const [connection] = registry.list();
  assert.equal(connection.security.mode, "e2e");
  assert.equal(connection.security.encrypted, true);
  assert.equal(connection.security.e2e_ready, true);
  assert.equal(connection.counters.messages_in, 1);
});

test("AppConnectionRegistry marks relay-backed connections unavailable", () => {
  const registry = new AppConnectionRegistry({
    heartbeatIntervalMs: 10000,
    staleTimeoutMs: 30000,
    disconnectTimeoutMs: 90000,
  });

  registry.acceptAuthenticatedConnection({
    relayConnectionId: "relay-app-1",
    keyId: "key-1",
    appInfo: {
      instance_id: "app-instance-1",
      runtime_id: "runtime-1",
    },
    now: 1000,
  });
  registry.markE2EReady("relay-app-1", 2000);
  registry.setPath("relay-app-1", "p2p");

  registry.markRelayUnavailable(3000);

  const [connection] = registry.list();
  assert.equal(connection.state, "disconnected");
  assert.equal(connection.transport.relay_state, "unavailable");
  assert.equal(connection.transport.current_path, "unknown");
  assert.equal(connection.network.connection_method, "unknown");
  assert.equal(connection.timing.disconnect_after, 3000);
});
