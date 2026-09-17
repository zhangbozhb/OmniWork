import {
  SIGNATURE_DOMAINS,
  agentRelayInitSignatureFields,
  agentRelayProofSignatureFields,
  signIdentityFields,
  type IdentityKeyPair,
} from "@omni-work/protocol-ts";

export function createRelayDeviceAuthInit(
  identity: IdentityKeyPair,
): {
  device_public_key: string;
  timestamp: number;
  signature: string;
} {
  const timestamp = Date.now();
  return {
    device_public_key: identity.publicKey,
    timestamp,
    signature: signIdentityFields(
      identity.privateKey,
      SIGNATURE_DOMAINS.agentRelayInit,
      agentRelayInitSignatureFields({
        deviceId: identity.id,
        devicePublicKey: identity.publicKey,
        timestamp,
      }),
    ),
  };
}

export function createRelayDeviceAuthProof(input: {
  identity: IdentityKeyPair;
  challenge: string;
}): {
  method: "device_signature";
  timestamp: number;
  challenge: string;
  signature: string;
} {
  const timestamp = Date.now();
  return {
    method: "device_signature",
    timestamp,
    challenge: input.challenge,
    signature: signIdentityFields(
      input.identity.privateKey,
      SIGNATURE_DOMAINS.agentRelayProof,
      agentRelayProofSignatureFields({
        deviceId: input.identity.id,
        challenge: input.challenge,
        timestamp,
      }),
    ),
  };
}
