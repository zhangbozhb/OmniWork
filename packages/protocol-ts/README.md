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
Controlled Git index writes use the strict `git.action` request/response union.
Only typed `stage` and `unstage` operations are currently defined; each request
has an action ID and a bounded list of explicit Workspace-relative paths.
Managed Worktree discovery and creation use `git.worktree`; create requests
accept only a validated short name, leaving branch, base, and destination
selection to the Desktop Agent.
`session.create.managed_worktree` capability allows `session.create` to carry a
validated `managed_worktree` descriptor and `create_action_id`, so worktree
creation and Runtime startup are handled as one idempotent in-process intent.

Source and issue tracking are available in the
[OmniWork repository](https://github.com/zhangbozhb/OmniWork).
