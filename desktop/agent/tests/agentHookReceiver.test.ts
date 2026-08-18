import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { AgentHookReceiver } from "../src/probes/agentHookReceiver.ts";

test("AgentHookReceiver acknowledges before ordered processing completes", async () => {
  const port = await reservePort();
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  let secondStarted!: () => void;
  const firstStartedPromise = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const secondStartedPromise = new Promise<void>((resolve) => {
    secondStarted = resolve;
  });
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const receiver = new AgentHookReceiver({
    host: "127.0.0.1",
    port,
    token: "test-token",
    onProbeEvent: async (event) => {
      if (event.session_id === "session-1") {
        firstStarted();
        await firstRelease;
        return;
      }
      secondStarted();
    },
  });
  await receiver.start();

  try {
    const firstResponse = await postHook(port, "session-1");
    assert.equal(firstResponse.status, 202);
    await firstStartedPromise;

    const secondResponse = await postHook(port, "session-2");
    assert.equal(secondResponse.status, 202);
    const startedBeforeRelease = await Promise.race([
      secondStartedPromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    assert.equal(startedBeforeRelease, false);

    releaseFirst();
    await secondStartedPromise;
  } finally {
    releaseFirst();
    receiver.close();
  }
});

async function postHook(port: number, sessionId: string): Promise<Response> {
  return fetch(
    `http://127.0.0.1:${port}/api/probes/hooks?source=claude-code`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: sessionId,
        hook_event_name: "UserPromptSubmit",
        prompt: "Implement the feature",
      }),
      signal: AbortSignal.timeout(1_000),
    },
  );
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
