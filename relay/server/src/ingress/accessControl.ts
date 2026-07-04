import {
  RELAY_AGENT_IP_BANNED_CLOSE_REASON,
  RELAY_AGENT_SHUTDOWN_CLOSE_CODE,
} from "@omniwork/protocol-ts";

import type { RelayEndpoint } from "../relayTypes.ts";

export type RelayIngressAccessDecision =
  | { ok: true }
  | {
      ok: false;
      reason: "ip_banned";
      statusCode: 403;
      websocketClose?: {
        code: number;
        reason: string;
      };
    };

export function evaluateRelayIngressAccess(input: {
  endpoint: RelayEndpoint;
  remoteIp: string;
  activeIpBan(ip: string): unknown;
}): RelayIngressAccessDecision {
  if (!input.activeIpBan(input.remoteIp)) {
    return { ok: true };
  }

  if (input.endpoint === "agent") {
    return {
      ok: false,
      reason: "ip_banned",
      statusCode: 403,
      websocketClose: {
        code: RELAY_AGENT_SHUTDOWN_CLOSE_CODE,
        reason: RELAY_AGENT_IP_BANNED_CLOSE_REASON,
      },
    };
  }

  return {
    ok: false,
    reason: "ip_banned",
    statusCode: 403,
  };
}
