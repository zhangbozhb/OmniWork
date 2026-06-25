import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentAppMessage } from "@omniwork/protocol-ts";
import { AgentMessageStore } from "../src/probes/agentMessageStore.ts";

function message(overrides: Partial<AgentAppMessage> = {}): AgentAppMessage {
  return {
    id: "msg-1",
    type: "agent.message",
    provider: "codex",
    session_id: "sess-1",
    surface_id: "surface_sess-1_terminal",
    message_kind: "approval",
    title: "Approval required",
    priority: "high",
    action: {
      type: "open_approval",
      session_id: "sess-1",
      surface_id: "surface_sess-1_terminal",
    },
    created_at: "2026-06-25T00:00:00.000Z",
    ...overrides,
  };
}

test("AgentMessageStore persists pending inbox messages and deduplicates events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-agent-messages-"));
  const path = join(dir, "sessions.sqlite");
  const store = new AgentMessageStore(path);

  assert.ok(store.insertMessage("event-1", message()));
  assert.equal(store.insertMessage("event-1", message({ id: "msg-2" })), null);

  const reopened = new AgentMessageStore(path);
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.list({ surface_id: "surface_sess-1_terminal" }).length, 1);
  assert.equal(reopened.ack("msg-1", true)?.read_at !== undefined, true);
  assert.equal(reopened.list({ unread_only: true }).length, 0);
});

test("AgentMessageStore persists notification settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-agent-messages-"));
  const path = join(dir, "sessions.sqlite");
  const store = new AgentMessageStore(path);

  assert.equal(store.getNotificationSettings().enabled, true);
  store.setNotificationSettings({
    enabled: false,
    min_priority: "critical",
    muted_providers: ["codex"],
    muted_message_kinds: ["approval"],
  });

  const reopened = new AgentMessageStore(path);
  assert.deepEqual(reopened.getNotificationSettings(), {
    enabled: false,
    min_priority: "critical",
    muted_providers: ["codex"],
    muted_message_kinds: ["approval"],
  });
});
