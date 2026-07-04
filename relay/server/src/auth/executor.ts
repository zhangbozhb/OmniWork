import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

import {
  createMessage,
  type AuthFailedPayload,
  type MessageEnvelope,
} from "@omniwork/protocol-ts";

import { rejectWebSocketUpgrade } from "../ingress/identity.ts";
import type { RelayConnection } from "../relayTypes.ts";
import { acceptWebSocket } from "../websocket.ts";
import type { RelayAuthDecision } from "./decision.ts";

export interface RelayAuthExecutorOptions {
  send(connection: RelayConnection, message: MessageEnvelope): void;
}

export type RelayAuthExecutorTarget =
  | {
      request: IncomingMessage;
      socket: Socket;
    }
  | {
      connection: RelayConnection;
    }
  | {
      response: ServerResponse;
    };

export class RelayAuthExecutor {
  private readonly options: RelayAuthExecutorOptions;

  constructor(options: RelayAuthExecutorOptions) {
    this.options = options;
  }

  execute(
    decision: Exclude<RelayAuthDecision, { ok: true }>,
    target: RelayAuthExecutorTarget,
  ): void {
    switch (decision.action.kind) {
      case "close_ws":
        if ("connection" in target) {
          target.connection.socket.close(
            decision.action.code,
            decision.action.reason,
          );
        } else if ("socket" in target) {
          acceptWebSocket(target.request, target.socket)?.close(
            decision.action.code,
            decision.action.reason,
          );
        }
        return;
      case "reject_http":
        if ("response" in target) {
          writeJson(target.response, decision.action.statusCode, {
            error: decision.action.message,
          });
          return;
        }
        if ("connection" in target) {
          target.connection.socket.close(1011, "invalid auth action");
          return;
        }
        rejectWebSocketUpgrade(
          target.socket,
          decision.action.message,
          decision.action.statusCode,
        );
        return;
      case "send_auth_failed":
        if (!("connection" in target)) {
          if ("socket" in target) {
            rejectWebSocketUpgrade(target.socket, "invalid auth action", 403);
          } else {
            writeJson(target.response, 403, { error: "invalid auth action" });
          }
          return;
        }
        this.options.send(
          target.connection,
          createMessage<AuthFailedPayload>(
            "auth.failed",
            {
              reason: decision.action.authReason,
              connection_id: target.connection.id,
              retry_after_ms: decision.action.retryAfterMs,
            },
            {
              device_id:
                decision.audit.deviceId ?? target.connection.deviceId,
            },
          ),
        );
        return;
    }
  }
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}
