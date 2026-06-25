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
    observations: [
      {
        source: "relay",
        observed_at: "2026-01-01T00:00:00.000Z",
        network: {
          remote_ip: "203.0.113.10",
          ip_source: "x_forwarded_for",
        },
        http: {
          user_agent: "OmniWork App",
        },
      },
    ],
    now: 1000,
  });

  assert.equal(connection.trusted, true);
  assert.equal(connection.relay_connection_id, "relay-app-1");
  assert.equal(connection.app_instance_id, "app-instance-1");
  assert.equal(connection.app_runtime_id, "runtime-1");
  assert.equal(connection.client_info_available, true);
  assert.equal(connection.network.ip, "203.0.113.10");
  assert.equal(connection.network.ip_source, "x_forwarded_for");
  assert.deepEqual(connection.network.ip_history, ["203.0.113.10"]);
  assert.equal(connection.observations[1]?.http?.user_agent, "OmniWork App");
  assert.equal(connection.counters.connection_attempts, 1);
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
      device: {
        platform: "ios",
      },
      app: {
        name: "OmniWork iOS",
      },
    },
    now: 1000,
  });

  assert.equal(connection.app_instance_id, "app-instance-1");
  assert.equal(connection.app_name, "OmniWork iOS");
  assert.equal(connection.app_platform, "ios");
  assert.equal(connection.timing.connected_at, 1000);
  assert.equal(connection.client_info_available, true);
});

test("AppConnectionRegistry collapses reconnects from the same app instance", () => {
  const registry = new AppConnectionRegistry({
    heartbeatIntervalMs: 10000,
    staleTimeoutMs: 30000,
    disconnectTimeoutMs: 90000,
  });

  const first = registry.acceptAuthenticatedConnection({
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

  const result = registry.acceptAuthenticatedConnectionDetailed({
    relayConnectionId: "relay-app-2",
    keyId: "key-1",
    appInfo: {
      instance_id: "app-instance-1",
      runtime_id: "runtime-2",
    },
    observations: [
      {
        source: "relay",
        observed_at: "2026-01-01T00:01:00.000Z",
        network: {
          remote_ip: "203.0.113.11",
          ip_source: "socket_remote_address",
        },
      },
    ],
    now: 3000,
  });

  assert.equal(result.previousRelayConnectionId, "relay-app-1");
  assert.equal(result.connection.connection_id, first.connection_id);
  assert.equal(result.connection.relay_connection_id, "relay-app-2");
  assert.equal(result.connection.app_runtime_id, "runtime-2");
  assert.equal(result.connection.timing.first_seen_at, 1000);
  assert.equal(result.connection.timing.connected_at, 3000);
  assert.equal(result.connection.security.e2e_ready, false);
  assert.equal(result.connection.transport.current_path, "relay");
  assert.deepEqual(result.connection.transport.available_paths, ["relay"]);
  assert.equal(result.connection.network.ip, "203.0.113.11");
  assert.deepEqual(result.connection.network.ip_history, [
    "203.0.113.11",
  ]);
  assert.equal(result.connection.counters.connection_attempts, 2);
  assert.equal(registry.hasAuthenticatedConnection("relay-app-1"), false);
  assert.equal(registry.hasAuthenticatedConnection("relay-app-2"), true);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.summary().total, 1);
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
  registry.recordMessage("relay-app-1", "in", true, 128);
  registry.recordMessage("relay-app-1", "out", true, 256);

  const [connection] = registry.list();
  assert.equal(connection.security.mode, "e2e");
  assert.equal(connection.security.encrypted, true);
  assert.equal(connection.security.e2e_ready, true);
  assert.equal(connection.counters.messages_in, 1);
  assert.equal(connection.counters.bytes_in, 128);
  assert.equal(connection.counters.bytes_out, 256);
  assert.equal(registry.summary().bytes_in, 128);
  assert.equal(registry.summary().bytes_out, 256);
});

test("AppConnectionRegistry aggregates device-level stats", () => {
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
      device: {
        name: "Alice iPhone",
        platform: "ios",
        private_network_hash: "private-network-hash",
      },
      app: {
        version: "1.0.0",
      },
    },
    observations: [
      {
        source: "relay",
        observed_at: "2026-01-01T00:00:00.000Z",
        network: {
          remote_ip: "203.0.113.10",
          ip_source: "x_forwarded_for",
        },
      },
    ],
    now: 1000,
  });
  registry.recordMessage("relay-app-1", "in", true, 100);
  registry.recordMessage("relay-app-1", "out", true, 200);
  registry.setPath("relay-app-1", "p2p");

  const [device] = registry.devices();

  assert.ok(device);
  assert.equal(device.device_id, "app-instance-1");
  assert.equal(device.device_name, "Alice iPhone");
  assert.equal(device.platform, "ios");
  assert.equal(device.connection_count, 1);
  assert.equal(device.active_connections, 1);
  assert.equal(device.trusted_connections, 1);
  assert.equal(device.encrypted_connections, 1);
  assert.equal(device.connection_attempts, 1);
  assert.equal(device.bytes_in, 100);
  assert.equal(device.bytes_out, 200);
  assert.equal(device.messages_in, 1);
  assert.equal(device.messages_out, 1);
  assert.equal(device.current_path, "p2p");
  assert.equal(device.ip, "203.0.113.10");
  assert.deepEqual(device.ip_history, ["203.0.113.10"]);
  assert.equal(device.private_network_hash, "private-network-hash");
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
