import {
  RELAY_AGENT_IP_BANNED_CLOSE_REASON,
  RELAY_AGENT_SHUTDOWN_CLOSE_CODE,
} from "@omniwork/protocol-ts";

import type { RelayWsUpgradeAuthContext } from "../context.ts";
import type { RelayAuthDecision } from "../decision.ts";
import type { RelayAuthPolicy } from "../policy.ts";

export interface IpBanPolicyOptions {
  activeIpBan(ip: string): unknown;
}

export class IpBanPolicy
  implements RelayAuthPolicy<RelayWsUpgradeAuthContext>
{
  readonly name = "ip_ban";
  private readonly options: IpBanPolicyOptions;

  constructor(options: IpBanPolicyOptions) {
    this.options = options;
  }

  authorize(context: RelayWsUpgradeAuthContext): RelayAuthDecision | null {
    if (!this.options.activeIpBan(context.remoteIp)) {
      return null;
    }

    const audit = {
      surface: context.surface,
      endpoint: context.endpoint,
      remoteIp: context.remoteIp,
    } as const;

    if (context.endpoint === "agent") {
      return {
        ok: false,
        reason: "ip_banned",
        action: {
          kind: "close_ws",
          code: RELAY_AGENT_SHUTDOWN_CLOSE_CODE,
          reason: RELAY_AGENT_IP_BANNED_CLOSE_REASON,
        },
        audit,
      };
    }

    return {
      ok: false,
      reason: "ip_banned",
      action: {
        kind: "reject_http",
        statusCode: 403,
        message: "ip_banned",
      },
      audit,
    };
  }
}
