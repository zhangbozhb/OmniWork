import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createMessage,
  type AgentInteractionAnswerPayload,
  type AgentInteractionErrorPayload,
  type AgentInteractionRequestPayload,
  type AgentInteractionResultPayload,
  type AgentInteractionSyncResponsePayload,
  type MessageEnvelope,
} from "@omni-work/protocol-ts";
import { AgentInteractionService } from "../src/agent-surface/agentInteractionService.ts";
import { AgentInteractionStore } from "../src/agent-surface/agentInteractionStore.ts";
import { AgentInteractionHandler } from "../src/core/agentInteractionHandler.ts";

function request(
  interactionId = "interaction-1",
): AgentInteractionRequestPayload {
  return {
    kind: "request",
    interaction_id: interactionId,
    session_id: "session-1",
    surface_id: "surface-1",
    provider: "codex",
    title: "Command approval required",
    details: {
      type: "command_approval",
      command: "pnpm test",
      cwd: "/tmp/project",
    },
    status: "pending",
    created_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-08-01T00:05:00.000Z",
  };
}

function answer(
  clientActionId = "action-1",
  decision: AgentInteractionAnswerPayload["decision"] = "allow_once",
): AgentInteractionAnswerPayload {
  return {
    kind: "answer",
    interaction_id: "interaction-1",
    session_id: "session-1",
    surface_id: "surface-1",
    client_action_id: clientActionId,
    decision,
    created_at: "2026-08-01T00:01:00.000Z",
  };
}

async function newStorePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omniwork-interactions-"));
  return join(directory, "sessions.sqlite");
}

test("AgentInteractionStore persists pending requests and resolves once", async () => {
  const store = new AgentInteractionStore(await newStorePath());
  store.create(request());

  assert.equal(store.listPending().length, 1);
  const resolved = store.resolve(answer(), "2026-08-01T00:01:00.000Z");
  assert.equal(resolved.outcome, "resolved");
  assert.equal(resolved.result?.status, "resolved");
  assert.equal(store.listPending().length, 0);

  const duplicate = store.resolve(answer(), "2026-08-01T00:02:00.000Z");
  assert.equal(duplicate.outcome, "duplicate");
  assert.equal(duplicate.result?.client_action_id, "action-1");

  const conflict = store.resolve(
    answer("action-2", "decline"),
    "2026-08-01T00:02:00.000Z",
  );
  assert.equal(conflict.outcome, "conflict");
  assert.equal(conflict.result?.status, "resolved");

  store.create(request("interaction-2"));
  const reusedAction = store.resolve({
    ...answer(),
    interaction_id: "interaction-2",
  });
  assert.equal(reusedAction.outcome, "conflict");
  assert.equal(reusedAction.result, undefined);
});

test("AgentInteractionStore rejects answers outside the session binding", async () => {
  const store = new AgentInteractionStore(await newStorePath());
  store.create(request());

  const mismatched = {
    ...answer(),
    session_id: "session-other",
  };
  assert.equal(store.resolve(mismatched).outcome, "not_found");
  assert.equal(store.listPending().length, 1);
});

test("AgentInteractionStore expires pending requests after restart", async () => {
  const path = await newStorePath();
  const store = new AgentInteractionStore(path);
  store.create(request());

  const reopened = new AgentInteractionStore(path);
  assert.equal(reopened.listPending().length, 0);
  const result = reopened.resolve(answer());
  assert.equal(result.outcome, "conflict");
  assert.equal(result.result?.status, "expired");
});

test("AgentInteractionService resolves the provider waiter exactly once", async () => {
  const store = new AgentInteractionStore(await newStorePath());
  const requests: AgentInteractionRequestPayload[] = [];
  const results: AgentInteractionResultPayload[] = [];
  const service = new AgentInteractionService({
    store,
    onRequest: (item) => requests.push(item),
    onResult: (item) => results.push(item),
  });
  const pendingRequest = {
    ...request(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const waiter = service.request(pendingRequest);

  assert.deepEqual(requests.map((item) => item.interaction_id), [
    "interaction-1",
  ]);
  assert.equal(service.answer(answer()).outcome, "resolved");
  assert.equal((await waiter).decision, "allow_once");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.status, "resolved");

  assert.equal(service.answer(answer()).outcome, "duplicate");
  assert.equal(results.length, 1);
});

test("AgentInteractionHandler synchronizes pending requests and rejects unknown answers", async () => {
  const store = new AgentInteractionStore(await newStorePath());
  store.create(request());
  const sent: MessageEnvelope[] = [];
  const service = new AgentInteractionService({
    store,
    onRequest: () => undefined,
    onResult: () => undefined,
  });
  const handler = new AgentInteractionHandler({
    deviceId: "device-1",
    interactions: service,
    sendToApp: (context, message) => {
      assert.equal(context?.appConnectionId, "app-1");
      sent.push(message);
    },
  });
  const context = { appConnectionId: "app-1", trustedE2E: true };

  handler.handle(
    createMessage("agent.interaction", {
      kind: "sync_request",
      session_id: "session-1",
      surface_id: "surface-1",
    }),
    context,
  );
  const sync = sent[0]?.payload as AgentInteractionSyncResponsePayload;
  assert.equal(sync.kind, "sync_response");
  assert.deepEqual(
    sync.interactions.map((item) => item.interaction_id),
    ["interaction-1"],
  );

  handler.handle(
    createMessage("agent.interaction", {
      ...answer(),
      interaction_id: "missing",
    }),
    context,
  );
  const error = sent[1]?.payload as AgentInteractionErrorPayload;
  assert.equal(error.kind, "error");
  assert.equal(error.code, "not_found");
});
