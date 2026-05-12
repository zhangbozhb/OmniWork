import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { createKeyProof, isValidSessionKey } from "../../app/src/features/auth/keyProof.ts";

const key = "0123456789abcdef0123456789abcdef";
const nonce = "nonce_for_mobile_native_app";
const expectedProof = createHmac("sha256", key).update(nonce).digest("base64url");

assert.equal(isValidSessionKey(key), true);
assert.equal(await createKeyProof(key, nonce), expectedProof);

console.log("app auth proof ok");
