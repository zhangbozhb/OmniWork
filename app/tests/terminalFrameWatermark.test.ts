import assert from "node:assert/strict";
import test from "node:test";

import { terminalFrameWatermarkAfterSnapshot } from "../src/app/terminalFrameWatermark.ts";

test("snapshot seq advances terminal frame watermark", () => {
  assert.equal(terminalFrameWatermarkAfterSnapshot(undefined, 10), 10);
  assert.equal(terminalFrameWatermarkAfterSnapshot(8, 10), 10);
});

test("snapshot seq never moves terminal frame watermark backwards", () => {
  assert.equal(terminalFrameWatermarkAfterSnapshot(12, 10), 12);
});

test("legacy snapshot without seq clears the watermark", () => {
  assert.equal(terminalFrameWatermarkAfterSnapshot(12, undefined), undefined);
});
