import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ensureClaudeHooksInstalled } from "../src/probes/claudeHookInstaller.ts";

test("ensureClaudeHooksInstalled creates user settings with OmniWork hooks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-claude-hooks-"));
  const settingsPath = join(dir, ".claude", "settings.json");

  const result = await ensureClaudeHooksInstalled({
    settingsPath,
    receiverUrl: "http://127.0.0.1:17669/api/probes/hooks",
    sessionKeyPath: "/tmp/session-key.json",
  });
  const parsed = JSON.parse(await readFile(settingsPath, "utf8"));

  assert.equal(result.installed, true);
  assert.equal(result.changed, true);
  assert.equal(parsed.hooks.SessionStart.length, 1);
  assert.equal(parsed.hooks.UserPromptSubmit.length, 1);
  assert.equal(parsed.hooks.PreToolUse.length, 1);
  assert.equal(parsed.hooks.PermissionRequest.length, 1);
  assert.equal(parsed.hooks.PostToolUse.length, 1);
  assert.equal(parsed.hooks.PostToolUseFailure.length, 1);
  assert.equal(parsed.hooks.PermissionDenied.length, 1);
  assert.equal(parsed.hooks.Notification.length, 1);
  assert.equal(parsed.hooks.PreCompact.length, 1);
  assert.equal(parsed.hooks.PostCompact.length, 1);
  assert.equal(parsed.hooks.SubagentStart.length, 1);
  assert.equal(parsed.hooks.SubagentStop.length, 1);
  assert.equal(parsed.hooks.Stop.length, 1);
  assert.equal(parsed.hooks.SessionEnd.length, 1);
  assert.match(
    parsed.hooks.SessionStart[0].hooks[0].command,
    /OMNIWORK_AGENT_HOOK_SOURCE='claude-code'/u,
  );
  assert.match(
    parsed.hooks.SessionStart[0].hooks[0].command,
    /OMNIWORK_AGENT_HOOK_EVENT='SessionStart'/u,
  );
  assert.match(
    parsed.hooks.PermissionRequest[0].hooks[0].command,
    /OMNIWORK_AGENT_HOOK_EVENT='PermissionRequest'/u,
  );
  assert.match(
    parsed.hooks.Notification[0].hooks[0].command,
    /OMNIWORK_AGENT_HOOK_EVENT='Notification'/u,
  );
  assert.match(
    parsed.hooks.SessionEnd[0].hooks[0].command,
    /OMNIWORK_AGENT_HOOK_EVENT='SessionEnd'/u,
  );
  assert.match(
    parsed.hooks.Stop[0].hooks[0].command,
    /OMNIWORK_SESSION_KEY_PATH='\/tmp\/session-key\.json'/u,
  );
  assert.match(
    parsed.hooks.Stop[0].hooks[0].command,
    /omniwork-agent-hook\.mjs/u,
  );
});

test("ensureClaudeHooksInstalled preserves existing hooks and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-claude-hooks-"));
  const settingsPath = join(dir, "settings.json");
  await writeFile(
    settingsPath,
    JSON.stringify({
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

  const first = await ensureClaudeHooksInstalled({ settingsPath });
  const second = await ensureClaudeHooksInstalled({ settingsPath });
  const parsed = JSON.parse(await readFile(settingsPath, "utf8"));

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(parsed.other, true);
  assert.equal(parsed.hooks.Stop.length, 2);
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, "echo existing");
});

test("ensureClaudeHooksInstalled removes stale OmniWork hook commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-claude-hooks-"));
  const settingsPath = join(dir, "settings.json");
  await writeFile(
    settingsPath,
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
        PermissionRequest: [
          {
            hooks: [
              {
                type: "command",
                command: "node /old/path/omniwork-agent-hook.mjs",
              },
            ],
          },
        ],
      },
    }),
  );

  const result = await ensureClaudeHooksInstalled({
    settingsPath,
    receiverUrl: "http://127.0.0.1:17669/api/probes/hooks",
    sessionKeyPath: "/tmp/current-session-key.json",
  });
  const parsed = JSON.parse(await readFile(settingsPath, "utf8"));

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
    /\/old\/path\/omniwork-agent-hook\.mjs/u,
  );
  assert.match(
    parsed.hooks.PermissionRequest[0].hooks[0].command,
    /OMNIWORK_AGENT_HOOK_SOURCE='claude-code'/u,
  );
  assert.match(
    parsed.hooks.PermissionRequest[0].hooks[0].command,
    /OMNIWORK_AGENT_HOOK_EVENT='PermissionRequest'/u,
  );
});

test("ensureClaudeHooksInstalled does not overwrite invalid json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-claude-hooks-"));
  const settingsPath = join(dir, "settings.json");
  await writeFile(settingsPath, "{");

  const result = await ensureClaudeHooksInstalled({ settingsPath });

  assert.equal(result.installed, false);
  assert.equal(result.reason, "invalid_json");
  assert.equal(await readFile(settingsPath, "utf8"), "{");
});
