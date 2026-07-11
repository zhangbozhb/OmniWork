import type { RelayAdminSession } from "../adminAuth.ts";

export interface RelayAuthSubject {
  userId?: string;
  deviceId?: string;
  adminSession?: RelayAdminSession;
}

export type RelayAuthDecision =
  | {
      ok: true;
      subject?: RelayAuthSubject;
    }
  | {
      ok: false;
      reason:
        | "ip_banned"
        | "agent_disabled"
        | "device_not_registered"
        | "device_revoked"
        | "invalid_signature"
        | "replayed_nonce"
        | "invalid_session"
        | "admin_https_required"
        | "unauthorized"
        | "csrf_required";
      action:
        | { kind: "reject_http"; statusCode: number; message: string }
        | { kind: "close_ws"; code: number; reason: string }
        | {
            kind: "send_auth_failed";
            authReason: "malformed_proof";
            retryAfterMs: number;
          };
      audit: {
        surface:
          | "relay_ws_upgrade"
          | "agent_hello"
          | "mobile_connect"
          | "admin_http";
        endpoint?: "agent" | "mobile";
        remoteIp?: string;
        deviceId?: string;
        userId?: string;
      };
    };
