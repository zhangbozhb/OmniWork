# @omni-work/relay-client

WebSocket relay client shared by OmniWork applications and agents.

## Install

```sh
npm install @omni-work/relay-client
```

## Usage

```ts
import { RelayClient } from "@omni-work/relay-client";

const relay = new RelayClient({
  url: "wss://relay.example.com/relay/ws/mobile",
});

relay.onMessage((message) => {
  console.log(message);
});

await relay.connect();
```

The runtime must provide a global `WebSocket`, or callers can pass a
`webSocketFactory`. This package is ESM-only and requires Node.js 20.19 or
newer when used in Node.

Source and issue tracking are available in the
[OmniWork repository](https://github.com/zhangbozhb/OmniWork).
