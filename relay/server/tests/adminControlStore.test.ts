import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AdminControlStore } from "../src/adminControlStore.ts";

const dir = mkdtempSync(join(tmpdir(), "omniwork-relay-controls-"));

try {
  const path = join(dir, "admin-controls.sqlite");
  const store = new AdminControlStore(path);

  store.upsert({
    kind: "agent_instance_disable",
    target: "agent-instance-1",
    rule: {
      id: "rule-agent",
      reason: "maintenance",
      createdAt: 1000,
    },
  });
  store.upsert({
    kind: "ip_ban",
    target: "203.0.113.10",
    rule: {
      id: "rule-ip",
      createdAt: 2000,
    },
  });

  const reloaded = new AdminControlStore(path);
  const records = reloaded.load();

  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => [record.kind, record.target]),
    [
      ["agent_instance_disable", "agent-instance-1"],
      ["ip_ban", "203.0.113.10"],
    ],
  );

  reloaded.delete("agent_instance_disable", "agent-instance-1");
  assert.equal(reloaded.load().length, 1);

  console.log("admin control store tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
