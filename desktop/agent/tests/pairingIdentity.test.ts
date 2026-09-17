import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_TERMINAL_PROVIDER_DEFINITIONS,
  parsePairingLink,
} from "@omni-work/protocol-ts";

import type { AgentConfig } from "../src/config/config.ts";
import { resolveAgentIdentity } from "../src/config/deviceIdentity.ts";
import {
  createPairingQrDetails,
  selectPreferredLocalIpv4Address,
} from "../src/pairing/pairingQr.ts";

const appSupportDir = join(tmpdir(), `omniwork-pairing-${process.pid}`);
const identityPath = join(appSupportDir, "identity-v2.json");
const identity = resolveAgentIdentity({
  identityPath,
  keychainEnabled: false,
});
const config = {
  agentVersion: "test",
  identity,
  identityPath,
  deviceId: identity.id,
  hostname: "test.local",
  displayName: "Test Mac",
  relayUrl: "wss://relay.example/relay/ws/agent",
  appAuthorizationMode: "manual",
  adminEnabled: true,
  adminHost: "127.0.0.1",
  adminPort: 17668,
  agentProbeEnabled: true,
  agentProbeHost: "127.0.0.1",
  agentProbePort: 17669,
  connectionHeartbeatMs: 10_000,
  connectionStaleMs: 30_000,
  connectionDisconnectMs: 90_000,
  relayReconnectForever: true,
  relayReconnectMaxAttempts: 8,
  relayReconnectInitialDelayMs: 1_000,
  relayReconnectMaxDelayMs: 30_000,
  terminalProviders: [...DEFAULT_TERMINAL_PROVIDER_DEFINITIONS],
  defaultCwd: appSupportDir,
  appSupportDir,
  probeTokenPath: join(appSupportDir, "probe-token.json"),
  trustedAppsPath: join(appSupportDir, "trusted-apps-v2.json"),
  sessionStorePath: join(appSupportDir, "sessions.sqlite"),
  terminalSize: { cols: 80, rows: 24 },
  terminalStreamEnabled: false,
} satisfies AgentConfig;

const details = createPairingQrDetails(config);
assert.ok(details);
const payload = parsePairingLink(details.link);
assert.ok(payload);
assert.equal(payload.device_id, identity.id);
assert.equal(payload.display_name, "Test Mac");
assert.equal(payload.relay_url, "wss://relay.example/relay/ws/mobile");
assert.equal(details.link.includes("agent_public_key"), false);
assert.equal(details.link.includes("ticket"), false);
assert.equal(
  selectPreferredLocalIpv4Address([
    "169.254.131.69",
    "100.90.140.33",
    "192.168.1.10",
  ]),
  "100.90.140.33",
);
assert.equal(selectPreferredLocalIpv4Address(["169.254.131.69"]), null);

console.log("pairing identity tests passed");
