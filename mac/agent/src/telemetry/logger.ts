export type LogLevel = "debug" | "info" | "warn" | "error";

export class Logger {
  private readonly namespace: string;

  constructor(namespace: string) {
    this.namespace = namespace;
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write("error", message, fields);
  }

  child(namespace: string): Logger {
    return new Logger(`${this.namespace}:${namespace}`);
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    const entry = {
      ts: formatLocalTimestamp(),
      level,
      namespace: this.namespace,
      message,
      ...redact(fields),
    };
    const output = JSON.stringify(entry);
    if (level === "error") {
      console.error(output);
    } else {
      console.log(output);
    }
  }
}

export function formatLocalTimestamp(date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffsetMinutes / 60);
  const offsetRemainderMinutes = absoluteOffsetMinutes % 60;

  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    "T",
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(
      date.getSeconds(),
    )}.${pad3(date.getMilliseconds())}`,
    `${sign}${pad2(offsetHours)}:${pad2(offsetRemainderMinutes)}`,
  ].join("");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function pad3(value: number): string {
  return String(value).padStart(3, "0");
}

function redact(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) {
    return {};
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (isSensitiveField(key)) {
      redacted[key] = "[redacted]";
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

function isSensitiveField(key: string): boolean {
  const normalized = key.toLowerCase();
  return ["key", "session_key", "proof", "secret", "token"].includes(normalized);
}
