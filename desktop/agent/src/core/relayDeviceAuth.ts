import {
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";

export function createRelayDeviceAuthInit(input: {
  deviceId: string;
  privateKeyPem: string;
}): {
  device_public_key: string;
  timestamp: number;
  signature: string;
} {
  const timestamp = Date.now();
  const privateKey = createPrivateKey(input.privateKeyPem);
  const devicePublicKey = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  const payload = Buffer.from(
    ["agent_init_v1", input.deviceId, devicePublicKey, String(timestamp)].join(
      "|",
    ),
    "utf8",
  );
  return {
    device_public_key: devicePublicKey,
    timestamp,
    signature: sign(null, payload, privateKey).toString("base64url"),
  };
}

export function createRelayDeviceAuthProof(input: {
  deviceId: string;
  privateKeyPem: string;
  challenge: string;
}): {
  method: "device_signature";
  timestamp: number;
  challenge: string;
  signature: string;
} {
  const timestamp = Date.now();
  const payload = Buffer.from(
    ["agent_proof_v1", input.deviceId, input.challenge, String(timestamp)].join(
      "|",
    ),
    "utf8",
  );
  return {
    method: "device_signature",
    timestamp,
    challenge: input.challenge,
    signature: sign(
      null,
      payload,
      createPrivateKey(input.privateKeyPem),
    ).toString("base64url"),
  };
}
