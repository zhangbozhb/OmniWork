# @omni-work/protocol-ts

Shared TypeScript protocol types, runtime schemas, and pairing utilities for
OmniWork.

## Install

```sh
npm install @omni-work/protocol-ts
```

## Usage

```ts
import {
  createMessage,
  parseMessageEnvelope,
  PROTOCOL_VERSION,
} from "@omni-work/protocol-ts";

const message = createMessage("session.list", { sessions: [] });
const parsed = parseMessageEnvelope(message);

console.log(PROTOCOL_VERSION, parsed);
```

This package is ESM-only and requires Node.js 20.19 or newer when used in Node.

Structured Agent sessions use `agent.surface.event` plus cursor-based
`agent.surface.sync` for timeline recovery. Approval and user-input workflows
use the strict `agent.interaction` request, answer, result, and sync payloads.
`agent.prompt.submit` can include additive `context_files` Workspace references;
file contents are resolved and validated by the Desktop Agent.

Source and issue tracking are available in the
[OmniWork repository](https://github.com/zhangbozhb/OmniWork).
