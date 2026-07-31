import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("omniwork-hook-record writes Trae records locally", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-hook-record-"));
  const script = new URL(
    "../../../packages/surface-hook-record/bin/omniwork-hook-record.mjs",
    import.meta.url,
  );

  await runHookScript(script, {
    env: {
      ...process.env,
      OMNIWORK_AGENT_HOOK_SOURCE: "trae",
      OMNIWORK_AGENT_HOOK_EVENT: "UserPromptSubmit",
      OMNIWORK_TRAE_RECORDS_DIR: dir,
      OMNIWORK_SESSION_KEY_PATH: join(dir, "missing-session-key.json"),
    },
    input: JSON.stringify({
      session_id: "sess-1",
      workspace_path: "/tmp/project",
      prompt: "persist this full prompt",
    }),
  });

  const files = await readdir(join(dir, "sessions"));
  assert.equal(files.filter((file) => file.endsWith(".jsonl")).length, 1);
  const recordFile = files.find((file) => file.endsWith(".jsonl"));
  assert.ok(recordFile);
  const lines = (await readFile(join(dir, "sessions", recordFile), "utf8"))
    .trim()
    .split(/\r?\n/u);
  const record = JSON.parse(lines[0] ?? "{}");

  assert.equal(record.provider, "trae");
  assert.equal(record.hook_event, "UserPromptSubmit");
  assert.equal(record.payload.session_id, "sess-1");
  assert.equal(record.payload.hook_event_name, "UserPromptSubmit");
  assert.equal(record.payload.omniwork_hook_source, "trae");
  assert.equal(typeof record.payload.omniwork_record_id, "string");
  assert.equal(record.payload_mode, "full");
  assert.equal(record.payload.prompt, "persist this full prompt");
  assert.equal(record.conversation.user_input, "persist this full prompt");
  assert.equal(record.normalized.type, "message");
  assert.equal(record.normalized.role, "user");
  assert.equal(record.normalized.content, "persist this full prompt");
  assert.equal(record.coverage.has_user_input, true);
  assert.equal(record.coverage.has_model_response, false);
  assert.equal(record.delivery, undefined);
});

test("omniwork-hook-record keeps TraeX distinct from Trae IDE", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-hook-record-traex-"));
  const script = new URL(
    "../../../packages/surface-hook-record/bin/omniwork-hook-record.mjs",
    import.meta.url,
  );

  await runHookScript(script, {
    env: {
      ...process.env,
      OMNIWORK_AGENT_HOOK_SOURCE: "traex",
      OMNIWORK_AGENT_HOOK_EVENT: "SessionStart",
      OMNIWORK_TRAE_RECORDS_DIR: dir,
    },
    input: JSON.stringify({ session_id: "sess-traex" }),
  });

  const files = await readdir(join(dir, "sessions"));
  const recordFile = files.find((file) => file.endsWith(".jsonl"));
  assert.ok(recordFile);
  const record = JSON.parse(
    (await readFile(join(dir, "sessions", recordFile), "utf8")).trim(),
  );
  assert.equal(record.provider, "traex");
  assert.equal(record.payload.omniwork_hook_source, "traex");
});

test("omniwork-hook-record extracts model responses from Stop hooks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-hook-record-stop-"));
  const script = new URL(
    "../../../packages/surface-hook-record/bin/omniwork-hook-record.mjs",
    import.meta.url,
  );

  await runHookScript(script, {
    env: {
      ...process.env,
      OMNIWORK_AGENT_HOOK_SOURCE: "trae-cn",
      OMNIWORK_AGENT_HOOK_EVENT: "Stop",
      OMNIWORK_TRAE_RECORDS_DIR: dir,
    },
    input: JSON.stringify({
      session_id: "sess-2",
      cwd: "/tmp/project",
      last_assistant_message: "model response content",
    }),
  });

  const files = await readdir(join(dir, "sessions"));
  const recordFile = files.find((file) => file.endsWith(".jsonl"));
  assert.ok(recordFile);
  const lines = (await readFile(join(dir, "sessions", recordFile), "utf8"))
    .trim()
    .split(/\r?\n/u);
  const record = JSON.parse(lines[0] ?? "{}");

  assert.equal(record.provider, "trae-cn");
  assert.equal(record.hook_event, "Stop");
  assert.equal(record.payload.last_assistant_message, "model response content");
  assert.equal(record.conversation.model_response, "model response content");
  assert.equal(record.normalized.type, "message");
  assert.equal(record.normalized.role, "assistant");
  assert.equal(record.normalized.content, "model response content");
  assert.equal(record.coverage.has_model_response, true);
  assert.equal(record.coverage.response_source, "last_assistant_message");
});

