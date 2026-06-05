import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { CodexSession } from "@omniwork/protocol-ts";
import {
  formatRelayCloseMessage,
  formatStrictForceCloseMessage,
  isSamePairing,
  upsertPairing,
  upsertSession,
} from "../src/app/appModel";

const baseSession: CodexSession = {
  session_id: "sess-1",
  runtime_kind: "codex",
  runtime_label: "Codex",
  title: "Demo",
  cwd: "/tmp",
  command: "codex",
  status: "running",
  created_at: new Date(0).toISOString(),
  last_active_at: new Date(0).toISOString(),
  terminal_size: { cols: 80, rows: 24 },
  tmux_session_name: "omni-sess-1",
};

test("upsertSession inserts and replaces by session_id", () => {
  assert.deepEqual(upsertSession([], baseSession), [baseSession]);

  const renamed = { ...baseSession, title: "Renamed" };
  assert.deepEqual(upsertSession([baseSession], renamed), [renamed]);
});

test("upsertPairing replaces by relay URL and device ID", () => {
  const first = {
    relayUrl: "wss://relay.example/mobile",
    deviceId: "mac-1",
    key: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  const refreshed = { ...first, key: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };

  assert.equal(isSamePairing(first, refreshed), true);
  assert.deepEqual(upsertPairing([first], refreshed), [refreshed]);
});

test("connection close helpers keep user-facing detail", () => {
  assert.equal(
    formatRelayCloseMessage({ code: 1003, reason: "invalid protocol message" }),
    "Connection closed (1003): invalid protocol message",
  );
  assert.match(
    formatStrictForceCloseMessage("strict_unavailable:backoff_active"),
    /cooling down/,
  );
});
