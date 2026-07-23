#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((file) => /\.(?:ts|tsx|js|mjs)$/.test(file));

const forbidden = /(?:\.\.\/)+(?:packages\/)?(?:protocol-ts|relay-client|terminal-core|e2e-noise)\/src\/index(?:\.ts)?/;
const violations = [];

for (const file of files) {
  if (!existsSync(file)) {
    continue;
  }
  const content = readFileSync(file, "utf8");
  if (forbidden.test(content)) {
    violations.push(file);
  }
}

if (violations.length > 0) {
  console.error(
    [
      "Forbidden cross-package source imports found.",
      "Use @omni-work/* package imports instead:",
      ...violations.map((file) => `- ${file}`),
    ].join("\n"),
  );
  process.exit(1);
}

console.log("Package boundary check passed.");
