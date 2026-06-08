import {
  createMessage,
  PROTOCOL_SUPPORT_V1,
  type BusinessSecurityMode,
  type E2EFailedPayload,
  type E2EHandshakeInitPayload,
  type E2EHandshakeReplyPayload,
  type E2EMessagePayload,
  type E2EReadyPayload,
  type MessageEnvelope,
  type ProtocolErrorPayload,
} from "@omniwork/protocol-ts";

import type {
  AgentE2EPeerState,
  RelayConnection,
} from "./relayTypes.ts";

export interface RelayE2EControllerOptions {
  protocolVersion: typeof PROTOCOL_SUPPORT_V1.current;
  connections: Map<string, RelayConnection>;
  agentsByDevice: Map<string, RelayConnection>;
  send(connection: RelayConnection, message: MessageEnvelope): void;
  routeMessage(connection: RelayConnection, message: MessageEnvelope): void;
  notifyMobileAuthenticated(
    deviceId: string,
    mobile: RelayConnection,
  ): void;
}

export class RelayE2EController {
  private readonly options: RelayE2EControllerOptions;

  constructor(options: RelayE2EControllerOptions) {
    this.options = options;
  }

  handleHandshakeInit(
    connection: RelayConnection,
    message: MessageEnvelope<E2EHandshakeInitPayload>,
  ): void {
    if (connection.role !== "mobile") {
      this.rejectInvalidState(connection, "e2e.handshake.init");
      return;
    }
    if (
      !connection.authenticated ||
      connection.state !== "relay_pairing_verified"
    ) {
      this.rejectInvalidState(connection, "e2e.handshake.init");
      return;
    }
    if (message.payload.app_connection_id !== connection.id) {
      this.rejectInvalidState(connection, "e2e.handshake.init");
      return;
    }
    connection.e2eHandshakeId = message.payload.handshake_id;
    connection.e2eTranscriptHash = undefined;
    connection.e2eSessionId = undefined;
    connection.state = "e2e_handshaking";
    this.routeMobileToAgent(connection, message);
  }

  handleHandshakeReply(
    connection: RelayConnection,
    message: MessageEnvelope<E2EHandshakeReplyPayload>,
  ): void {
    if (connection.role !== "agent") {
      this.rejectInvalidState(connection, "e2e.handshake.reply");
      return;
    }
    const mobile = this.getMobileByAppConnectionId(
      connection,
      message.payload.app_connection_id,
    );
    if (!mobile || mobile.e2eHandshakeId !== message.payload.handshake_id) {
      this.rejectInvalidState(connection, "e2e.handshake.reply");
      return;
    }
    this.ensureAgentE2EPeers(connection).set(
      message.payload.app_connection_id,
      {
        handshakeId: message.payload.handshake_id,
        state: "handshaking",
      },
    );
    this.options.send(mobile, message);
  }

  handleReady(
    connection: RelayConnection,
    message: MessageEnvelope<E2EReadyPayload>,
  ): void {
    if (connection.role === "mobile") {
      if (
        connection.state !== "e2e_handshaking" ||
        message.payload.app_connection_id !== connection.id ||
        message.payload.handshake_id !== connection.e2eHandshakeId
      ) {
        this.rejectInvalidState(connection, "e2e.ready");
        return;
      }
      connection.e2eHandshakeId = message.payload.handshake_id;
      connection.e2eTranscriptHash = message.payload.transcript_hash;
      connection.state = "e2e_ready";
      this.routeMobileToAgent(connection, message);
      return;
    }

    if (connection.role !== "agent") {
      this.rejectInvalidState(connection, "e2e.ready");
      return;
    }
    const mobile = this.getMobileByAppConnectionId(
      connection,
      message.payload.app_connection_id,
    );
    const peer = connection.agentE2EPeers?.get(
      message.payload.app_connection_id,
    );
    if (!mobile || !peer || peer.handshakeId !== message.payload.handshake_id) {
      this.rejectInvalidState(connection, "e2e.ready");
      return;
    }
    peer.transcriptHash = message.payload.transcript_hash;
    peer.state = "ready";
    if (connection.deviceId) {
      this.options.notifyMobileAuthenticated(connection.deviceId, mobile);
    }
    this.options.send(mobile, message);
  }

  handleMessage(
    connection: RelayConnection,
    message: MessageEnvelope<E2EMessagePayload>,
  ): void {
    if (connection.role === "mobile") {
      if (
        connection.state !== "e2e_ready" ||
        message.payload.app_connection_id !== connection.id ||
        !this.isPairReadyForApp(connection.id, connection.deviceId)
      ) {
        this.rejectInvalidState(connection, "e2e.message");
        return;
      }
      if (
        connection.e2eSessionId &&
        connection.e2eSessionId !== message.payload.e2e_session_id
      ) {
        this.rejectInvalidState(connection, "e2e.message");
        return;
      }
      connection.e2eSessionId = message.payload.e2e_session_id;
      this.routeMobileToAgent(connection, message);
      return;
    }

    if (connection.role !== "agent") {
      this.rejectInvalidState(connection, "e2e.message");
      return;
    }
    const mobile = this.getMobileByAppConnectionId(
      connection,
      message.payload.app_connection_id,
    );
    const peer = connection.agentE2EPeers?.get(
      message.payload.app_connection_id,
    );
    if (!mobile || !peer || peer.state !== "ready") {
      this.rejectInvalidState(connection, "e2e.message");
      return;
    }
    if (
      peer.e2eSessionId &&
      peer.e2eSessionId !== message.payload.e2e_session_id
    ) {
      this.rejectInvalidState(connection, "e2e.message");
      return;
    }
    peer.e2eSessionId = message.payload.e2e_session_id;
    this.options.send(mobile, message);
  }

