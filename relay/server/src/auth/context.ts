import {
  type AgentHelloPayload,
  type MessageEnvelope,
  type MobileConnectPayload,
} from "@omniwork/protocol-ts";
import type { IncomingMessage } from "node:http";

import type { RelayEndpoint } from "../relayTypes.ts";

export type RelayWsUpgradeAuthContext = {
  surface: "relay_ws_upgrade";
  endpoint: RelayEndpoint;
  remoteIp: string;
};

export type AgentHelloAuthContext = {
  surface: "agent_hello";
  message: MessageEnvelope<AgentHelloPayload>;
};

export type MobileConnectAuthContext = {
  surface: "mobile_connect";
  message: MessageEnvelope<MobileConnectPayload>;
  connectionUserId?: string;
};

export type AdminHttpAuthContext = {
  surface: "admin_http";
  request: IncomingMessage;
  pathname: string;
  method: string;
  requireSession: boolean;
  requireCsrf: boolean;
};

export type RelayAuthContext =
  | RelayWsUpgradeAuthContext
  | AgentHelloAuthContext
  | MobileConnectAuthContext
  | AdminHttpAuthContext;
