/**
 * Minimal contract test for the OmniWork wire protocol.
 *
 * 用 zod schema 校验典型 envelope + payload 的正反例，
 * 防止协议字段重命名 / 取值集合变化时跨端漂移而无人察觉。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  PROTOCOL_VERSION,
  authFailedPayloadSchema,
  authOkPayloadSchema,
  authVerifyPayloadSchema,
  createMessage,
  createPairingLink,
  messageEnvelopeSchema,
  parsePairingLink,
  terminalFramePayloadSchema,
  terminalInputPayloadSchema,
  terminalSnapshotPayloadSchema,
} from "../src/index.ts";

describe("messageEnvelopeSchema", () => {
  it("accepts a well-formed envelope produced by createMessage", () => {
    const envelope = createMessage(
      "terminal.frame",
      { data: "hello" },
      { device_id: "device-1", session_id: "s-1" },
    );
    const parsed = messageEnvelopeSchema.parse(envelope);
    assert.equal(parsed.v, PROTOCOL_VERSION);
    assert.equal(parsed.type, "terminal.frame");
    assert.equal(parsed.device_id, "device-1");
  });

  it("rejects envelope with wrong protocol version", () => {
    const envelope = {
      v: 999,
      id: "msg_1",
      type: "auth.ok",
      ts: new Date().toISOString(),
      payload: {},
    };
    assert.equal(messageEnvelopeSchema.safeParse(envelope).success, false);
  });

  it("rejects envelope missing required fields", () => {
    assert.equal(
      messageEnvelopeSchema.safeParse({ v: PROTOCOL_VERSION }).success,
      false,
    );
  });
});

describe("auth payload schemas", () => {
  it("validates auth.verify and auth.ok happy path", () => {
    authVerifyPayloadSchema.parse({
      key_id: "k1",
      nonce: "n1",
      proof: "p1",
      connection_id: "c1",
    });
    authOkPayloadSchema.parse({
      agent_instance_id: "agent-1",
      connection_id: "c1",
    });
  });

  it("rejects auth.failed with unknown reason", () => {
    const result = authFailedPayloadSchema.safeParse({
      reason: "rate_limited",
    });
    assert.equal(result.success, false);
  });

  it("accepts every documented auth.failed reason", () => {
    for (const reason of [
      "key_mismatch",
      "agent_restarted",
      "key_expired",
      "device_not_online",
      "too_many_attempts",
      "malformed_proof",
    ] as const) {
      authFailedPayloadSchema.parse({ reason });
    }
  });
});

describe("terminal payload schemas", () => {
  it("accepts text/key/paste inputs", () => {
    for (const kind of ["text", "key", "paste"] as const) {
      terminalInputPayloadSchema.parse({ kind, data: "x" });
    }
  });

  it("rejects unknown input kind", () => {
    const result = terminalInputPayloadSchema.safeParse({
      kind: "binary",
      data: "x",
    });
    assert.equal(result.success, false);
  });

  it("validates terminal.frame and terminal.snapshot", () => {
    terminalFramePayloadSchema.parse({ data: "abc" });
    terminalFramePayloadSchema.parse({ data: "abc", snapshot: true });
    terminalSnapshotPayloadSchema.parse({
      data: "abc",
      size: { cols: 80, rows: 24 },
      captured_at: new Date().toISOString(),
    });
  });

  it("rejects non-positive terminal size", () => {
    const result = terminalSnapshotPayloadSchema.safeParse({
      data: "abc",
      size: { cols: 0, rows: 24 },
      captured_at: new Date().toISOString(),
    });
    assert.equal(result.success, false);
  });
});

describe("pairing link round-trip", () => {
  const samplePayload = {
    v: PROTOCOL_VERSION,
    relay_url: "wss://relay.example/mobile",
    device_id: "mac-host-01",
    key: "q8LDuJppTK3BU9X3et9bF3gAej-vbLQS",
    key_id: "sha256:8f2b7d62d9b0",
  } as const;

  it("encodes and decodes all fields losslessly", () => {
    const link = createPairingLink(samplePayload);
    assert.match(link, /^omniwork:\/\/pair\?/);
    const parsed = parsePairingLink(link);
    assert.deepEqual(parsed, samplePayload);
  });

  it("decodes payload without optional key_id", () => {
    const { key_id: _omit, ...minimal } = samplePayload;
    const link = createPairingLink(minimal);
    const parsed = parsePairingLink(link);
    assert.equal(parsed?.key_id, undefined);
    assert.equal(parsed?.relay_url, minimal.relay_url);
    assert.equal(parsed?.device_id, minimal.device_id);
    assert.equal(parsed?.key, minimal.key);
  });

  it("preserves URL-encoded characters in relay_url and device_id", () => {
    const tricky = {
      ...samplePayload,
      relay_url: "wss://relay.example/path with space?x=1&y=2",
      device_id: "host name#tag",
    };
    const link = createPairingLink(tricky);
    const parsed = parsePairingLink(link);
    assert.equal(parsed?.relay_url, tricky.relay_url);
    assert.equal(parsed?.device_id, tricky.device_id);
  });

  it("accepts the alternate omniwork:pair and omniwork:/pair prefixes", () => {
    const canonical = createPairingLink(samplePayload);
    const query = canonical.slice("omniwork://pair".length);
    for (const prefix of ["omniwork:pair", "omniwork:/pair"]) {
      const parsed = parsePairingLink(`${prefix}${query}`);
      assert.equal(parsed?.relay_url, samplePayload.relay_url);
    }
  });

  it("strips trailing fragment from query", () => {
    const link = `${createPairingLink(samplePayload)}#section`;
    const parsed = parsePairingLink(link);
    assert.equal(parsed?.relay_url, samplePayload.relay_url);
  });

  it("rejects unknown protocol version", () => {
    const link = createPairingLink(samplePayload).replace(
      `v=${PROTOCOL_VERSION}`,
      "v=999",
    );
    assert.equal(parsePairingLink(link), null);
  });

  it("rejects link missing required fields", () => {
    assert.equal(
      parsePairingLink(`omniwork://pair?v=${PROTOCOL_VERSION}&device_id=mac`),
      null,
    );
  });

  it("rejects unrelated input", () => {
    assert.equal(parsePairingLink("https://example.com/?key=abc"), null);
    assert.equal(parsePairingLink("not-a-link"), null);
    assert.equal(parsePairingLink(""), null);
  });

  it("rejects misspelled scheme", () => {
    const link = createPairingLink(samplePayload).replace(
      "omniwork://",
      "omniwor://",
    );
    assert.equal(parsePairingLink(link), null);
  });

  it("rejects link with non-pair host", () => {
    const link = createPairingLink(samplePayload).replace(
      "omniwork://pair",
      "omniwork://device",
    );
    assert.equal(parsePairingLink(link), null);
  });

  it("accepts upper-case scheme and host", () => {
    const link = createPairingLink(samplePayload).replace(
      "omniwork://pair",
      "OMNIWORK://PAIR",
    );
    const parsed = parsePairingLink(link);
    assert.deepEqual(parsed, samplePayload);
  });
});
