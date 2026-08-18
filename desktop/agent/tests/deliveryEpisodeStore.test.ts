import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  AgentProbeEvent,
  AgentProbeEventType,
  AgentSurfaceEventPayload,
} from "@omni-work/protocol-ts";
import { AgentObservationStore } from "../src/learning/agentObservationStore.ts";
import {
  DeliveryEpisodeStore,
  type DeliveryEpisode,
} from "../src/learning/deliveryEpisodeStore.ts";

async function stores(): Promise<{
  observations: AgentObservationStore;
  episodes: DeliveryEpisodeStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "omniwork-episodes-"));
  const path = join(directory, "sessions.sqlite");
  return {
    observations: new AgentObservationStore(path),
    episodes: new DeliveryEpisodeStore(path),
  };
}

function surfaceEvent(input: {
  id: string;
  type: AgentProbeEventType;
  provider?: string;
  title?: string;
  summary?: string;
  rawEventId?: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
}): AgentSurfaceEventPayload {
  return {
    session_id: "session-1",
    surface_id: "surface-1",
    provider: input.provider ?? "codex",
    event_id: input.id,
    event_type: input.type,
    title: input.title ?? input.type,
    summary: input.summary,
    payload: input.payload,
    source: {
      kind: input.provider === "user" ? "process" : "app-server",
      raw_event_id: input.rawEventId ?? input.id,
    },
    created_at: input.createdAt ?? "2026-08-15T00:00:00.000Z",
  };
}

function deliverEpisode(
  observations: AgentObservationStore,
  episodes: DeliveryEpisodeStore,
): string {
  const prompt = episodes.apply(
    observations.putSurfaceEvent(
      surfaceEvent({
        id: "prompt-outcome",
        type: "agent.user_prompt_submitted",
        provider: "user",
        payload: { prompt: "Ship it" },
      }),
    ),
  );
  episodes.apply(
    observations.putSurfaceEvent(
      surfaceEvent({
        id: "turn-outcome",
        type: "agent.completed",
        title: "Codex turn completed",
        rawEventId: "turn:outcome:completed",
      }),
    ),
  );
  return prompt?.episodeId ?? "";
}

test("DeliveryEpisodeStore builds a delivered episode from a structured turn", async () => {
  const { observations, episodes } = await stores();
  episodes.apply(
    observations.putSurfaceEvent(
      surfaceEvent({
        id: "prompt-1",
        type: "agent.user_prompt_submitted",
        provider: "user",
        payload: { prompt: "Implement the feature" },
      }),
      "/tmp/project",
    ),
  );
  episodes.apply(
    observations.putSurfaceEvent(
      surfaceEvent({
        id: "assistant-1",
        type: "agent.completed",
        summary: "Initial answer",
        rawEventId: "assistant:item-1",
        payload: {
          message_role: "assistant",
          phase: "completed",
          item: { type: "agent_message", text: "Initial answer" },
        },
      }),
      "/tmp/project",
    ),
  );

  let episode = episodes.listBySession("session-1")[0];
  assert.equal(episode?.status, "working");
  assert.equal(episode?.finalResponse, "Initial answer");

  episodes.apply(
    observations.putSurfaceEvent(
      surfaceEvent({
        id: "turn-1",
        type: "agent.completed",
        title: "Codex turn completed",
        rawEventId: "turn:turn-1:completed",
        createdAt: "2026-08-15T00:00:02.000Z",
      }),
      "/tmp/project",
    ),
  );

  episode = episodes.listBySession("session-1")[0];
  assert.equal(episode?.status, "delivered");
  assert.equal(episode?.objective, "Implement the feature");
  assert.equal(episode?.provider, "codex");
  assert.equal(episode?.observationCount, 3);
  assert.ok(episode?.projectId);
  assert.equal(episode?.deliveredAt, "2026-08-15T00:00:02.000Z");
});

test("DeliveryEpisodeStore applies event revisions idempotently", async () => {
  const { observations, episodes } = await stores();
  const prompt = observations.putSurfaceEvent(
    surfaceEvent({
      id: "prompt-1",
      type: "agent.user_prompt_submitted",
      provider: "user",
      payload: { prompt: "Answer" },
    }),
  );
  episodes.apply(prompt);
  const answer = (text: string) =>
    observations.putSurfaceEvent(
      surfaceEvent({
        id: "assistant-1",
        type: "agent.completed",
        summary: text,
        rawEventId: "assistant:item-1",
        payload: {
          message_role: "assistant",
          item: { type: "agent_message", text },
        },
      }),
    );

  episodes.apply(answer("partial"));
  episodes.apply(answer("complete"));

  const episode = episodes.listBySession("session-1")[0];
  assert.equal(episode?.observationCount, 2);
  assert.equal(episode?.finalResponse, "complete");
  assert.equal(episodes.observationKeys(episode?.episodeId ?? "").length, 2);
});

