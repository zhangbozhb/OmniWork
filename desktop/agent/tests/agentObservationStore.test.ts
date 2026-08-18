import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  AgentProbeEvent,
  AgentSurfaceEventPayload,
} from "@omni-work/protocol-ts";
import {
  AgentObservationStore,
  projectIdForPath,
} from "../src/learning/agentObservationStore.ts";

async function newStore(): Promise<AgentObservationStore> {
  const directory = await mkdtemp(join(tmpdir(), "omniwork-observations-"));
  return new AgentObservationStore(join(directory, "sessions.sqlite"));
}

function probeEvent(): AgentProbeEvent {
  return {
    id: "event-1",
    provider: "codex",
    probe_id: "codex-hooks",
    session_id: "session-1",
    surface_id: "surface-1",
    workspace_path: "/tmp/project",
    event_type: "agent.completed",
    severity: "notice",
    title: "Completed",
    source: { kind: "cli-hook", raw_event_id: "turn-1" },
    created_at: "2026-08-15T00:00:00.000Z",
  };
}

function surfaceEvent(summary: string): AgentSurfaceEventPayload {
  return {
    session_id: "session-1",
    surface_id: "surface-1",
    provider: "codex",
    event_id: "event-1",
    event_type: "agent.completed",
    title: "Completed",
    summary,
    source: { kind: "app-server", raw_event_id: "turn-1" },
    created_at: "2026-08-15T00:00:00.000Z",
  };
}

test("AgentObservationStore records probe and surface observations with correlation", async () => {
  const store = await newStore();
  store.putProbeEvent(probeEvent());
  store.putSurfaceEvent(surfaceEvent("done"), "/tmp/project");

  const observations = store.listBySession("session-1");
  assert.equal(observations.length, 2);
  assert.deepEqual(
    observations.map((item) => item.kind),
    ["probe", "surface"],
  );
  assert.equal(
    observations[0]?.correlationKey,
    observations[1]?.correlationKey,
  );
  assert.equal(
    observations[0]?.projectId,
    projectIdForPath("/tmp/project"),
  );
  assert.equal(observations[1]?.projectId, observations[0]?.projectId);
});

test("AgentObservationStore updates repeated event revisions without duplicating them", async () => {
  const store = await newStore();
  store.putSurfaceEvent(surfaceEvent("partial"));
  store.putSurfaceEvent(surfaceEvent("complete"));

  const observations = store.listBySession("session-1");
  assert.equal(observations.length, 1);
  const payload = observations[0]?.payload as AgentSurfaceEventPayload;
  assert.equal(payload.summary, "complete");
});

test("projectIdForPath normalizes equivalent workspace paths", () => {
  assert.equal(
    projectIdForPath("/tmp/project"),
    projectIdForPath("/tmp/project/"),
  );
  assert.notEqual(
    projectIdForPath("/tmp/project"),
    projectIdForPath("/tmp/other"),
  );
});
