import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  SIGNATURE_DOMAINS,
  agentRelayInitSignatureFields,
  agentRelayProofSignatureFields,
  fromBase64Url,
  identityMatchesPublicKey,
  toBase64Url,
  verifyIdentityFields,
  type AgentAuthInitPayload,
  type AgentHelloPayload,
} from "@omni-work/protocol-ts";

interface AgentAuthChallengeClaims {
  d: string;
  c: string;
  e: number;
  n: string;
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
  if (
    input.publicKey !== input.init.device_public_key ||
    !identityMatchesPublicKey(
      "agent",
      input.init.device_id,
      input.init.device_public_key,
    )
  ) {
    return { ok: false, reason: "identity_mismatch" };
  }
  return verifyIdentityFields(
    input.publicKey,
    SIGNATURE_DOMAINS.agentRelayInit,
    agentRelayInitSignatureFields({
      deviceId: input.init.device_id,
      devicePublicKey: input.init.device_public_key,
      timestamp: input.init.timestamp,
    }),
    input.init.signature,
  )
    ? { ok: true }
    : { ok: false, reason: "bad_signature" };
}

export function sameRelayDevicePublicKey(left: string, right: string): boolean {
  try {
    const leftBytes = fromBase64Url(left);
    const rightBytes = fromBase64Url(right);
    return (
      leftBytes.byteLength === rightBytes.byteLength &&
      timingSafeEqual(Buffer.from(leftBytes), Buffer.from(rightBytes))
    );
  } catch {
    return false;
  }
}

export function relayDevicePublicKeyFingerprint(publicKey: string): string | null {
  try {
    return toBase64Url(
      createHash("sha256")
        .update("omniwork-public-key-fingerprint-v2")
        .update(fromBase64Url(publicKey))
        .digest(),
    );
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
  return verifyIdentityFields(
    input.publicKey,
    SIGNATURE_DOMAINS.agentRelayProof,
    agentRelayProofSignatureFields({
      deviceId: input.hello.device_id,
      challenge: auth.challenge,
      timestamp: auth.timestamp,
    }),
    auth.signature,
  )
    ? { ok: true }
    : { ok: false, reason: "bad_signature" };
}

function agentChallengeMac(secret: Buffer, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function safeEqualBase64Url(a: string, b: string): boolean {
  const left = Buffer.from(a, "base64url");
  const right = Buffer.from(b, "base64url");
  return left.length === right.length && timingSafeEqual(left, right);
}
