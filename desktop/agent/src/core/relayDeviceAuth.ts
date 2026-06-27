import { createPrivateKey, randomBytes, sign } from "node:crypto";

export function createRelayDeviceAuth(input: {
  deviceId: string;
  agentInstanceId: string;
  privateKeyPem: string;
}): {
  method: "device_signature";
  timestamp: number;
  nonce: string;
  signature: string;
} {
  const timestamp = Date.now();
  const nonce = randomBytes(24).toString("base64url");
  const payload = Buffer.from(
    `${input.deviceId}|${input.agentInstanceId}|${timestamp}|${nonce}`,
    "utf8",
  );
  return {
    method: "device_signature",
    timestamp,
    nonce,
    signature: sign(null, payload, createPrivateKey(input.privateKeyPem)).toString(
      "base64url",
    ),
  };
}
