import type { RelayServerConfig } from "../../config.ts";
import type {
  RelayAuthDevice,
  RelayAuthUser,
} from "../../relayUserAuthStore.ts";
import type { MobileConnectAuthContext } from "../context.ts";
import type { RelayAuthDecision } from "../decision.ts";
import type { RelayAuthPolicy } from "../policy.ts";

export interface MobileEmailLinkPolicyOptions {
  config: RelayServerConfig;
  authenticateUserToken(token: string | undefined): RelayAuthUser | null;
  getDevice(deviceId: string): RelayAuthDevice | null;
}

export class MobileEmailLinkPolicy
  implements RelayAuthPolicy<MobileConnectAuthContext>
{
  readonly name = "mobile_email_link";
  private readonly options: MobileEmailLinkPolicyOptions;

  constructor(options: MobileEmailLinkPolicyOptions) {
    this.options = options;
  }

  authorize(context: MobileConnectAuthContext): RelayAuthDecision | null {
    if (this.options.config.auth.mode !== "email_link") {
      return null;
    }

    const deviceId = context.message.payload.device_id;
    const user = this.options.authenticateUserToken(
      context.message.payload.session_token,
    );
    const device = this.options.getDevice(deviceId);
    const userId = user?.id ?? context.connectionUserId;
    const audit = {
      surface: context.surface,
      endpoint: "mobile",
      deviceId,
      userId,
    } as const;

    if (!userId) {
      return authFailed(audit, "invalid_session");
    }
    if (!device) {
      return authFailed(audit, "device_not_registered");
    }
    if (device.revoked_at) {
      return authFailed(audit, "device_revoked");
    }
    if (device.user_id !== userId) {
      return authFailed(audit, "invalid_session");
    }

    return {
      ok: true,
      subject: {
        userId,
        deviceId,
      },
    };
  }
}

function authFailed(
  audit: Extract<RelayAuthDecision, { ok: false }>["audit"],
  reason: Extract<RelayAuthDecision, { ok: false }>["reason"],
): RelayAuthDecision {
  return {
    ok: false,
    reason,
    action: {
      kind: "send_auth_failed",
      authReason: "malformed_proof",
      retryAfterMs: 2000,
    },
    audit,
  };
}
