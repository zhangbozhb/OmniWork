import { strict as assert } from "node:assert";
import { test } from "node:test";

import { AuthReplayCache } from "../src/core/authReplayCache.ts";

test("AuthReplayCache remembers nonce keys", () => {
  const cache = new AuthReplayCache();

  assert.equal(cache.has("key-1:nonce-1"), false);
  cache.remember("key-1:nonce-1");
  assert.equal(cache.has("key-1:nonce-1"), true);
});

test("AuthReplayCache evicts oldest keys when bounded", () => {
  const cache = new AuthReplayCache(2);

  cache.remember("a");
  cache.remember("b");
  cache.remember("c");

  assert.equal(cache.has("a"), false);
  assert.equal(cache.has("b"), true);
  assert.equal(cache.has("c"), true);
});
