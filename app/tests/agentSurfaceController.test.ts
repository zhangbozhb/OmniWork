import { strict as assert } from "node:assert";
import { test } from "node:test";

import type {
  AgentInteractionRequestPayload,
  AgentSurfaceEventPayload,
} from "@omni-work/protocol-ts";
import { mergeAgentSurfaceEvents } from "../src/features/agent/useAgentSurfaceController.ts";
import {
  deriveAgentSessionAttention,
  reducePendingAgentInteractions,
} from "../src/features/agent/useAgentInteractionController.ts";

function event(
  eventId: string,
  summary: string,
  createdAt: string,
): AgentSurfaceEventPayload {
  return {
    session_id: "session-1",
    surface_id: "surface-1",
    provider: "codex",
    event_id: eventId,
    event_type: "agent.thinking",
    title: "Working",
    summary,
    created_at: createdAt,
  };
}

test("mergeAgentSurfaceEvents replaces revisions and preserves timeline order", () => {
  const merged = mergeAgentSurfaceEvents(
    [
      event("event-2", "old", "2026-08-01T00:00:02.000Z"),
      event("event-1", "first", "2026-08-01T00:00:01.000Z"),
    ],
    [
      event("event-2", "updated", "2026-08-01T00:00:02.000Z"),
      event("event-3", "last", "2026-08-01T00:00:03.000Z"),
    ],
  );

  assert.deepEqual(
    merged.map((item) => [item.event_id, item.summary]),
    [
      ["event-1", "first"],
      ["event-2", "updated"],
      ["event-3", "last"],
    ],
  );
});

function interaction(
  interactionId: string,
  createdAt: string,
  details: AgentInteractionRequestPayload["details"] = {
    type: "command_approval",
    command: "pnpm test",
  },
): AgentInteractionRequestPayload {
  return {
    kind: "request",
    interaction_id: interactionId,
    session_id: "session-1",
    surface_id: "surface-1",
    provider: "codex",
    title: "Approval required",
    details,
    status: "pending",
    created_at: createdAt,
    expires_at: "2026-08-01T00:05:00.000Z",
  };
}

test("reducePendingAgentInteractions restores, upserts, and resolves requests", () => {
  const restored = reducePendingAgentInteractions([], {
    kind: "sync_response",
    request_id: "request-1",
    interactions: [
      interaction("interaction-2", "2026-08-01T00:00:02.000Z"),
      interaction("interaction-1", "2026-08-01T00:00:01.000Z"),
    ],
  });
  assert.deepEqual(
    restored.map((item) => item.interaction_id),
    ["interaction-1", "interaction-2"],
  );

  const updated = reducePendingAgentInteractions(
    restored,
    interaction("interaction-2", "2026-08-01T00:00:03.000Z"),
  );
  assert.equal(updated.length, 2);
  assert.equal(updated[1]?.created_at, "2026-08-01T00:00:03.000Z");

  const resolved = reducePendingAgentInteractions(updated, {
    kind: "result",
    interaction_id: "interaction-2",
    session_id: "session-1",
    surface_id: "surface-1",
    status: "resolved",
    resolved_at: "2026-08-01T00:00:04.000Z",
  });
  assert.deepEqual(
    resolved.map((item) => item.interaction_id),
    ["interaction-1"],
  );
});

test("deriveAgentSessionAttention prioritizes user input and counts requests", () => {
  const attention = deriveAgentSessionAttention([
    interaction("approval-1", "2026-08-01T00:00:01.000Z"),
    interaction(
      "input-1",
      "2026-08-01T00:00:02.000Z",
      {
        type: "user_input",
        questions: [
          {
            id: "scope",
            prompt: "Which scope?",
            required: true,
          },
        ],
      },
    ),
    {
      ...interaction("approval-2", "2026-08-01T00:00:03.000Z"),
      session_id: "session-2",
    },
  ]);

  assert.deepEqual(attention, {
    "session-1": { kind: "waiting_input", count: 2 },
    "session-2": { kind: "waiting_approval", count: 1 },
  });
});