test("omniwork-hook-record does not record tool hooks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-hook-record-tool-"));
  const script = new URL(
    "../../../packages/surface-hook-record/bin/omniwork-hook-record.mjs",
    import.meta.url,
  );

  await runHookScript(script, {
    env: {
      ...process.env,
      OMNIWORK_AGENT_HOOK_SOURCE: "trae",
      OMNIWORK_AGENT_HOOK_EVENT: "PostToolUse",
      OMNIWORK_TRAE_RECORDS_DIR: dir,
    },
    input: JSON.stringify({
      session_id: "sess-tool",
      cwd: "/tmp/project",
      tool_name: "Bash",
      tool_use_id: "tool-1",
      tool_input: { command: "echo hi" },
      tool_response: { stdout: "hi\n" },
    }),
  });

  await assert.rejects(readdir(join(dir, "sessions")));
});

test("omniwork-hook-record does not record notification hooks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-hook-record-notify-"));
  const script = new URL(
    "../../../packages/surface-hook-record/bin/omniwork-hook-record.mjs",
    import.meta.url,
  );

  await runHookScript(script, {
    env: {
      ...process.env,
      OMNIWORK_AGENT_HOOK_SOURCE: "trae-cn",
      OMNIWORK_AGENT_HOOK_EVENT: "Notification",
      OMNIWORK_TRAE_RECORDS_DIR: dir,
    },
    input: JSON.stringify({
      session_id: "sess-notification",
      cwd: "/tmp/project",
      notification_type: "idle_prompt",
      message: "notification should not be recorded",
    }),
  });

  await assert.rejects(readdir(join(dir, "sessions")));
});

test("omniwork-hook-record records payloads without a provider source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-hook-record-unknown-"));
  const script = new URL(
    "../../../packages/surface-hook-record/bin/omniwork-hook-record.mjs",
    import.meta.url,
  );

  await runHookScript(script, {
    env: {
      ...process.env,
      OMNIWORK_AGENT_HOOK_SOURCE: "",
      OMNIWORK_TRAE_RECORDS_DIR: dir,
    },
    input: JSON.stringify({
      session_id: "sess-unknown",
      hook_event_name: "UserPromptSubmit",
      cwd: "/tmp/project",
      prompt: "unknown provider input",
    }),
  });

  const files = await readdir(join(dir, "sessions"));
  const recordFile = files.find((file) => file.endsWith(".jsonl"));
  assert.ok(recordFile);
  const record = JSON.parse(
    (await readFile(join(dir, "sessions", recordFile), "utf8")).trim(),
  );

  assert.equal(record.provider, "trae-unknown");
  assert.equal(record.normalized.content, "unknown provider input");
  assert.equal(record.payload.prompt, "unknown provider input");
});

test("omniwork-hook-record defaults to provider records only", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "omniwork-hook-record-home-"));
  const projectDir = await mkdtemp(
    join(tmpdir(), "omniwork-hook-record-project-"),
  );
  const script = new URL(
    "../../../packages/surface-hook-record/bin/omniwork-hook-record.mjs",
    import.meta.url,
  );

  await runHookScript(script, {
    cwd: projectDir,
    env: {
      ...process.env,
      HOME: homeDir,
      OMNIWORK_AGENT_HOOK_SOURCE: "trae-cn",
      OMNIWORK_AGENT_HOOK_EVENT: "UserPromptSubmit",
      OMNIWORK_TRAE_RECORDS_DIR: "",
    },
    input: JSON.stringify({
      session_id: "sess-global-only",
      cwd: projectDir,
      workspace_path: projectDir,
      prompt: "global only prompt",
    }),
  });

  const providerRecord = JSON.parse(
    (
      await readFirstJsonl(join(homeDir, ".trae-cn", "omniwork", "records"))
    ).line,
  );

  assert.equal(providerRecord.normalized.content, "global only prompt");
  await assert.rejects(
    readdir(join(projectDir, ".trae", "omniwork", "records", "sessions")),
  );
});

