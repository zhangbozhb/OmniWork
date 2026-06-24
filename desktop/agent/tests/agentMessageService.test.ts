import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { AgentProbeEvent } from "@omniwork/protocol-ts";
import { AgentMessageService } from "../src/probes/agentMessageService.ts";

function probeEvent(overrides: Partial<AgentProbeEvent>): AgentProbeEvent {
  return {
    id: "event-1",
    provider: "codex",
    probe_id: "codex-hooks",
    session_id: "sess-1",
    event_type: "agent.approval_required",
    severity: "warning",
    title: "Codex needs approval",
    summary: "npm test",
    source: {
      kind: "cli-hook",
      raw_event_id: "tool-1",
    },
    created_at: "2026-06-24T00:00:00.000Z",
    ...overrides,
  };
}

test("AgentMessageService converts actionable probe events to app messages", () => {
  const pushed = [];
  const service = new AgentMessageService({
    onMessage(message) {
      pushed.push(message);
    },
  });

  const message = service.publishProbeEvent(probeEvent({}));

  assert.equal(message?.provider, "codex");
  assert.equal(message?.message_kind, "approval");
  assert.equal(message?.priority, "high");
  assert.equal(message?.action?.type, "open_approval");
  assert.equal(service.list().length, 1);
  assert.equal(pushed.length, 1);
});

test("AgentMessageService deduplicates probe events and filters low value events", () => {
  const service = new AgentMessageService();
  const actionable = probeEvent({ id: "same" });
  const ignored = probeEvent({
    id: "ignored",
    event_type: "agent.tool_call_started",
  });

  assert.ok(service.publishProbeEvent(actionable));
  assert.equal(service.publishProbeEvent(actionable), null);
  assert.equal(service.publishProbeEvent(ignored), null);
  assert.equal(service.list().length, 1);
});

test("AgentMessageService supports read ack and filtered list", () => {
  const service = new AgentMessageService();
  const first = service.publishProbeEvent(probeEvent({ id: "first" }));
  service.publishProbeEvent(
    probeEvent({
      id: "second",
      session_id: "sess-2",
      provider: "claude-code",
      event_type: "agent.failed",
      severity: "critical",
    }),
  );

  assert.ok(first);
  assert.equal(service.list({ provider: "codex" }).length, 1);
  assert.equal(service.list({ session_id: "sess-2" }).length, 1);
  assert.equal(service.ack(first.id, true)?.read_at !== undefined, true);
  assert.equal(service.list({ unread_only: true }).length, 1);
});
