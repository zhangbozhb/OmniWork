import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createMessage,
  type AgentPromptSubmitPayload,
  type AgentSurfaceEventPayload,
} from "@omni-work/protocol-ts";
import { AgentMessageDispatcher } from "../src/core/agentMessageDispatcher.ts";

test("AgentMessageDispatcher records the original prompt before controlled preparation", async () => {
  const published: AgentSurfaceEventPayload[] = [];
  const prepared: AgentPromptSubmitPayload[] = [];
  const submitted: AgentPromptSubmitPayload[] = [];
  const payload: AgentPromptSubmitPayload = {
    session_id: "session-1",
    surface_id: "surface-1",
    prompt: "Original prompt",
    origin: "git_review",
  };
  const options = {
    config: {},
    logger: {},
    security: {
      recordInboundBusiness: () => true,
    },
    tunnelUpgrade: {},
    sessionRequests: {},
    resourceRequests: {},
    terminalRequests: {},
    terminalStreamPusher: {},
    inbox: {},
    delivery: {},
    experience: {},
    interactions: {},
    surfaceSync: {},
    publishAgentSurfaceEvent: (event: AgentSurfaceEventPayload) => {
      published.push(event);
    },
    prepareAgentPrompt: (input: AgentPromptSubmitPayload) => {
      prepared.push(input);
      return { ...input, prompt: "Injected experience\n\nOriginal prompt" };
    },
    submitAgentPrompt: (input: AgentPromptSubmitPayload) => {
      submitted.push(input);
    },
  } as unknown as ConstructorParameters<typeof AgentMessageDispatcher>[0];
  const dispatcher = new AgentMessageDispatcher(options);

  await dispatcher.dispatch(
    createMessage("agent.prompt.submit", payload, {
      device_id: "device-1",
      session_id: "session-1",
      surface_id: "surface-1",
    }),
  );

  assert.equal(published[0]?.payload?.prompt, "Original prompt");
  assert.equal(published[0]?.payload?.prompt_origin, "git_review");
  assert.equal(published[0]?.summary, "Original prompt");
  assert.equal(prepared[0]?.prompt, "Original prompt");
  assert.equal(
    submitted[0]?.prompt,
    "Injected experience\n\nOriginal prompt",
  );
  assert.equal(payload.prompt, "Original prompt");
});