test("omniwork-hook-record ignores records scope", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "omniwork-hook-record-home-"));
  const projectDir = await mkdtemp(
    join(tmpdir(), "omniwork-hook-record-project-"),
  );
  const script = new URL(
    "../../../packages/surface-hook-record/bin/omniwork-hook-record.mjs",
    import.meta.url,
  );

  await runHookScript(script, {
    cwd: projectDir,
    env: {
      ...process.env,
      HOME: homeDir,
      OMNIWORK_AGENT_HOOK_SOURCE: "trae-cn",
      OMNIWORK_AGENT_HOOK_EVENT: "UserPromptSubmit",
      OMNIWORK_TRAE_RECORDS_DIR: "",
      OMNIWORK_TRAE_RECORDS_SCOPE: "project-only",
    },
    input: JSON.stringify({
      session_id: "sess-scope-ignored",
      cwd: projectDir,
      workspace_path: projectDir,
      prompt: "scope ignored prompt",
    }),
  });

  const providerRecord = JSON.parse(
    (
      await readFirstJsonl(join(homeDir, ".trae-cn", "omniwork", "records"))
    ).line,
  );
  assert.equal(providerRecord.normalized.content, "scope ignored prompt");
  await assert.rejects(
    readdir(join(projectDir, ".trae", "omniwork", "records", "sessions")),
  );
});

test("omniwork-hook-record serializes concurrent writes with a file lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-hook-record-lock-"));
  const script = new URL(
    "../../../packages/surface-hook-record/bin/omniwork-hook-record.mjs",
    import.meta.url,
  );

  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      runHookScript(script, {
        env: {
          ...process.env,
          OMNIWORK_AGENT_HOOK_SOURCE: "trae-cn",
          OMNIWORK_AGENT_HOOK_EVENT: "UserPromptSubmit",
          OMNIWORK_TRAE_RECORDS_DIR: dir,
        },
        input: JSON.stringify({
          session_id: `sess-lock-${index}`,
          cwd: "/tmp/project",
          prompt: `locked prompt ${index}`,
        }),
      }),
    ),
  );

  const recordFile = (await readFirstJsonl(dir)).file;
  const records = (await readFile(join(dir, "sessions", recordFile), "utf8"))
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  const prompts = records.map((record) => record.payload.prompt).sort();

  assert.deepEqual(
    prompts,
    Array.from({ length: 8 }, (_, index) => `locked prompt ${index}`),
  );
});

test("omniwork-hook-record installs hooks only to global Trae config", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "omniwork-hook-record-home-"));
  const projectDir = await mkdtemp(
    join(tmpdir(), "omniwork-hook-record-project-"),
  );
  await mkdir(join(homeDir, ".trae-cn"), { recursive: true });
  await mkdir(join(projectDir, ".trae"), { recursive: true });
  const script = new URL(
    "../../../packages/surface-hook-record/bin/omniwork-hook-record.mjs",
    import.meta.url,
  );

  await runHookScript(script, {
    args: ["install"],
    cwd: projectDir,
    env: {
      ...process.env,
      HOME: homeDir,
      OMNIWORK_AGENT_HOOK_SOURCE: "trae-cn",
    },
    input: "",
  });

  const globalHooks = JSON.parse(
    await readFile(join(homeDir, ".trae-cn", "hooks.json"), "utf8"),
  );
  assert.match(
    globalHooks.hooks.UserPromptSubmit[0].hooks[0].command,
    /omniwork-hook-record\.mjs/u,
  );
  await assert.rejects(readFile(join(projectDir, ".trae", "hooks.json"), "utf8"));
  await assert.rejects(
    readdir(join(projectDir, ".trae", "omniwork", "records", "sessions")),
  );
  await assert.rejects(
    readdir(join(homeDir, ".trae", "omniwork", "records", "sessions")),
  );
  await assert.rejects(
    readdir(join(homeDir, ".trae-cn", "omniwork", "records", "sessions")),
  );
});

