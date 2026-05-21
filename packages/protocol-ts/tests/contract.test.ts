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
  messageEnvelopeSchema,
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
