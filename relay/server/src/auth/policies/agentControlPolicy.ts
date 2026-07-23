import {
  RELAY_AGENT_DISABLED_CLOSE_REASON,
  RELAY_AGENT_SHUTDOWN_CLOSE_CODE,
} from "@omni-work/protocol-ts";

import type { AgentHelloAuthContext } from "../context.ts";
import type { RelayAuthDecision } from "../decision.ts";
import type { RelayAuthPolicy } from "../policy.ts";

export interface AgentControlPolicyOptions {
  activeDisabledAgentDevice(deviceId: string): unknown;
}

export class AgentControlPolicy implements RelayAuthPolicy<AgentHelloAuthContext> {
  readonly name = "agent_control";
  private readonly options: AgentControlPolicyOptions;

  constructor(options: AgentControlPolicyOptions) {
    this.options = options;
  }

  authorize(context: AgentHelloAuthContext): RelayAuthDecision | null {
    const hello = context.message.payload;
    if (!this.options.activeDisabledAgentDevice(hello.device_id)) {
      return null;
    }

    return {
      ok: false,
      reason: "agent_disabled",
      action: {
        kind: "close_ws",
        code: RELAY_AGENT_SHUTDOWN_CLOSE_CODE,
        reason: RELAY_AGENT_DISABLED_CLOSE_REASON,
      },
      audit: {
        surface: context.surface,
        deviceId: hello.device_id,
      },
    };
  }
}