test("omniwork-hook-record installs TraeX hooks under the CLI config", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "omniwork-hook-record-home-"));
  const script = new URL(
    "../../../packages/surface-hook-record/bin/omniwork-hook-record.mjs",
    import.meta.url,
  );

  await runHookScript(script, {
    args: ["install"],
    env: {
      ...process.env,
      HOME: homeDir,
      OMNIWORK_AGENT_HOOK_SOURCE: "traex",
    },
    input: "",
  });

  const hooks = JSON.parse(
    await readFile(join(homeDir, ".trae", "cli", "hooks.json"), "utf8"),
  );
  assert.match(
    hooks.hooks.SessionStart[0].hooks[0].command,
    /OMNIWORK_AGENT_HOOK_SOURCE='traex'/u,
  );
  await assert.rejects(
    readFile(join(homeDir, ".trae", "hooks.json"), "utf8"),
  );
});

async function readFirstJsonl(root: string): Promise<{ file: string; line: string }> {
  const files = await readdir(join(root, "sessions"));
  const file = files.find((candidate) => !candidate.endsWith("-raw.jsonl"));
  assert.ok(file);
  const line = (await readFile(join(root, "sessions", file), "utf8"))
    .trim()
    .split(/\r?\n/u)[0];
  assert.ok(line);
  return { file, line };
}

test("omniwork-hook-post does not write Trae records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-hook-post-"));
  const script = new URL(
    "../../../packages/surface-hook-post/bin/omniwork-hook-post.mjs",
    import.meta.url,
  );

  await runHookScript(script, {
    env: {
      ...process.env,
      OMNIWORK_AGENT_HOOK_SOURCE: "trae",
      OMNIWORK_AGENT_HOOK_EVENT: "UserPromptSubmit",
      OMNIWORK_TRAE_RECORDS_DIR: dir,
      OMNIWORK_SESSION_KEY_PATH: join(dir, "missing-session-key.json"),
    },
    input: JSON.stringify({
      session_id: "sess-1",
      workspace_path: "/tmp/project",
      prompt: "post plugin should not persist this prompt",
    }),
  });

  await assert.rejects(readdir(join(dir, "sessions")));
});

test("omniwork-hook-post times out slow probe delivery", async () => {
  const script = new URL(
    "../../../packages/surface-hook-post/bin/omniwork-hook-post.mjs",
    import.meta.url,
  );
  const server = createServer(() => {
    // Keep the request open so the hook must rely on its own timeout.
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const startedAt = Date.now();
  try {
    await runHookScript(script, {
      env: {
        ...process.env,
        OMNIWORK_AGENT_PROBE_TOKEN: "test-token",
        OMNIWORK_AGENT_PROBE_TIMEOUT_MS: "50",
        OMNIWORK_AGENT_PROBE_URL: `http://127.0.0.1:${address.port}/hooks`,
        OMNIWORK_AGENT_HOOK_SOURCE: "trae",
        OMNIWORK_AGENT_HOOK_EVENT: "UserPromptSubmit",
      },
      input: JSON.stringify({
        session_id: "sess-post-timeout",
        prompt: "timeout should not block",
      }),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.ok(Date.now() - startedAt < 1500);
});

async function runHookScript(
  script: URL,
  options: {
    env: NodeJS.ProcessEnv;
    input: string;
    cwd?: string;
    args?: string[];
  },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [script.pathname, ...(options.args ?? [])], {
      env: options.env,
      cwd: options.cwd,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`hook script exited with code ${code}`));
      }
    });
    child.stdin.end(options.input);
  });
}
