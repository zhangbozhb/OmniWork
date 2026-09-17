# @omni-work/e2e-noise

Mutually authenticated signed X25519 handshake and encrypted-session
primitives used by OmniWork transports.

## Install

```sh
npm install @omni-work/e2e-noise
```

## Usage

```ts
import {
  acceptInitiatorHandshake,
  createInitiatorHandshake,
} from "@omni-work/e2e-noise";
import {
  SIGNATURE_DOMAINS,
  generateIdentityKeyPair,
  signIdentityFields,
} from "@omni-work/protocol-ts";

const agent = generateIdentityKeyPair("agent");
const app = generateIdentityKeyPair("app");
const handshake = await createInitiatorHandshake({
  deviceId: agent.id,
  agentPublicKey: agent.publicKey,
  appId: app.id,
  appPublicKey: app.publicKey,
  agentConnectionId: "agent-connection",
  appConnectionId: "app-connection",
  signApp: (fields) =>
    signIdentityFields(app.privateKey, SIGNATURE_DOMAINS.e2eInit, fields),
});

// Send handshake.init to the Agent.
const accepted = acceptInitiatorHandshake(
  {
    deviceId: agent.id,
    agentPublicKey: agent.publicKey,
    agentPrivateKey: agent.privateKey,
    appId: app.id,
    appPublicKey: app.publicKey,
    agentConnectionId: "agent-connection",
    appConnectionId: "app-connection",
  },
  handshake.init,
);

// Return accepted.reply to the App.
const appSession = handshake.complete(accepted.reply);
const agentSession = accepted.session;
```

The handshake binds both long-term Ed25519 identities, both Relay connection
IDs, and fresh X25519 ephemeral keys. Session traffic uses
ChaCha20-Poly1305 with replay-protected sequence numbers. This package is
ESM-only and requires Node.js 20.19 or newer.

Source and issue tracking are available in the
[OmniWork repository](https://github.com/zhangbozhb/OmniWork).
