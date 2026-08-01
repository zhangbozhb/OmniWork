import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isPcWebDevice } from "../src/platform/webDeviceDetection.ts";

test("isPcWebDevice detects desktop pointer capabilities", () => {
  assert.equal(
    isPcWebDevice({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      maxTouchPoints: 0,
      finePointer: true,
      hover: true,
      coarsePointer: false,
    }),
    true,
  );
});

test("isPcWebDevice keeps mobile and iPad web controls", () => {
  assert.equal(
    isPcWebDevice({
      userAgent: "Mozilla/5.0 (Linux; Android 15; Mobile)",
      maxTouchPoints: 5,
      finePointer: false,
      hover: false,
      coarsePointer: true,
    }),
    false,
  );
  assert.equal(
    isPcWebDevice({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
      maxTouchPoints: 5,
      finePointer: false,
      hover: false,
      coarsePointer: true,
    }),
    false,
  );
});