  handleFailed(
    connection: RelayConnection,
    message: MessageEnvelope<E2EFailedPayload>,
  ): void {
    const appConnectionId = message.payload.app_connection_id;
    if (connection.role === "mobile") {
      connection.state = connection.authenticated
        ? "relay_pairing_verified"
        : connection.state;
      connection.e2eHandshakeId = undefined;
      connection.e2eTranscriptHash = undefined;
      connection.e2eSessionId = undefined;
      this.routeMobileToAgent(connection, message);
      return;
    }
    if (connection.role === "agent" && appConnectionId) {
      connection.agentE2EPeers?.delete(appConnectionId);
      const mobile = this.getMobileByAppConnectionId(
        connection,
        appConnectionId,
      );
      if (mobile) {
        this.options.send(mobile, message);
      }
    }
  }

  routeControl(connection: RelayConnection, message: MessageEnvelope): void {
    if (connection.state !== "e2e_ready") {
      this.rejectInvalidState(connection, message.type);
      return;
    }
    if (!this.isPairReady(connection)) {
      this.rejectInvalidState(connection, message.type);
      return;
    }
    this.options.routeMessage(connection, message);
  }

  isPairReady(connection: RelayConnection): boolean {
    const appConnectionId = connection.id;
    if (!appConnectionId || !connection.deviceId) {
      return false;
    }
    return this.isPairReadyForApp(appConnectionId, connection.deviceId);
  }

  isBusinessChannelReadyForApp(
    appConnectionId: string,
    deviceId: string | undefined,
  ): boolean {
    const agent = deviceId
      ? this.options.agentsByDevice.get(deviceId)
      : undefined;
    if (agent?.businessSecurityMode === "plaintext_allowed") {
      const mobile = this.options.connections.get(appConnectionId);
      return (
        mobile?.role === "mobile" &&
        mobile.deviceId === deviceId &&
        mobile.authenticated
      );
    }
    return this.isPairReadyForApp(appConnectionId, deviceId);
  }

  shouldRejectPlaintextBusiness(connection: RelayConnection): boolean {
    return this.businessSecurityModeFor(connection) === "e2e_required";
  }

  businessSecurityModeFor(connection: RelayConnection): BusinessSecurityMode {
    if (connection.role === "agent") {
      return connection.businessSecurityMode ?? "e2e_required";
    }
    if (connection.deviceId) {
      return (
        this.options.agentsByDevice.get(connection.deviceId)
          ?.businessSecurityMode ?? "e2e_required"
      );
    }
    return "e2e_required";
  }

  rejectPlaintextBusiness(connection: RelayConnection, type: string): void {
    this.sendProtocolError(
      connection,
      "plaintext_business_rejected",
      `Message type "${type}" must be sent inside e2e.message.`,
      false,
    );
  }

  private getMobileByAppConnectionId(
    agent: RelayConnection,
    appConnectionId: string,
  ): RelayConnection | undefined {
    const mobile = this.options.connections.get(appConnectionId);
    if (
      mobile?.role !== "mobile" ||
      !agent.deviceId ||
      mobile.deviceId !== agent.deviceId
    ) {
      return undefined;
    }
    return mobile;
  }

  private ensureAgentE2EPeers(
    connection: RelayConnection,
  ): Map<string, AgentE2EPeerState> {
    if (!connection.agentE2EPeers) {
      connection.agentE2EPeers = new Map<string, AgentE2EPeerState>();
    }
    return connection.agentE2EPeers;
  }

  private routeMobileToAgent(
    connection: RelayConnection,
    message: MessageEnvelope,
  ): void {
    if (!connection.deviceId) {
      return;
    }
    const agent = this.options.agentsByDevice.get(connection.deviceId);
    if (agent) {
      this.options.send(agent, message);
    }
  }

  private isPairReadyForApp(
    appConnectionId: string,
    deviceId: string | undefined,
  ): boolean {
    if (!deviceId) {
      return false;
    }
    const mobile = this.options.connections.get(appConnectionId);
    const agent = this.options.agentsByDevice.get(deviceId);
    const peer = agent?.agentE2EPeers?.get(appConnectionId);
    return (
      mobile?.role === "mobile" &&
      mobile.deviceId === deviceId &&
      mobile.state === "e2e_ready" &&
      peer?.state === "ready" &&
      !!mobile.e2eHandshakeId &&
      mobile.e2eHandshakeId === peer.handshakeId &&
      !!mobile.e2eTranscriptHash &&
      mobile.e2eTranscriptHash === peer.transcriptHash
    );
  }

  private rejectInvalidState(
    connection: RelayConnection,
    type: string,
  ): void {
    this.sendProtocolError(
      connection,
      "invalid_state",
      `Message type "${type}" is not allowed in state "${connection.state}".`,
      false,
    );
  }

  private sendProtocolError(
    connection: RelayConnection,
    code: ProtocolErrorPayload["code"],
    detail: string,
    retryable: boolean,
  ): void {
    this.options.send(
      connection,
      createMessage<ProtocolErrorPayload>(
        "protocol.error",
        {
          v: this.options.protocolVersion,
          code,
          detail,
          retryable,
        },
        { device_id: connection.deviceId },
      ),
    );
  }
}
