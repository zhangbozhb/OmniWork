import type {
  AdminHttpAuthContext,
  AgentAuthInitContext,
  AgentHelloAuthContext,
  MobileConnectAuthContext,
  RelayAuthContext,
  RelayWsUpgradeAuthContext,
} from "./context.ts";
import type { RelayAuthDecision, RelayAuthSubject } from "./decision.ts";
import type { RelayAuthPolicy } from "./policy.ts";

export interface RelayAuthGuardOptions {
  policies: {
    relayWsUpgrade?: RelayAuthPolicy<RelayWsUpgradeAuthContext>[];
    agentAuthInit?: RelayAuthPolicy<AgentAuthInitContext>[];
    agentHello?: RelayAuthPolicy<AgentHelloAuthContext>[];
    mobileConnect?: RelayAuthPolicy<MobileConnectAuthContext>[];
    adminHttp?: RelayAuthPolicy<AdminHttpAuthContext>[];
  };
}

export class RelayAuthGuard {
  private readonly policies: RelayAuthGuardOptions["policies"];

  constructor(options: RelayAuthGuardOptions) {
    this.policies = options.policies;
  }

  authorize(context: RelayAuthContext): RelayAuthDecision {
    if (context.surface === "agent_auth_init") {
      return this.runPolicies(context, this.policies.agentAuthInit ?? []);
    }
    if (context.surface === "agent_hello") {
      return this.runPolicies(context, this.policies.agentHello ?? []);
    }
    if (context.surface === "mobile_connect") {
      return this.runPolicies(context, this.policies.mobileConnect ?? []);
    }
    if (context.surface === "admin_http") {
      return this.runPolicies(context, this.policies.adminHttp ?? []);
    }
    return this.runPolicies(context, this.policies.relayWsUpgrade ?? []);
  }

  private runPolicies<Context extends RelayAuthContext>(
    context: Context,
    policies: RelayAuthPolicy<Context>[],
  ): RelayAuthDecision {
    let subject: RelayAuthSubject | undefined;
    for (const policy of policies) {
      const decision = policy.authorize(context);
      if (!decision) {
        continue;
      }
      if (!decision.ok) {
        return decision;
      }
      subject = mergeSubject(subject, decision.subject);
    }

    return subject ? { ok: true, subject } : { ok: true };
  }
}

function mergeSubject(
  current: RelayAuthSubject | undefined,
  next: RelayAuthSubject | undefined,
): RelayAuthSubject | undefined {
  if (!next) {
    return current;
  }
  if (!current) {
    return next;
  }
  return { ...current, ...next };
}
