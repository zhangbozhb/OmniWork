import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const workflow = readFileSync(
  new URL(".github/workflows/release.yml", repoRoot),
  "utf8",
);
const androidBuild = readFileSync(
  new URL("app/android/app/build.gradle", repoRoot),
  "utf8",
);

test("release workflow fails closed on Android signing", () => {
  for (const secret of [
    "OMNIWORK_RELEASE_KEYSTORE_BASE64",
    "OMNIWORK_RELEASE_KEYSTORE_PASSWORD",
    "OMNIWORK_RELEASE_KEY_ALIAS",
    "OMNIWORK_RELEASE_KEY_PASSWORD",
    "OMNIWORK_RELEASE_CERT_SHA256",
  ]) {
    assert.match(workflow, new RegExp(`secrets\\.${secret}`));
  }
  assert.match(workflow, /missing\+=\("\$name"\)/);
  assert.match(workflow, /OMNIWORK_REQUIRE_RELEASE_SIGNING: "true"/);
  assert.match(workflow, /apksigner.*verify --verbose --print-certs/s);
  assert.match(workflow, /Android release certificate SHA-256 mismatch/);
  assert.doesNotMatch(workflow, /debug signing fallback/);
});

test("Gradle strict release mode rejects incomplete signing inputs", () => {
  assert.match(
    androidBuild,
    /def requireReleaseSigning = .*OMNIWORK_REQUIRE_RELEASE_SIGNING/,
  );
  assert.match(
    androidBuild,
    /if \(requireReleaseSigning && !hasReleaseSigning\)/,
  );
  assert.match(
    androidBuild,
    /Complete Android release signing configuration is required/,
  );
});
