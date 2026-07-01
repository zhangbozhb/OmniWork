import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  defaultTraeHooksPath,
  discoverTraeHookTargets,
  ensureTraeFamilyHooksInstalled,
  ensureTraeHooksInstalled,
} from "../src/probes/traeHookInstaller.ts";

test("ensureTraeHooksInstalled creates hooks.json with OmniWork hooks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-trae-hooks-"));
  const hooksPath = join(dir, ".trae-cn", "hooks.json");

  const result = await ensureTraeHooksInstalled({
    hooksPath,
    provider: "trae-cn",
    receiverUrl: "http://127.0.0.1:17669/api/probes/hooks",
    sessionKeyPath: "/tmp/session-key.json",
  });
  const parsed = JSON.parse(await readFile(hooksPath, "utf8"));

  assert.equal(result.installed, true);
  assert.equal(result.changed, true);
  assert.equal(result.hooksPath, hooksPath);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.hooks.SessionStart.length, 1);
  assert.equal(parsed.hooks.UserPromptSubmit.length, 1);
  assert.equal(parsed.hooks.PreToolUse[0].matcher, "*");
  assert.equal(parsed.hooks.PermissionRequest[0].matcher, "*");
  assert.equal(parsed.hooks.PostToolUseFailure[0].matcher, "*");
  assert.equal(parsed.hooks.SessionEnd.length, 1);
  assert.match(
    parsed.hooks.SessionStart[0].hooks[0].command,
    /OMNIWORK_AGENT_HOOK_SOURCE='trae-cn'/u,
  );
  assert.match(
    parsed.hooks.SessionStart[0].hooks[0].command,
    /OMNIWORK_SESSION_KEY_PATH='\/tmp\/session-key\.json'/u,
  );
  assert.match(
    parsed.hooks.SessionStart[0].hooks[0].command,
    /omniwork-agent-hook\.mjs/u,
  );
});

test("ensureTraeHooksInstalled preserves existing hooks and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-trae-hooks-"));
  const hooksPath = join(dir, "hooks.json");
  await writeFile(
    hooksPath,
    JSON.stringify({
      version: 1,
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "echo existing",
              },
            ],
          },
        ],
      },
      other: true,
    }),
  );

  const first = await ensureTraeHooksInstalled({ hooksPath });
  const second = await ensureTraeHooksInstalled({ hooksPath });
  const parsed = JSON.parse(await readFile(hooksPath, "utf8"));

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(parsed.other, true);
  assert.equal(parsed.hooks.Stop.length, 2);
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, "echo existing");
  assert.equal(countManagedCommands(parsed), 14);
});

test("ensureTraeHooksInstalled removes stale OmniWork hook commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-trae-hooks-"));
  const hooksPath = join(dir, "hooks.json");
  await writeFile(
    hooksPath,
    JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "node /old/path/omniwork-agent-hook.mjs",
              },
              {
                type: "command",
                command: "echo existing",
              },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: "node /other/old/path/omniwork-agent-hook.mjs",
              },
            ],
          },
        ],
      },
    }),
  );

  const result = await ensureTraeHooksInstalled({
    hooksPath,
    provider: "trae",
    sessionKeyPath: "/tmp/current-session-key.json",
  });
  const parsed = JSON.parse(await readFile(hooksPath, "utf8"));

  assert.equal(result.installed, true);
  assert.equal(result.changed, true);
  assert.equal(parsed.hooks.Stop.length, 2);
  assert.equal(parsed.hooks.Stop[0].hooks.length, 1);
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, "echo existing");
  assert.doesNotMatch(
    JSON.stringify(parsed),
    /\/old\/path\/omniwork-agent-hook\.mjs/u,
  );
  assert.doesNotMatch(
    JSON.stringify(parsed),
    /\/other\/old\/path\/omniwork-agent-hook\.mjs/u,
  );
  assert.match(
    parsed.hooks.UserPromptSubmit[0].hooks[0].command,
    /OMNIWORK_AGENT_HOOK_SOURCE='trae'/u,
  );
  assert.match(
    parsed.hooks.UserPromptSubmit[0].hooks[0].command,
    /OMNIWORK_SESSION_KEY_PATH='\/tmp\/current-session-key\.json'/u,
  );
});

test("defaultTraeHooksPath separates Trae and Trae CN hooks files", () => {
  assert.match(defaultTraeHooksPath("trae"), /\/\.trae\/hooks\.json$/u);
  assert.match(defaultTraeHooksPath("trae-cn"), /\/\.trae-cn\/hooks\.json$/u);
});

test("ensureTraeFamilyHooksInstalled installs every detected Trae hooks file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-trae-hooks-"));
  await writeFile(join(dir, ".keep"), "");
  await ensureDir(join(dir, ".trae"));
  await ensureDir(join(dir, ".trae-cn"));

  const results = await ensureTraeFamilyHooksInstalled({
    homeDir: dir,
    receiverUrl: "http://127.0.0.1:17669/api/probes/hooks",
  });

  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((result) => result.provider).sort(),
    ["trae", "trae-cn"],
  );

  const trae = JSON.parse(
    await readFile(join(dir, ".trae", "hooks.json"), "utf8"),
  );
  const traeCn = JSON.parse(
    await readFile(join(dir, ".trae-cn", "hooks.json"), "utf8"),
  );
  assert.match(
    trae.hooks.SessionStart[0].hooks[0].command,
    /OMNIWORK_AGENT_HOOK_SOURCE='trae'/u,
  );
  assert.match(
    traeCn.hooks.SessionStart[0].hooks[0].command,
    /OMNIWORK_AGENT_HOOK_SOURCE='trae-cn'/u,
  );
});

test("discoverTraeHookTargets falls back to requested provider when no config dirs exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-trae-hooks-"));

  const targets = await discoverTraeHookTargets({
    homeDir: dir,
    provider: "trae-cn",
  });

  assert.deepEqual(targets, [
    {
      provider: "trae-cn",
      hooksPath: join(dir, ".trae-cn", "hooks.json"),
    },
  ]);
});

test("ensureTraeHooksInstalled does not overwrite invalid json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-trae-hooks-"));
  const hooksPath = join(dir, "hooks.json");
  await writeFile(hooksPath, "{");

  const result = await ensureTraeHooksInstalled({ hooksPath });

  assert.equal(result.installed, false);
  assert.equal(result.reason, "invalid_json");
  assert.equal(await readFile(hooksPath, "utf8"), "{");
});

function countManagedCommands(value: unknown): number {
  const hooks = (value as { hooks?: Record<string, unknown> }).hooks ?? {};
  return Object.values(hooks).reduce<number>((count, groups) => {
    if (!Array.isArray(groups)) {
      return count;
    }
    return (
      count +
      groups.filter((group) =>
        JSON.stringify(group).includes("omniwork-agent-hook"),
      ).length
    );
  }, 0);
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
