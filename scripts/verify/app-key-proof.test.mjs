import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  createAuthProofInput,
  createKeyProof,
  isValidSessionKey,
} from "../../app/src/features/auth/keyProof.ts";

const key = "0123456789abcdef0123456789abcdef";
const nonce = "nonce_for_mobile_native_app";
const appInfo = {
  instance_id: "app_test_1",
  runtime_id: "runtime_test_1",
};
const expectedProof = createHmac("sha256", key)
  .update(createAuthProofInput(nonce, appInfo))
  .digest("base64url");

assert.equal(isValidSessionKey(key), true);
assert.equal(
  await createKeyProof(key, nonce, appInfo),
  expectedProof,
);

console.log("app auth proof ok");
