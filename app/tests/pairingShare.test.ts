import assert from "node:assert/strict";
import test from "node:test";

import { parsePairingLink } from "@omniwork/protocol-ts";

import { createPairingShareLink } from "../src/features/auth/pairingShare.ts";

test("createPairingShareLink serializes saved pairing as protocol link", () => {
  const link = createPairingShareLink({
    relayUrl: "wss://relay.example/relay/ws/mobile",
    deviceId: "mac-1",
    key: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    keyId: "key-1",
    appInstanceId: "app-1",
  });

  const payload = parsePairingLink(link);

  assert.equal(payload?.relay_url, "wss://relay.example/relay/ws/mobile");
  assert.equal(payload?.device_id, "mac-1");
  assert.equal(payload?.key, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(payload?.key_id, "key-1");
});
