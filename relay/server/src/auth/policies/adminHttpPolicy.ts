import type { IncomingMessage } from "node:http";

import type { RelayAdminSession } from "../../adminAuth.ts";
import type { AdminHttpAuthContext } from "../context.ts";
import type { RelayAuthDecision } from "../decision.ts";
import type { RelayAuthPolicy } from "../policy.ts";

export interface AdminHttpPolicyOptions {
  isAdminHttps(request: IncomingMessage): boolean;
  authenticateAdmin(request: IncomingMessage): RelayAdminSession | null;
}

export class AdminHttpPolicy implements RelayAuthPolicy<AdminHttpAuthContext> {
  readonly name = "admin_http";
  private readonly options: AdminHttpPolicyOptions;

  constructor(options: AdminHttpPolicyOptions) {
    this.options = options;
  }

  authorize(context: AdminHttpAuthContext): RelayAuthDecision | null {
    const audit = {
      surface: context.surface,
    } as const;
    if (!this.options.isAdminHttps(context.request)) {
      return rejectHttp(audit, "admin_https_required", 403);
    }
    if (!context.requireSession) {
      return null;
    }

    const session = this.options.authenticateAdmin(context.request);
    if (!session) {
      return rejectHttp(audit, "unauthorized", 401);
    }

    if (context.requireCsrf) {
      const csrfHeader = context.request.headers["x-csrf-token"];
      const csrfToken = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
      if (csrfToken !== session.csrfToken) {
        return rejectHttp(audit, "csrf_required", 403);
      }
    }

    return {
      ok: true,
      subject: {
        adminSession: session,
      },
    };
  }
}

function rejectHttp(
  audit: Extract<RelayAuthDecision, { ok: false }>["audit"],
  reason: Extract<RelayAuthDecision, { ok: false }>["reason"],
  statusCode: number,
): RelayAuthDecision {
  return {
    ok: false,
    reason,
    action: {
      kind: "reject_http",
      statusCode,
      message: reason,
    },
    audit,
  };
}
