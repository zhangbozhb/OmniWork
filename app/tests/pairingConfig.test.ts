import assert from "node:assert/strict";
import test from "node:test";

import {
  PROTOCOL_VERSION,
  createPairingLink,
  generateIdentityKeyPair,
} from "@omni-work/protocol-ts";

import {
  createPairingConfig,
  isSameRelayOrigin,
  parsePairingConfig,
  retainSavedRelaySession,
} from "../src/features/auth/pairingConfig.ts";
import { createPairingShareLink } from "../src/features/auth/pairingShare.ts";

test("createPairingConfig validates and normalizes manual target details", () => {
  const agent = generateIdentityKeyPair("agent");
  const pairing = createPairingConfig({
    relayUrl: "  wss://relay.example/relay/ws/mobile  ",
    deviceId: agent.id.toLowerCase().replaceAll("-", ""),
    displayName: "  Alice MacBook  ",
  });

  assert.ok(pairing);
  assert.equal(pairing.relayUrl, "wss://relay.example/relay/ws/mobile");
  assert.equal(pairing.deviceId, agent.id);
  assert.equal(pairing.displayName, "Alice MacBook");
  assert.match(pairing.appInstanceId, /^app_/u);
});

test("createPairingConfig rejects invalid Relay URLs and Agent IDs", () => {
  const agent = generateIdentityKeyPair("agent");

  assert.equal(
    createPairingConfig({
      relayUrl: "https://relay.example/relay/ws/mobile",
      deviceId: agent.id,
    }),
    null,
  );
  assert.equal(
    createPairingConfig({
      relayUrl: "wss://relay.example/relay/ws/mobile",
      deviceId: "DEV1-invalid",
    }),
    null,
  );
});

test("parsePairingConfig applies the same target validation", () => {
  const agent = generateIdentityKeyPair("agent");
  const link = createPairingLink({
    v: PROTOCOL_VERSION,
    relay_url: "wss://relay.example/relay/ws/mobile",
    device_id: agent.id,
    display_name: "Alice MacBook",
  });

  const pairing = parsePairingConfig(link);

  assert.ok(pairing);
  assert.equal(pairing.relayUrl, "wss://relay.example/relay/ws/mobile");
  assert.equal(pairing.deviceId, agent.id);
  assert.equal(pairing.displayName, "Alice MacBook");
});

test("pairing session tokens are trimmed and never imported from shared links", () => {
  const agent = generateIdentityKeyPair("agent");
  const target = {
    relayUrl: "wss://relay.example/relay/ws/mobile",
    deviceId: agent.id,
  };
  const pairing = createPairingConfig({
    ...target,
    relaySessionToken: " \n private-session-token \t ",
  });
  assert.ok(pairing);
  assert.equal(pairing.relaySessionToken, "private-session-token");
  assert.equal(
    createPairingConfig({ ...target, relaySessionToken: " \n " })?.relaySessionToken,
    undefined,
  );
  const shareLink = createPairingShareLink(pairing);
  assert.equal(shareLink.includes("private-session-token"), false);
  assert.equal(parsePairingConfig(shareLink)?.relaySessionToken, undefined);
  const untrustedLink = new URL(shareLink);
  untrustedLink.searchParams.set("session_token", "untrusted-token");
  untrustedLink.searchParams.set("relaySessionToken", "untrusted-token");
  assert.equal(parsePairingConfig(untrustedLink.toString())?.relaySessionToken, undefined);
});

test("Relay origin comparison preserves paths but rejects origin changes and invalid URLs", () => {
  const source = "wss://relay.example/relay/ws/mobile";
  assert.equal(isSameRelayOrigin(source, " wss://RELAY.example:443/other "), true);
  for (const target of [
    "wss://another.example/relay/ws/mobile",
    "wss://relay.example:8443/relay/ws/mobile",
    "ws://relay.example/relay/ws/mobile",
    "https://relay.example/relay/ws/mobile",
    "",
    "invalid",
  ]) {
    assert.equal(isSameRelayOrigin(source, target), false);
  }
});

test("target imports retain saved sessions only for the exact Relay URL and device", () => {
  const agent = generateIdentityKeyPair("agent");
  const saved = createPairingConfig({
    relayUrl: "wss://relay.example/relay/ws/mobile",
    deviceId: agent.id,
    relaySessionToken: "saved-private-token",
  })!;
  const imported = parsePairingConfig(createPairingShareLink(saved))!;
  assert.equal(retainSavedRelaySession(imported, [saved]).relaySessionToken, "saved-private-token");
  assert.equal(imported.relaySessionToken, undefined);
  for (const changed of [
    { ...imported, relayUrl: "wss://another.example/relay/ws/mobile" },
    { ...imported, relayUrl: "wss://relay.example/other" },
    { ...imported, deviceId: generateIdentityKeyPair("agent").id },
  ]) {
    assert.equal(retainSavedRelaySession(changed, [saved]).relaySessionToken, undefined);
  }
  assert.equal(
    retainSavedRelaySession({ ...imported, relaySessionToken: "new-token" }, [saved]).relaySessionToken,
    "new-token",
  );
  assert.equal(retainSavedRelaySession(imported, []).relaySessionToken, undefined);
});
