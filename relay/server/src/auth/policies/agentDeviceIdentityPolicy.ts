import type {
  AgentAuthInitPayload,
  AgentHelloPayload,
} from "@omni-work/protocol-ts";

import type { RelayServerConfig } from "../../config.ts";
import {
  sameRelayDevicePublicKey,
  verifyRelayDeviceInitSignature,
  verifyRelayDeviceSignature,
} from "../../relayDeviceSignature.ts";
import type { RelayAuthDevice } from "../../relayUserAuthStore.ts";
import type {
  AgentAuthInitContext,
  AgentHelloAuthContext,
} from "../context.ts";
import type { RelayAuthDecision } from "../decision.ts";
import type { RelayAuthPolicy } from "../policy.ts";

type AgentDeviceIdentityFailureReason =
  | "device_not_registered"
  | "device_revoked"
  | "invalid_signature"
  | "public_key_mismatch"
  | "invalid_challenge";

export interface AgentDeviceIdentityPolicyOptions {
  config: RelayServerConfig;
  challengeSecret: Buffer;
  getDevice(deviceId: string): RelayAuthDevice | null;
  markDeviceSeen(deviceId: string): void;
  verifyInitSignature?(
    input: AgentDeviceIdentityInitSignatureInput,
  ): ReturnType<typeof verifyRelayDeviceInitSignature>;
  verifySignature?(
    input: AgentDeviceIdentitySignatureInput,
  ): ReturnType<typeof verifyRelayDeviceSignature>;
}

export interface AgentDeviceIdentityInitSignatureInput {
  publicKey: string;
  init: AgentAuthInitPayload;
  skewMs: number;
}

export interface AgentDeviceIdentitySignatureInput {
  publicKey: string;
  hello: AgentHelloPayload;
  skewMs: number;
  challengeSecret: Buffer;
  connectionId: string;
}

export class AgentDeviceIdentityPolicy implements RelayAuthPolicy<
  AgentAuthInitContext | AgentHelloAuthContext
> {
  readonly name = "agent_device_identity";
  private readonly options: AgentDeviceIdentityPolicyOptions;

  constructor(options: AgentDeviceIdentityPolicyOptions) {
    this.options = options;
  }

  authorize(
    context: AgentAuthInitContext | AgentHelloAuthContext,
  ): RelayAuthDecision | null {
    if (this.options.config.auth.mode !== "email_link") {
      return null;
    }
    if (context.surface === "agent_auth_init") {
      return this.authorizeInit(context);
    }
    return this.authorizeHello(context);
  }

  private authorizeInit(context: AgentAuthInitContext): RelayAuthDecision {
    const init = context.message.payload;
    const audit = {
      surface: context.surface,
      deviceId: init.device_id,
      remoteIp: context.remoteIp,
    } as const;

    const device = this.options.getDevice(init.device_id);
    if (!device) {
      return this.closeAgentHello(audit, "device_not_registered");
    }
    if (device.revoked_at) {
      return this.closeAgentHello(audit, "device_revoked");
    }
    if (!sameRelayDevicePublicKey(device.public_key, init.device_public_key)) {
      return this.closeAgentHello(audit, "public_key_mismatch");
    }

    const verified = (
      this.options.verifyInitSignature ?? verifyRelayDeviceInitSignature
    )({
      publicKey: device.public_key,
      init,
      skewMs: this.options.config.auth.agentAuthClockSkewMs,
    });
    if (!verified.ok) {
      return this.closeAgentHello(audit, "invalid_signature", verified.reason);
    }

    return {
      ok: true,
      subject: {
        userId: device.user_id,
        deviceId: device.id,
      },
    };
  }

  private authorizeHello(context: AgentHelloAuthContext): RelayAuthDecision {
    const hello = context.message.payload;
    const audit = {
      surface: context.surface,
      deviceId: hello.device_id,
      remoteIp: context.remoteIp,
    } as const;

    const device = this.options.getDevice(hello.device_id);
    if (!device) {
      return this.closeAgentHello(audit, "device_not_registered");
    }
    if (device.revoked_at) {
      return this.closeAgentHello(audit, "device_revoked");
    }

    const verified = (
      this.options.verifySignature ?? verifyRelayDeviceSignature
    )({
      publicKey: device.public_key,
      hello,
      skewMs: this.options.config.auth.agentAuthClockSkewMs,
      challengeSecret: this.options.challengeSecret,
      connectionId: context.connectionId,
    });
    if (!verified.ok) {
      const reason = verified.reason.includes("challenge")
        ? "invalid_challenge"
        : "invalid_signature";
      return this.closeAgentHello(audit, reason, verified.reason);
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
    reason: AgentDeviceIdentityFailureReason,
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
