import type {
  AppAuthorizationScope,
  AppInfoPayload,
  AuthOkPayload,
  AuthProofPayload,
  E2EHandshakeInitPayload,
  E2EHandshakeReplyPayload,
} from "./index.ts";

export const SIGNATURE_DOMAINS = {
  agentRelayInit: "agent-relay-init",
  agentRelayProof: "agent-relay-proof",
  appAuth: "app-auth",
  agentAuthOk: "agent-auth-ok",
  e2eInit: "e2e-init",
  e2eReply: "e2e-reply",
} as const;

export function agentRelayInitSignatureFields(input: {
  deviceId: string;
  devicePublicKey: string;
  timestamp: number;
}): string[] {
  return [input.deviceId, input.devicePublicKey, String(input.timestamp)];
}

export function agentRelayProofSignatureFields(input: {
  deviceId: string;
  challenge: string;
  timestamp: number;
}): string[] {
  return [input.deviceId, input.challenge, String(input.timestamp)];
}

export function appAuthSignatureFields(
  payload: Omit<AuthProofPayload, "signature">,
): string[] {
  return [
    payload.nonce,
    payload.connection_id,
    payload.agent_connection_id,
    payload.device_id,
    payload.agent_public_key,
    payload.app_id,
    payload.app_public_key,
    canonicalJson(payload.app_info),
    canonicalScopes(payload.requested_scopes),
    String(payload.timestamp),
  ];
}

export function agentAuthOkSignatureFields(
  payload: Omit<AuthOkPayload, "signature" | "e2e">,
): string[] {
  return [
    payload.nonce,
    payload.device_id,
    payload.agent_public_key,
    payload.app_id,
    payload.agent_connection_id,
    payload.connection_id,
    canonicalScopes(payload.granted_scopes),
    String(payload.timestamp),
  ];
}

export function e2eInitSignatureFields(
  payload: Omit<E2EHandshakeInitPayload, "signature">,
): string[] {
  return [
    String(payload.v),
    String(payload.e2e_version),
    payload.suite,
    payload.device_id,
    payload.app_id,
    payload.app_public_key,
    payload.agent_connection_id,
    payload.app_connection_id,
    payload.handshake_id,
    payload.app_ephemeral_key,
    canonicalJson(payload.app_protocol),
  ];
}

export function e2eReplySignatureFields(input: {
  reply: Omit<E2EHandshakeReplyPayload, "signature">;
  appEphemeralKey: string;
}): string[] {
  const { reply } = input;
  return [
    String(reply.v),
    String(reply.e2e_version),
    reply.suite,
    reply.device_id,
    reply.agent_public_key,
    reply.app_id,
    reply.agent_connection_id,
    reply.app_connection_id,
    reply.handshake_id,
    input.appEphemeralKey,
    reply.agent_ephemeral_key,
    canonicalJson(reply.agent_protocol),
  ];
}

function canonicalScopes(scopes: readonly AppAuthorizationScope[]): string {
  return [...scopes].sort().join(",");
}

function canonicalJson(value: AppInfoPayload | object): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
