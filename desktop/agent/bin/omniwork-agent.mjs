#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];
const entry =
  command === "enroll"
    ? join(root, "src", "agentd", "enrollRelayDevice.ts")
    : join(root, "src", "main.ts");
const args = command === "enroll" ? process.argv.slice(3) : process.argv.slice(2);
const child = spawn(process.execPath, ["--experimental-strip-types", entry, ...args], {
  env: process.env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
