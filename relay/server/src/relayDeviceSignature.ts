import { createPublicKey, verify } from "node:crypto";

import type { AgentHelloPayload } from "@omniwork/protocol-ts";

export function relayDeviceSignaturePayload(input: {
  deviceId: string;
  agentInstanceId: string;
  timestamp: number;
  nonce: string;
}): Buffer {
  return Buffer.from(
    `${input.deviceId}|${input.agentInstanceId}|${input.timestamp}|${input.nonce}`,
    "utf8",
  );
}

export function verifyRelayDeviceSignature(input: {
  publicKey: string;
  hello: AgentHelloPayload;
  skewMs: number;
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
  try {
    const publicKey = createPublicKey(input.publicKey);
    const ok = verify(
      null,
      relayDeviceSignaturePayload({
        deviceId: input.hello.device_id,
        agentInstanceId: input.hello.agent_instance_id,
        timestamp: auth.timestamp,
        nonce: auth.nonce,
      }),
      publicKey,
      Buffer.from(auth.signature, "base64url"),
    );
    return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}
