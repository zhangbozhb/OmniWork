import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createMessage,
  type AgentSurfaceEventPayload,
  type AgentSurfaceSyncRequestPayload,
  type AgentSurfaceSyncResponsePayload,
  type MessageEnvelope,
} from "@omni-work/protocol-ts";
import { AgentSurfaceEventStore } from "../src/agent-surface/agentSurfaceEventStore.ts";
import { AgentSurfaceSyncHandler } from "../src/core/agentSurfaceSyncHandler.ts";

function event(
  eventId: string,
  summary: string,
  surfaceId = "surface-1",
): AgentSurfaceEventPayload {
  return {
    session_id: "session-1",
    surface_id: surfaceId,
    provider: "codex",
    event_id: eventId,
    event_type: "agent.thinking",
    title: "Working",
    summary,
    created_at: "2026-08-01T00:00:00.000Z",
  };
}

async function newStore(): Promise<AgentSurfaceEventStore> {
  const directory = await mkdtemp(join(tmpdir(), "omniwork-surface-events-"));
  return new AgentSurfaceEventStore(join(directory, "sessions.sqlite"));
}

test("AgentSurfaceEventStore persists and pages events by surface", async () => {
  const store = await newStore();
  const firstCursor = store.put(event("event-1", "one"));
  store.put(event("event-other", "other", "surface-2"));
  store.put(event("event-2", "two"));

  const firstPage = store.list("session-1", "surface-1", 0, 1);
  assert.deepEqual(firstPage.events.map((item) => item.event_id), ["event-1"]);
  assert.equal(firstPage.nextCursor, firstCursor);
  assert.equal(firstPage.hasMore, true);

  const secondPage = store.list(
    "session-1",
    "surface-1",
    firstPage.nextCursor,
    10,
  );
  assert.deepEqual(secondPage.events.map((item) => item.event_id), ["event-2"]);
  assert.equal(secondPage.hasMore, false);
});

test("AgentSurfaceEventStore republishes updated event revisions", async () => {
  const store = await newStore();
  const initialCursor = store.put(event("event-1", "partial"));
  const updatedCursor = store.put(event("event-1", "complete"));

  assert.ok(updatedCursor > initialCursor);
  const page = store.list("session-1", "surface-1", initialCursor);
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0]?.summary, "complete");
  assert.equal(page.nextCursor, updatedCursor);
});

test("AgentSurfaceSyncHandler replies to the requesting app with a cursor page", async () => {
  const store = await newStore();
  store.put(event("event-1", "one"));
  const sent: MessageEnvelope[] = [];
  const handler = new AgentSurfaceSyncHandler({
    deviceId: "device-1",
    store,
    sendToApp: (context, message) => {
      assert.equal(context?.appConnectionId, "app-1");
      sent.push(message);
    },
  });
  const requestPayload: AgentSurfaceSyncRequestPayload = {
    kind: "request",
    session_id: "session-1",
    surface_id: "surface-1",
    after_cursor: 0,
    limit: 100,
  };
  const request = createMessage(
    "agent.surface.sync",
    requestPayload,
    {
      device_id: "device-1",
      session_id: "session-1",
      surface_id: "surface-1",
    },
  );

  handler.handleSync(request, {
    appConnectionId: "app-1",
    trustedE2E: true,
  });

  assert.equal(sent.length, 1);
  const payload = sent[0]?.payload as AgentSurfaceSyncResponsePayload;
  assert.equal(payload.kind, "response");
  assert.equal(payload.request_id, request.id);
  assert.equal(payload.session_id, "session-1");
  assert.deepEqual(payload.events.map((item) => item.event_id), ["event-1"]);
  assert.equal(payload.has_more, false);
});
