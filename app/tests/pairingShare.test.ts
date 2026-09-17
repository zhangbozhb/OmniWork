import assert from "node:assert/strict";
import test from "node:test";

import {
  generateIdentityKeyPair,
  parsePairingLink,
} from "@omni-work/protocol-ts";

import { createPairingShareLink } from "../src/features/auth/pairingShare.ts";

test("createPairingShareLink includes only the target Agent location", () => {
  const agent = generateIdentityKeyPair("agent");
  const link = createPairingShareLink({
    relayUrl: "wss://relay.example/relay/ws/mobile",
    deviceId: agent.id,
    displayName: "Alice MacBook",
    relaySessionToken: "app-owned-session-token",
    appInstanceId: "app-1",
  });

  assert.deepEqual(parsePairingLink(link), {
    v: 2,
    relay_url: "wss://relay.example/relay/ws/mobile",
    device_id: agent.id,
    display_name: "Alice MacBook",
  });
  assert.equal(link.includes("public_key"), false);
  assert.equal(link.includes("session_token"), false);
  assert.equal(link.includes("app-1"), false);
});
