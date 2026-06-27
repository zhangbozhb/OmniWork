import { strict as assert } from "node:assert";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";

import { readJsonBody } from "../src/relayUserAuthController.ts";

const parsed = await readJsonBody(
  Readable.from(['{"email":"user@example.com"}']) as IncomingMessage,
);
assert.equal(parsed.email, "user@example.com");

await assert.rejects(
  () => readJsonBody(Readable.from(["{"]) as IncomingMessage),
  /invalid_json/,
);

await assert.rejects(
  () => readJsonBody(Readable.from(["x".repeat(16)]) as IncomingMessage, 8),
  /payload_too_large/,
);

console.log("relay user auth controller tests passed");
