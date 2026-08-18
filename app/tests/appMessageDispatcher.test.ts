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

test("dispatchAppMessage routes Git action responses but not requests", () => {
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
  const response = {
    kind: "response" as const,
    request_id: "request-1",
    action_id: "action-1",
    workspacePath: "/tmp/project",
    operation: "stage" as const,
    paths: ["src/index.ts"],
    result: "completed" as const,
  };

  dispatchAppMessage(createMessage("git.action", response), handlers);
  dispatchAppMessage(
    createMessage("git.action", {
      kind: "request",
      action_id: "action-2",
      workspacePath: "/tmp/project",
      operation: { type: "stage", paths: ["src/index.ts"] },
    }),
    handlers,
  );

  assert.deepEqual(calls, [{ name: "onGitAction", payload: response }]);
});

test("dispatchAppMessage routes delivery episode updates", () => {
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
  const payload = {
    kind: "episode_updated" as const,
    episode: {
      episode_id: "episode-1",
      session_id: "session-1",
      surface_id: "surface-1",
      status: "delivered" as const,
      started_at: "2026-08-15T00:00:00.000Z",
      delivered_at: "2026-08-15T00:01:00.000Z",
      updated_at: "2026-08-15T00:01:00.000Z",
      observation_count: 3,
    },
  };

  dispatchAppMessage(createMessage("agent.delivery", payload), handlers);

  assert.deepEqual(calls, [{ name: "onAgentDelivery", payload }]);
});

test("dispatchAppMessage routes experience candidate updates", () => {
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
  const payload = {
    kind: "candidate_updated" as const,
    candidate: {
      candidate_id: "candidate-1",
      project_id: "project-1",
      kind: "user_correction" as const,
      trigger: "When implementing",
      guidance: "Add tests",
      status: "candidate" as const,
      support_count: 1,
      contradiction_count: 0,
      supporting_episode_ids: ["episode-1"],
      contradicting_episode_ids: [],
      created_at: "2026-08-15T00:00:00.000Z",
      updated_at: "2026-08-15T00:01:00.000Z",
    },
  };

  dispatchAppMessage(createMessage("agent.experience", payload), handlers);

  assert.deepEqual(calls, [{ name: "onAgentExperience", payload }]);
});