test("DeliveryEpisodeStore abandons an unfinished episode on the next prompt", async () => {
  const { observations, episodes } = await stores();
  for (const [id, prompt, createdAt] of [
    ["prompt-1", "First", "2026-08-15T00:00:00.000Z"],
    ["prompt-2", "Second", "2026-08-15T00:00:01.000Z"],
  ] as const) {
    episodes.apply(
      observations.putSurfaceEvent(
        surfaceEvent({
          id,
          type: "agent.user_prompt_submitted",
          provider: "user",
          payload: { prompt },
          createdAt,
        }),
      ),
    );
  }

  const result = episodes.listBySession("session-1");
  assert.deepEqual(
    result.map((episode) => episode.status),
    ["abandoned", "working"],
  );
});

test("DeliveryEpisodeStore recognizes hook Stop but not tool failures as terminal", async () => {
  const { observations, episodes } = await stores();
  const probe = (
    id: string,
    eventType: AgentProbeEventType,
    payload: Record<string, unknown>,
  ): AgentProbeEvent => ({
    id,
    provider: "trae-cn",
    probe_id: "trae-cn-hooks",
    session_id: "hook-session",
    workspace_path: "/tmp/project",
    event_type: eventType,
    severity: eventType === "agent.failed" ? "critical" : "notice",
    payload,
    source: { kind: "cli-hook", raw_event_id: id },
    created_at: `2026-08-15T00:00:0${id.length}.000Z`,
  });

  episodes.apply(
    observations.putProbeEvent(
      probe("prompt", "agent.user_prompt_submitted", {
        hook_event_name: "UserPromptSubmit",
        prompt: "Fix the test",
      }),
    ),
  );
  episodes.apply(
    observations.putProbeEvent(
      probe("tool-failure", "agent.failed", {
        hook_event_name: "PostToolUseFailure",
      }),
    ),
  );
  assert.equal(
    episodes.listBySession("hook-session")[0]?.status,
    "working",
  );

  episodes.apply(
    observations.putProbeEvent(
      probe("stop", "agent.completed", {
        hook_event_name: "Stop",
        last_assistant_message: "Fixed",
      }),
    ),
  );
  const episode = episodes.listBySession("hook-session")[0];
  assert.equal(episode?.status, "delivered");
  assert.equal(episode?.finalResponse, "Fixed");
});

test("DeliveryEpisodeStore persists explicit outcomes independently from delivery status", async () => {
  const { observations, episodes } = await stores();
  const episodeId = deliverEpisode(observations, episodes);
  const input = {
    kind: "outcome_set" as const,
    episode_id: episodeId,
    session_id: "session-1",
    surface_id: "surface-1",
    client_action_id: "action-1",
    outcome: "accepted" as const,
    note: "Looks good",
    created_at: "2026-08-15T00:01:00.000Z",
  };

  const applied = episodes.setOutcome(input);
  const duplicate = episodes.setOutcome(input);
  const conflict = episodes.setOutcome({
    ...input,
    outcome: "revision_requested",
  });
  const stale = episodes.setOutcome({
    ...input,
    client_action_id: "action-stale",
    outcome: "revision_requested",
    created_at: "2026-08-15T00:00:30.000Z",
  });

  assert.equal(applied.result, "applied");
  assert.equal(duplicate.result, "duplicate");
  assert.equal(conflict.result, "conflict");
  assert.equal(stale.result, "applied");
  const episode = episodes.get(episodeId);
  assert.equal(episode?.status, "delivered");
  assert.equal(episode?.outcome, "accepted");
  assert.equal(episode?.outcomeNote, "Looks good");
  assert.equal(episode?.outcomeAt, "2026-08-15T00:01:00.000Z");
});

