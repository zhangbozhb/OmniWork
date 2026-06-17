import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptPairingLink,
  parseEncryptedPairingLink,
} from "@omniwork/protocol-ts";

import { createPairingSharePackage } from "../src/features/auth/pairingShare.ts";

test("createPairingSharePackage encrypts saved pairing with a QR password", () => {
  const share = createPairingSharePackage(
    {
      relayUrl: "wss://relay.example/relay/ws/mobile",
      deviceId: "mac-1",
      displayName: "Alice MacBook",
      key: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      keyId: "key-1",
      appInstanceId: "app-1",
    },
    "ios",
  );

  assert.match(share.password, /^\d{4}$/u);
  assert.equal(parseEncryptedPairingLink(share.link)?.source, "ios");

  const payload = decryptPairingLink(share.link, share.password);

  assert.equal(payload.relay_url, "wss://relay.example/relay/ws/mobile");
  assert.equal(payload.device_id, "mac-1");
  assert.equal(payload.display_name, "Alice MacBook");
  assert.equal(payload.key, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(payload.key_id, "key-1");
});
