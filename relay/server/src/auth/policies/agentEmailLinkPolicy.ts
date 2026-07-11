import type { AgentHelloPayload } from "@omniwork/protocol-ts";

import type { RelayServerConfig } from "../../config.ts";
import { verifyRelayDeviceSignature } from "../../relayDeviceSignature.ts";
import type { RelayAuthDevice } from "../../relayUserAuthStore.ts";
import type { AgentHelloAuthContext } from "../context.ts";
import type { RelayAuthDecision } from "../decision.ts";
import type { RelayAuthPolicy } from "../policy.ts";

type AgentHelloAuthFailureReason =
  | "device_not_registered"
  | "device_revoked"
  | "invalid_signature"
  | "replayed_nonce";

export interface AgentEmailLinkPolicyOptions {
  config: RelayServerConfig;
  getDevice(deviceId: string): RelayAuthDevice | null;
  rememberNonce(deviceId: string, nonce: string, ttlMs: number): boolean;
  markDeviceSeen(deviceId: string): void;
  verifySignature?(
    input: AgentEmailLinkSignatureInput,
  ): ReturnType<typeof verifyRelayDeviceSignature>;
}

export interface AgentEmailLinkSignatureInput {
  publicKey: string;
  hello: AgentHelloPayload;
  skewMs: number;
}

export class AgentEmailLinkPolicy
  implements RelayAuthPolicy<AgentHelloAuthContext>
{
  readonly name = "agent_email_link";
  private readonly options: AgentEmailLinkPolicyOptions;

  constructor(options: AgentEmailLinkPolicyOptions) {
    this.options = options;
  }

  authorize(context: AgentHelloAuthContext): RelayAuthDecision | null {
    if (this.options.config.auth.mode !== "email_link") {
      return null;
    }

    const hello = context.message.payload;
    const audit = {
      surface: context.surface,
      deviceId: hello.device_id,
    } as const;

    const device = this.options.getDevice(hello.device_id);
    if (!device) {
      return this.closeAgentHello(audit, "device_not_registered");
    }
    if (device.revoked_at) {
      return this.closeAgentHello(audit, "device_revoked");
    }

    const verified = (this.options.verifySignature ?? verifyRelayDeviceSignature)(
      {
        publicKey: device.public_key,
        hello,
        skewMs: this.options.config.auth.nonceTtlMs,
      },
    );
    if (!verified.ok) {
      return this.closeAgentHello(audit, "invalid_signature", verified.reason);
    }

    const nonceOk = this.options.rememberNonce(
      hello.device_id,
      hello.relay_auth?.nonce ?? "",
      this.options.config.auth.nonceTtlMs,
    );
    if (!nonceOk) {
      return this.closeAgentHello(audit, "replayed_nonce");
    }

    this.options.markDeviceSeen(device.id);
    return {
      ok: true,
      subject: {
        userId: device.user_id,
        deviceId: device.id,
      },
    };
  }

  private closeAgentHello(
    audit: Extract<RelayAuthDecision, { ok: false }>["audit"],
    reason: AgentHelloAuthFailureReason,
    closeReason: string = reason,
  ): RelayAuthDecision {
    return {
      ok: false,
      reason,
      action: {
        kind: "close_ws",
        code: 4403,
        reason: closeReason,
      },
      audit,
    };
  }
}
