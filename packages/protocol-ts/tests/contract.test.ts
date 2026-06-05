/**
 * Minimal contract test for the OmniWork wire protocol.
 *
 * 用 zod schema 校验典型 envelope + payload 的正反例，
 * 防止协议字段重命名 / 取值集合变化时跨端漂移而无人察觉。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  E2E_PROTOCOL_VERSION,
  E2E_SUPPORT_V1,
  ENCRYPTED_ONLY_BUSINESS_CAPABILITY_V1,
  INNER_PROTOCOL_VERSION,
  NOISE_SUITE_NNPSK0_V1,
  PLAINTEXT_BUSINESS_CAPABILITY_V1,
  PROTOCOL_VERSION,
  PROTOCOL_SUPPORT_V1,
  SESSION_FIELDS,
  SESSION_REQUIRED_FIELDS,
  SUPPORTED_SESSION_STATUSES,
  TRANSPORT_PREFERENCES,
  agentHelloPayloadSchema,
  authFailedPayloadSchema,
  authOkPayloadSchema,
  authVerifyPayloadSchema,
  codexSessionSchema,
  createMessage,
  createPairingLink,
  e2eHandshakeInitPayloadSchema,
  e2eMessagePayloadSchema,
  e2eReadyPayloadSchema,
  innerEnvelopeSchema,
  innerToMessage,
  isE2EBusinessMessage,
  isTransportPreference,
  messageToInner,
  messageEnvelopeSchema,
  parsePairingLink,
  parseMessageEnvelope,
  protocolErrorPayloadSchema,
  sessionAttachPayloadSchema,
  sessionClosePayloadSchema,
  sessionCreatePayloadSchema,
  sessionCreatedPayloadSchema,
  sessionKillTmuxPayloadSchema,
  sessionListPayloadSchema,
  sessionRenamePayloadSchema,
  terminalFramePayloadSchema,
  terminalInputPayloadSchema,
  terminalSnapshotPayloadSchema,
} from "../src/index.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

  it("parseMessageEnvelope rejects malformed known payloads", () => {
    const envelope = createMessage("mobile.connect", {
      v: PROTOCOL_VERSION,
      device_id: "device-1",
      protocol: PROTOCOL_SUPPORT_V1,
      e2e: E2E_SUPPORT_V1,
    });
    assert.equal(parseMessageEnvelope(envelope), null);
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

describe("agent hello security mode", () => {
  it("accepts the default encrypted-only mode", () => {
    agentHelloPayloadSchema.parse({
      v: PROTOCOL_VERSION,
      device_id: "device-1",
      agent_instance_id: "agent-1",
      key_id: "key-1",
      protocol: PROTOCOL_SUPPORT_V1,
      e2e: E2E_SUPPORT_V1,
      business_security_mode: "e2e_required",
      hostname: "mac",
      platform: "darwin",
      agent_version: "0.1.0",
      capabilities: [ENCRYPTED_ONLY_BUSINESS_CAPABILITY_V1],
    });
  });

  it("accepts explicit plaintext-allowed mode", () => {
    agentHelloPayloadSchema.parse({
      v: PROTOCOL_VERSION,
      device_id: "device-1",
      agent_instance_id: "agent-1",
      key_id: "key-1",
      protocol: PROTOCOL_SUPPORT_V1,
      e2e: { ...E2E_SUPPORT_V1, required: false },
      business_security_mode: "plaintext_allowed",
      hostname: "mac",
      platform: "darwin",
      agent_version: "0.1.0",
      capabilities: [PLAINTEXT_BUSINESS_CAPABILITY_V1],
    });
  });

  it("accepts legacy hello without explicit business security mode", () => {
    agentHelloPayloadSchema.parse({
      v: PROTOCOL_VERSION,
      device_id: "device-1",
      agent_instance_id: "agent-1",
      key_id: "key-1",
      protocol: PROTOCOL_SUPPORT_V1,
      e2e: E2E_SUPPORT_V1,
      hostname: "mac",
      platform: "darwin",
      agent_version: "0.1.0",
      capabilities: [ENCRYPTED_ONLY_BUSINESS_CAPABILITY_V1],
    });
  });
});

describe("e2e v1 schemas", () => {
  it("validates the mandatory Noise handshake init payload", () => {
    e2eHandshakeInitPayloadSchema.parse({
      v: PROTOCOL_VERSION,
      e2e_version: E2E_PROTOCOL_VERSION,
      app_connection_id: "conn_app_1",
      handshake_id: "hs_1",
      key_id: "sha256:8f2b7d62d9b0",
      suite: NOISE_SUITE_NNPSK0_V1,
      app_protocol: {
        outer_v: PROTOCOL_SUPPORT_V1.current,
        inner_v: INNER_PROTOCOL_VERSION,
        e2e_v: E2E_SUPPORT_V1.versions[0],
      },
      message: "base64url-noise-message",
    });
  });

  it("rejects unsupported Noise suites", () => {
    const result = e2eHandshakeInitPayloadSchema.safeParse({
      v: PROTOCOL_VERSION,
      e2e_version: E2E_PROTOCOL_VERSION,
      app_connection_id: "conn_app_1",
      handshake_id: "hs_1",
      key_id: "sha256:8f2b7d62d9b0",
      suite: "Noise_XX_25519_ChaChaPoly_BLAKE2s",
      app_protocol: {
        outer_v: PROTOCOL_VERSION,
        inner_v: INNER_PROTOCOL_VERSION,
        e2e_v: E2E_PROTOCOL_VERSION,
      },
      message: "base64url-noise-message",
    });
    assert.equal(result.success, false);
  });

  it("validates ready, encrypted message, protocol error, and inner envelope", () => {
    e2eReadyPayloadSchema.parse({
      v: PROTOCOL_VERSION,
      e2e_version: E2E_PROTOCOL_VERSION,
      app_connection_id: "conn_app_1",
      handshake_id: "hs_1",
      transcript_hash: "hash",
    });
    e2eMessagePayloadSchema.parse({
      v: PROTOCOL_VERSION,
      e2e_version: E2E_PROTOCOL_VERSION,
      app_connection_id: "conn_app_1",
      e2e_session_id: "e2e_1",
      seq: 1,
      ciphertext: "ciphertext",
    });
    protocolErrorPayloadSchema.parse({
      v: PROTOCOL_VERSION,
      code: "plaintext_business_rejected",
      retryable: false,
    });
    innerEnvelopeSchema.parse({
      v: INNER_PROTOCOL_VERSION,
      id: "inner_1",
      type: "terminal.input",
      created_at: new Date().toISOString(),
      seq: 1,
      payload: { data: "ls\n" },
    });
  });
});

describe("e2e business message helpers", () => {
  it("classifies encrypted business messages consistently", () => {
    assert.equal(isE2EBusinessMessage("session.list"), true);
    assert.equal(isE2EBusinessMessage("terminal.input"), true);
    assert.equal(isE2EBusinessMessage("tunnel.upgrade.offer"), true);
    assert.equal(isE2EBusinessMessage("auth.ok"), false);
    assert.equal(isE2EBusinessMessage("e2e.message"), false);
  });

  it("round-trips outer messages through inner envelopes", () => {
    const message = createMessage(
      "terminal.input",
      { kind: "text", data: "ls\n" },
      { device_id: "device-1", session_id: "sess-1", seq: 7 },
    );
    const restored = innerToMessage(messageToInner(message), "device-1");
    assert.deepEqual(restored, message);
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
    terminalFramePayloadSchema.parse({
      data: "abc",
      captured_at: new Date().toISOString(),
      byte_length: 3,
    });
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
    relay_url: "wss://relay.example/relay/ws/mobile",
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

describe("transport_preference", () => {
  it("exposes the documented three-state set", () => {
    assert.deepEqual(
      [...TRANSPORT_PREFERENCES],
      ["auto", "relay_only", "prefer_p2p"],
    );
  });

  it("accepts every documented value via the type guard", () => {
    for (const value of TRANSPORT_PREFERENCES) {
      assert.equal(isTransportPreference(value), true);
    }
  });

  it("rejects unknown / non-string values", () => {
    for (const value of [
      "AUTO",
      "p2p",
      "",
      undefined,
      null,
      0,
      true,
      {},
      [],
    ]) {
      assert.equal(isTransportPreference(value), false);
    }
  });
});

describe("session.schema.json contract alignment", () => {
  // protocol/sessions/session.schema.json 与 ts CodexSession 的字段集合、
  // 必填集合、status 取值集合必须保持一致。任何一边漂移都会让"协议合同"
  // 失效，本组用例作为最低限度的对账兜底。
  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(
    here,
    "..",
    "..",
    "..",
    "protocol",
    "sessions",
    "session.schema.json",
  );
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties?: boolean;
  };

  it("status enum equals SUPPORTED_SESSION_STATUSES", () => {
    const statusEnum = (
      (schema.properties.status as { enum: string[] }).enum ?? []
    )
      .slice()
      .sort();
    const expected = SUPPORTED_SESSION_STATUSES.slice().sort();
    assert.deepEqual(statusEnum, expected);
  });

  it("properties match SESSION_FIELDS", () => {
    const schemaKeys = Object.keys(schema.properties).sort();
    const expected = [...SESSION_FIELDS].sort();
    assert.deepEqual(schemaKeys, expected);
  });

  it("required is a subset of SESSION_FIELDS and equals SESSION_REQUIRED_FIELDS", () => {
    const required = schema.required.slice().sort();
    const expected = [...SESSION_REQUIRED_FIELDS].sort();
    assert.deepEqual(required, expected);
    for (const field of required) {
      assert.ok(
        (SESSION_FIELDS as readonly string[]).includes(field),
        `required field ${field} must also be declared in SESSION_FIELDS`,
      );
    }
  });

  it("additionalProperties is locked to false", () => {
    assert.equal(schema.additionalProperties, false);
  });
});

describe("session payload schemas", () => {
  // 与 SESSION_FIELDS / SESSION_REQUIRED_FIELDS / SUPPORTED_SESSION_STATUSES
  // 三个常量保持运行时一致。任何一边漂移都应被这里的正反例拦住。
  const validSession = {
    session_id: "sess_1",
    runtime_kind: "codex",
    runtime_label: "Codex",
    title: "demo",
    cwd: "/tmp",
    command: "codex",
    status: "running" as const,
    created_at: new Date().toISOString(),
    last_active_at: new Date().toISOString(),
    terminal_size: { cols: 80, rows: 24 },
    tmux_session_name: "omni-1",
  };

  it("codexSessionSchema accepts all SUPPORTED_SESSION_STATUSES", () => {
    for (const status of SUPPORTED_SESSION_STATUSES) {
      codexSessionSchema.parse({ ...validSession, status });
    }
  });

  it("codexSessionSchema rejects status='error'", () => {
    const result = codexSessionSchema.safeParse({
      ...validSession,
      status: "error",
    });
    assert.equal(result.success, false);
  });

  it("codexSessionSchema rejects unknown extra fields (strict)", () => {
    const result = codexSessionSchema.safeParse({
      ...validSession,
      foo_bar: "x",
    });
    assert.equal(result.success, false);
  });

  it("codexSessionSchema rejects when any required field is missing", () => {
    for (const field of SESSION_REQUIRED_FIELDS) {
      const broken: Record<string, unknown> = { ...validSession };
      delete broken[field];
      const result = codexSessionSchema.safeParse(broken);
      assert.equal(
        result.success,
        false,
        `expected missing required field ${field} to be rejected`,
      );
    }
  });

  it("sessionListPayloadSchema accepts empty and populated lists", () => {
    sessionListPayloadSchema.parse({ sessions: [] });
    sessionListPayloadSchema.parse({
      sessions: [validSession],
      default_cwd: "/tmp",
    });
  });

  it("sessionCreatePayloadSchema accepts empty payload", () => {
    sessionCreatePayloadSchema.parse({});
    sessionCreatePayloadSchema.parse({
      runtime_kind: "codex",
      cwd: "/tmp",
      terminal_size: { cols: 80, rows: 24 },
    });
  });

  it("sessionCreatePayloadSchema rejects extra unknown keys", () => {
    const result = sessionCreatePayloadSchema.safeParse({
      runtime_kind: "codex",
      forced: true,
    });
    assert.equal(result.success, false);
  });

  it("sessionCreatedPayloadSchema requires a valid session", () => {
    sessionCreatedPayloadSchema.parse({ session: validSession });
    const result = sessionCreatedPayloadSchema.safeParse({
      session: { ...validSession, status: "error" },
    });
    assert.equal(result.success, false);
  });

  it("session id payloads require non-empty session_id", () => {
    for (const schema of [
      sessionAttachPayloadSchema,
      sessionClosePayloadSchema,
      sessionKillTmuxPayloadSchema,
    ]) {
      schema.parse({ session_id: "sess_1" });
      assert.equal(schema.safeParse({ session_id: "" }).success, false);
      assert.equal(schema.safeParse({}).success, false);
    }
  });

  it("sessionRenamePayloadSchema requires session_id and title", () => {
    sessionRenamePayloadSchema.parse({ session_id: "sess_1", title: "new" });
    assert.equal(
      sessionRenamePayloadSchema.safeParse({ session_id: "sess_1" }).success,
      false,
    );
  });
});
