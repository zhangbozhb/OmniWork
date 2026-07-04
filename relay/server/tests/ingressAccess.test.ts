import { strict as assert } from "node:assert";

import {
  RELAY_AGENT_IP_BANNED_CLOSE_REASON,
  RELAY_AGENT_SHUTDOWN_CLOSE_CODE,
} from "@omniwork/protocol-ts";

import { evaluateRelayIngressAccess } from "../src/ingress/accessControl.ts";

{
  const decision = evaluateRelayIngressAccess({
    endpoint: "agent",
    remoteIp: "203.0.113.10",
    activeIpBan: () => ({ reason: "test" }),
  });

  assert.deepEqual(decision, {
    ok: false,
    reason: "ip_banned",
    statusCode: 403,
    websocketClose: {
      code: RELAY_AGENT_SHUTDOWN_CLOSE_CODE,
      reason: RELAY_AGENT_IP_BANNED_CLOSE_REASON,
    },
  });
}

{
  const decision = evaluateRelayIngressAccess({
    endpoint: "mobile",
    remoteIp: "203.0.113.10",
    activeIpBan: () => ({ reason: "test" }),
  });

  assert.deepEqual(decision, {
    ok: false,
    reason: "ip_banned",
    statusCode: 403,
  });
}

{
  const decision = evaluateRelayIngressAccess({
    endpoint: "agent",
    remoteIp: "203.0.113.10",
    activeIpBan: () => null,
  });

  assert.deepEqual(decision, { ok: true });
}

console.log("ingress access tests passed");
