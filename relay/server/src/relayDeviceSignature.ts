import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";

import type {
  AgentAuthInitPayload,
  AgentHelloPayload,
} from "@omniwork/protocol-ts";

const AGENT_AUTH_INIT_DOMAIN = "agent_init_v1";
const AGENT_AUTH_PROOF_DOMAIN = "agent_proof_v1";

interface AgentAuthChallengeClaims {
  d: string;
  c: string;
  e: number;
  n: string;
}

export function relayDeviceInitSignaturePayload(input: {
  deviceId: string;
  devicePublicKey: string;
  timestamp: number;
}): Buffer {
  return Buffer.from(
    [
      AGENT_AUTH_INIT_DOMAIN,
      input.deviceId,
      input.devicePublicKey,
      String(input.timestamp),
    ].join("|"),
    "utf8",
  );
}

export function relayDeviceProofSignaturePayload(input: {
  deviceId: string;
  challenge: string;
  timestamp: number;
}): Buffer {
  return Buffer.from(
    [
      AGENT_AUTH_PROOF_DOMAIN,
      input.deviceId,
      input.challenge,
      String(input.timestamp),
    ].join("|"),
    "utf8",
  );
}

export function createStatelessAgentAuthChallenge(input: {
  deviceId: string;
  connectionId: string;
  secret: Buffer;
  ttlMs: number;
  now?: number;
}): string {
  const claims: AgentAuthChallengeClaims = {
    d: input.deviceId,
    c: input.connectionId,
    e: (input.now ?? Date.now()) + input.ttlMs,
    n: randomBytes(24).toString("base64url"),
  };
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${body}.${agentChallengeMac(input.secret, body)}`;
}

export function verifyStatelessAgentAuthChallenge(input: {
  challenge: string;
  deviceId: string;
  connectionId: string;
  secret: Buffer;
  now?: number;
}): { ok: true } | { ok: false; reason: string } {
  const [body, mac, extra] = input.challenge.split(".");
  if (!body || !mac || extra !== undefined) {
    return { ok: false, reason: "malformed_challenge" };
  }
  if (!safeEqualBase64Url(mac, agentChallengeMac(input.secret, body))) {
    return { ok: false, reason: "bad_challenge_mac" };
  }
  let claims: AgentAuthChallengeClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed_challenge" };
  }
  if (
    !claims ||
    claims.d !== input.deviceId ||
    claims.c !== input.connectionId ||
    typeof claims.e !== "number"
  ) {
    return { ok: false, reason: "challenge_mismatch" };
  }
  if ((input.now ?? Date.now()) > claims.e) {
    return { ok: false, reason: "challenge_expired" };
  }
  return { ok: true };
}

export function verifyRelayDeviceInitSignature(input: {
  publicKey: string;
  init: AgentAuthInitPayload;
  skewMs: number;
  now?: number;
}): { ok: true } | { ok: false; reason: string } {
  const now = input.now ?? Date.now();
  if (Math.abs(now - input.init.timestamp) > input.skewMs) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }
  try {
    const publicKey = createPublicKey(input.publicKey);
    const ok = verify(
      null,
      relayDeviceInitSignaturePayload({
        deviceId: input.init.device_id,
        devicePublicKey: input.init.device_public_key,
        timestamp: input.init.timestamp,
      }),
      publicKey,
      Buffer.from(input.init.signature, "base64url"),
    );
    return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}

export function sameRelayDevicePublicKey(left: string, right: string): boolean {
  const leftFingerprint = relayDevicePublicKeyFingerprint(left);
  const rightFingerprint = relayDevicePublicKeyFingerprint(right);
  return (
    leftFingerprint !== null &&
    rightFingerprint !== null &&
    leftFingerprint === rightFingerprint
  );
}

export function relayDevicePublicKeyFingerprint(publicKey: string): string | null {
  try {
    const der = createPublicKey(publicKey).export({
      type: "spki",
      format: "der",
    });
    return createHash("sha256").update(der).digest("base64url");
  } catch {
    return null;
  }
}

export function verifyRelayDeviceSignature(input: {
  publicKey: string;
  hello: AgentHelloPayload;
  skewMs: number;
  challengeSecret: Buffer;
  connectionId: string;
  now?: number;
}): { ok: true } | { ok: false; reason: string } {
  const auth = input.hello.relay_auth;
  if (!auth) {
    return { ok: false, reason: "missing_relay_auth" };
  }
  const now = input.now ?? Date.now();
  if (Math.abs(now - auth.timestamp) > input.skewMs) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }
  const challenge = verifyStatelessAgentAuthChallenge({
    challenge: auth.challenge,
    deviceId: input.hello.device_id,
    connectionId: input.connectionId,
    secret: input.challengeSecret,
    now,
  });
  if (!challenge.ok) {
    return challenge;
  }
  try {
    const publicKey = createPublicKey(input.publicKey);
    const ok = verify(
      null,
      relayDeviceProofSignaturePayload({
        deviceId: input.hello.device_id,
        timestamp: auth.timestamp,
        challenge: auth.challenge,
      }),
      publicKey,
      Buffer.from(auth.signature, "base64url"),
    );
    return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}

function agentChallengeMac(secret: Buffer, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function safeEqualBase64Url(a: string, b: string): boolean {
  const left = Buffer.from(a, "base64url");
  const right = Buffer.from(b, "base64url");
  return left.length === right.length && timingSafeEqual(left, right);
}
