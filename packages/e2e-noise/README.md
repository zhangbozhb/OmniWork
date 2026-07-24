# @omni-work/e2e-noise

Noise NNpsk0 handshake and encrypted-session primitives used by OmniWork
transports.

## Install

```sh
npm install @omni-work/e2e-noise
```

## Usage

```ts
import { createInitiatorHandshake } from "@omni-work/e2e-noise";

const handshake = createInitiatorHandshake({
  pairingKey: "replace-with-a-shared-secret",
  deviceId: "device-id",
  agentConnectionId: "agent-connection",
  appConnectionId: "app-connection",
});

// Send handshake.init to the responder, then pass its reply to:
// const session = handshake.complete(reply);
```

The pairing key is a secret and must not be logged or transmitted outside the
encrypted pairing flow. This package is ESM-only and requires Node.js 20.19 or
newer.

Source and issue tracking are available in the
[OmniWork repository](https://github.com/zhangbozhb/OmniWork).
