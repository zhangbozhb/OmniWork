import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createMessage,
  type AgentAppMessage,
} from "@omni-work/protocol-ts";
import {
  dispatchAppMessage,
  type AppMessageHandlers,
} from "../src/app/appMessageDispatcher.ts";

test("dispatchAppMessage routes recovered Agent inbox pages", () => {
  const message: AgentAppMessage = {
    id: "message-1",
    type: "agent.message",
    provider: "codex",
    session_id: "session-1",
    surface_id: "surface-1",
    message_kind: "approval",
    title: "Agent needs approval",
    priority: "high",
    created_at: "2026-08-01T00:00:00.000Z",
  };
  const calls: Array<{ name: string; payload: unknown }> = [];
  const handlers = new Proxy(
    {},
    {
      get(_target, property) {
        return (payload: unknown) => {
          calls.push({ name: String(property), payload });
        };
      },
    },
  ) as AppMessageHandlers;

  dispatchAppMessage(
    createMessage("agent.message.list", { messages: [message] }),
    handlers,
  );

  assert.deepEqual(calls, [
    {
      name: "onAgentMessageList",
      payload: { messages: [message] },
    },
  ]);
});
