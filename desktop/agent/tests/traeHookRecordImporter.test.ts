import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentProbeEvent } from "@omni-work/protocol-ts";
import { importTraeHookRecords } from "../src/probes/traeHookRecordImporter.ts";

test("importTraeHookRecords imports Trae records and records an import index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-trae-records-"));
  const recordsRoot = join(dir, ".trae", "omniwork", "records");
  const sessionsDir = join(recordsRoot, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, "2026-07-23.jsonl"),
    `${JSON.stringify({
      schema_version: 1,
      record_id: "record-1",
      provider: "trae",
      hook_event: "Notification",
      created_at: "2026-07-23T10:20:30.000Z",
      payload: {
        session_id: "sess-1",
        notification_type: "idle_prompt",
        message: "Done",
      },
    })}\n`,
  );
  await writeFile(
    join(sessionsDir, "2026-07-23-raw.jsonl"),
    `${JSON.stringify({
      schema_version: 1,
      record_id: "raw-record-1",
      provider: "trae",
      hook_event: "Notification",
      received_at: "2026-07-23T10:20:30.000Z",
      payload: {
        session_id: "raw-sess-1",
        notification_type: "idle_prompt",
        message: "Raw should not be imported directly",
      },
    })}\n`,
  );

  const events: AgentProbeEvent[] = [];
  const first = await importTraeHookRecords({
    roots: [{ provider: "trae", recordsRoot }],
    onProbeEvent: (event) => {
      events.push(event);
    },
  });
  const second = await importTraeHookRecords({
    roots: [{ provider: "trae", recordsRoot }],
    onProbeEvent: (event) => {
      events.push(event);
    },
  });
  const index = JSON.parse(
    await readFile(join(recordsRoot, "import-index.json"), "utf8"),
  );

  assert.equal(first[0]?.imported, 1);
  assert.equal(first[0]?.files, 1);
  assert.equal(first[0]?.skipped, 0);
  assert.equal(second[0]?.imported, 0);
  assert.equal(second[0]?.skipped, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.id, "record-1");
  assert.equal(events[0]?.event_type, "agent.completed");
  assert.equal(events[0]?.created_at, "2026-07-23T10:20:30.000Z");
  assert.deepEqual(index.imported_record_ids, ["record-1"]);
});
