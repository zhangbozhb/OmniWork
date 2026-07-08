export function parseAgentConfigPathArgv(
  argv: readonly string[],
): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config" || arg === "-c") {
      const value = argv[index + 1]?.trim();
      if (!value) {
        throw new Error(`${arg} requires a config file path.`);
      }
      return value;
    }
    if (arg?.startsWith("--config=")) {
      const value = arg.slice("--config=".length).trim();
      if (!value) {
        throw new Error("--config requires a config file path.");
      }
      return value;
    }
  }
  return undefined;
}
