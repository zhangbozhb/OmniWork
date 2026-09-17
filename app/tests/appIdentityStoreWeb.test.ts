import assert from "node:assert/strict";
import test from "node:test";

import { requireWebIdentityCrypto } from "../src/platform/identity/appIdentityStore.web.ts";

test("Web identity requires SubtleCrypto", () => {
  assert.throws(
    () => requireWebIdentityCrypto({ subtle: undefined } as never),
    /secure browser context/u,
  );
});

test("Web identity uses the available SubtleCrypto implementation", () => {
  const subtle = {} as SubtleCrypto;
  assert.equal(requireWebIdentityCrypto({ subtle }), subtle);
});
