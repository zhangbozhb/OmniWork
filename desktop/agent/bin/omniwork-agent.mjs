#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];
const entry =
  command === "enroll"
    ? join(root, "dist", "agentd", "enrollRelayDevice.js")
    : join(root, "dist", "main.js");
const args = command === "enroll" ? process.argv.slice(3) : process.argv.slice(2);
const child = spawn(process.execPath, [entry, ...args], {
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
