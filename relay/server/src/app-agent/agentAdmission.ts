import {
  type AgentHelloPayload,
  type MessageEnvelope,
} from "@omniwork/protocol-ts";

import { RelayAuthExecutor } from "../auth/executor.ts";
import { RelayAuthGuard } from "../auth/guard.ts";
import { RuntimeTopology } from "../runtime/topology.ts";
import type { RelayStateStore } from "../relayStateStore.ts";
import type { RelayConnection } from "../relayTypes.ts";

export interface AgentAdmissionOptions {
  authGuard: RelayAuthGuard;
  authExecutor: RelayAuthExecutor;
  topology: RuntimeTopology;
  state: RelayStateStore;
}

export class AgentAdmission {
  private readonly options: AgentAdmissionOptions;

  constructor(options: AgentAdmissionOptions) {
    this.options = options;
  }

  handleAgentHello(
    connection: RelayConnection,
    message: MessageEnvelope<AgentHelloPayload>,
  ): void {
    const decision = this.options.authGuard.authorize({
      surface: "agent_hello",
      message,
    });
    if (!decision.ok) {
      this.options.authExecutor.execute(decision, { connection });
      return;
    }
    connection.userId = decision.subject?.userId;
    connection.role = "agent";
    connection.state = "registered_agent";
    connection.deviceId = message.payload.device_id;
    connection.agentInstanceId = message.payload.agent_instance_id;
    connection.keyId = message.payload.key_id;
    connection.businessSecurityMode =
      message.payload.business_security_mode ?? "e2e_required";
    connection.e2e = message.payload.e2e;
    connection.authenticated = true;
    connection.authState = "verified";
    this.options.topology.addAgentToDevice(
      message.payload.device_id,
      connection,
    );
    this.options.state.registerAgent(connection);
  }
}
