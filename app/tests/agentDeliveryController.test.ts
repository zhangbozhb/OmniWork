import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { DeliveryEpisodeSummary } from "@omni-work/protocol-ts";
import {
  agentDeliveryOutcomeSet,
  agentDeliverySyncRequest,
} from "../src/features/agent/agentMessages.ts";
import { mergeEpisodes } from "../src/features/agent/useAgentDeliveryController.ts";

function episode(
  id: string,
  outcome?: DeliveryEpisodeSummary["outcome"],
): DeliveryEpisodeSummary {
  return {
    episode_id: id,
    session_id: "session-1",
    surface_id: "surface-1",
    provider: "codex",
    status: "delivered",
    outcome,
    objective: "Ship it",
    started_at: "2026-08-15T00:00:00.000Z",
    delivered_at: "2026-08-15T00:01:00.000Z",
    updated_at: "2026-08-15T00:01:00.000Z",
    observation_count: 3,
  };
}

test("mergeEpisodes replaces outcome revisions by episode id", () => {
  const merged = mergeEpisodes(
    [episode("episode-1"), episode("episode-2")],
    [episode("episode-1", "accepted")],
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.outcome, "accepted");
});

test("agent delivery message helpers bind sync and outcome to the surface", () => {
  const sync = agentDeliverySyncRequest(
    "device-1",
    "session-1",
    "surface-1",
  );
  const outcome = agentDeliveryOutcomeSet(
    "device-1",
    episode("episode-1"),
    "revision_requested",
    "  Add a test  ",
  );

  assert.equal(sync.type, "agent.delivery");
  assert.equal(sync.session_id, "session-1");
  assert.equal(
    (sync.payload as { kind?: string }).kind,
    "sync_request",
  );
  assert.equal(outcome.type, "agent.delivery");
  assert.equal(
    (outcome.payload as { outcome?: string }).outcome,
    "revision_requested",
  );
  assert.equal(
    (outcome.payload as { note?: string }).note,
    "Add a test",
  );
});
