#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_URL = "http://127.0.0.1:17669/api/probes/hooks";

async function main() {
  const body = await readHookPayload();
  const token = await resolveToken();
  if (!token) {
    process.exitCode = 0;
    return;
  }

  const response = await fetch(
    process.env.OMNIWORK_AGENT_PROBE_URL ?? DEFAULT_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body,
    },
  );
  if (!response.ok) {
    process.exitCode = 0;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readHookPayload() {
  const raw = await readStdin();
  let payload;
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return raw;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return raw;
  }

  const hookEvent =
    process.env.OMNIWORK_AGENT_HOOK_EVENT?.trim() ??
    process.env.OMNIWORK_CODEX_HOOK_EVENT?.trim();
  if (hookEvent) {
    if (typeof payload.hook_event_name !== "string") {
      payload.hook_event_name = hookEvent;
    }
    payload.omniwork_hook_event = hookEvent;
  }

  const hookSource =
    process.env.OMNIWORK_AGENT_HOOK_SOURCE?.trim() ??
    process.env.OMNIWORK_HOOK_SOURCE?.trim() ??
    process.env.OMNIWORK_CODEX_HOOK_SOURCE?.trim();
  if (hookSource) {
    payload.omniwork_hook_source = hookSource;
  }

  return JSON.stringify(payload);
}

async function resolveToken() {
  const envToken = process.env.OMNIWORK_AGENT_PROBE_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }
  const sessionKeyPath =
    process.env.OMNIWORK_SESSION_KEY_PATH ??
    join(
      homedir(),
      "Library",
      "Application Support",
      "OmniWork",
      "agent",
      "session-key.json",
    );
  try {
    const parsed = JSON.parse(await readFile(sessionKeyPath, "utf8"));
    return typeof parsed.key === "string" ? parsed.key : undefined;
  } catch {
    return undefined;
  }
}

main().catch(() => {
  process.exitCode = 0;
});