test("DeliveryEpisodeStore rejects outcomes for working or mismatched episodes", async () => {
  const { observations, episodes } = await stores();
  const working = episodes.apply(
    observations.putSurfaceEvent(
      surfaceEvent({
        id: "prompt-working",
        type: "agent.user_prompt_submitted",
        provider: "user",
        payload: { prompt: "Still working" },
      }),
    ),
  );
  const input = {
    kind: "outcome_set" as const,
    episode_id: working?.episodeId ?? "",
    session_id: "session-1",
    surface_id: "surface-1",
    client_action_id: "action-working",
    outcome: "accepted" as const,
    created_at: "2026-08-15T00:01:00.000Z",
  };

  assert.equal(episodes.setOutcome(input).result, "invalid_state");
  assert.equal(
    episodes.setOutcome({ ...input, session_id: "other" }).result,
    "not_found",
  );
});

test("DeliveryEpisodeStore infers a review revision only when user outcome is absent", async () => {
  const { observations, episodes } = await stores();
  const episodeId = deliverEpisode(observations, episodes);
  const reviewObservation = observations.putSurfaceEvent(
    surfaceEvent({
      id: "review-prompt",
      type: "agent.user_prompt_submitted",
      provider: "user",
      payload: {
        prompt: "Please address the review notes.",
        prompt_origin: "git_review",
      },
      createdAt: "2026-08-15T00:02:00.000Z",
    }),
  );

  const revised = episodes.recordGitReviewRevision(reviewObservation);
  assert.equal(revised?.outcome, "revision_requested");
  assert.equal(revised?.outcomeSource, "git_review");
  assert.equal(
    episodes.toSummary(revised as DeliveryEpisode).signals?.[0]?.kind,
    "review_revision_requested",
  );

  const next = episodes.apply(reviewObservation);
  episodes.apply(
    observations.putSurfaceEvent(
      surfaceEvent({
        id: "review-turn",
        type: "agent.completed",
        rawEventId: "turn:review:completed",
        createdAt: "2026-08-15T00:03:00.000Z",
      }),
    ),
  );
  const accepted = episodes.setOutcome({
    kind: "outcome_set",
    episode_id: next?.episodeId ?? "",
    session_id: "session-1",
    surface_id: "surface-1",
    client_action_id: "review-accepted",
    outcome: "accepted",
    created_at: "2026-08-15T00:04:00.000Z",
  });
  assert.equal(accepted.result, "applied");

  const secondReview = observations.putSurfaceEvent(
    surfaceEvent({
      id: "review-prompt-2",
      type: "agent.user_prompt_submitted",
      provider: "user",
      payload: {
        prompt: "Please address one more review note.",
        prompt_origin: "git_review",
      },
      createdAt: "2026-08-15T00:05:00.000Z",
    }),
  );
  const preserved = episodes.recordGitReviewRevision(secondReview);
  assert.equal(preserved?.outcome, "accepted");
  assert.equal(preserved?.outcomeSource, "user");
  assert.equal(episodes.signals(next?.episodeId ?? "").length, 1);
});

test("DeliveryEpisodeStore records test evidence without inferring acceptance", async () => {
  const { observations, episodes } = await stores();
  const started = episodes.apply(
    observations.putSurfaceEvent(
      surfaceEvent({
        id: "prompt-test",
        type: "agent.user_prompt_submitted",
        provider: "user",
        payload: { prompt: "Run the test suite" },
      }),
    ),
  );
  const commandEvent = (status: "completed" | "failed", exitCode: number) =>
    observations.putSurfaceEvent(
      surfaceEvent({
        id: "test-command",
        type:
          status === "failed"
            ? "agent.failed"
            : "agent.tool_call_finished",
        payload: {
          item: {
            type: "command_execution",
            command: "pnpm test",
            status,
            exit_code: exitCode,
          },
        },
        createdAt: "2026-08-15T00:00:01.000Z",
      }),
    );

  episodes.apply(commandEvent("completed", 0));
  assert.equal(
    episodes.signals(started?.episodeId ?? "")[0]?.kind,
    "test_passed",
  );
  assert.equal(episodes.get(started?.episodeId ?? "")?.outcome, undefined);

  episodes.apply(commandEvent("failed", 1));
  assert.equal(
    episodes.signals(started?.episodeId ?? "")[0]?.kind,
    "test_failed",
  );
  assert.equal(episodes.signals(started?.episodeId ?? "").length, 1);
  assert.equal(episodes.get(started?.episodeId ?? "")?.outcome, undefined);
});
