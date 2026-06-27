import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { connect as netConnect, type Socket } from "node:net";

import type { RelayServerConfig } from "./config.ts";
import { logRelayEvent } from "./relayLog.ts";

const SMTP_TIMEOUT_MS = 15_000;

export interface MailSender {
  sendMagicLink(input: {
    to: string;
    loginUrl: string;
    expiresMinutes: number;
  }): Promise<void>;
}

export function createMailSender(config: RelayServerConfig): MailSender {
  if (config.auth.mail.provider === "smtp") {
    const smtp = config.auth.mail.smtp;
    if (!smtp || !config.auth.mail.from) {
      throw new Error("SMTP mail sender is not configured");
    }
    return new SmtpMailSender({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      user: smtp.user,
      pass: smtp.pass,
      from: config.auth.mail.from,
    });
  }
  return new ConsoleMailSender(
    config.auth.mail.from ?? "OmniWork <no-reply@localhost>",
  );
}

class ConsoleMailSender implements MailSender {
  private readonly from: string;

  constructor(from: string) {
    this.from = from;
  }

  async sendMagicLink(input: {
    to: string;
    loginUrl: string;
    expiresMinutes: number;
  }): Promise<void> {
    logRelayEvent({
      event: "auth.email_link.console",
      from: this.from,
      to: input.to,
      expires_minutes: input.expiresMinutes,
      login_url: input.loginUrl,
    });
  }
}

class SmtpMailSender implements MailSender {
  private readonly options: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
  };

  constructor(options: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
  }) {
    this.options = options;
  }

  async sendMagicLink(input: {
    to: string;
    loginUrl: string;
    expiresMinutes: number;
  }): Promise<void> {
    const message = [
      `From: ${this.options.from}`,
      `To: ${input.to}`,
      "Subject: OmniWork sign-in link",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Use this link to sign in to OmniWork Relay:",
      "",
      input.loginUrl,
      "",
      `This link expires in ${input.expiresMinutes} minutes.`,
    ].join("\r\n");

    const client = await SmtpClient.connect({
      host: this.options.host,
      port: this.options.port,
      secure: this.options.secure,
    });
    try {
      await client.expect(220);
      await client.command(`EHLO ${clientHostname()}`, 250);
      if (!this.options.secure) {
        await client.command("STARTTLS", 220);
        await client.upgradeTls(this.options.host);
        await client.command(`EHLO ${clientHostname()}`, 250);
      }
      await client.command("AUTH LOGIN", 334);
      await client.command(Buffer.from(this.options.user).toString("base64"), 334);
      await client.command(Buffer.from(this.options.pass).toString("base64"), 235);
      await client.command(`MAIL FROM:<${extractEmail(this.options.from)}>`, 250);
      await client.command(`RCPT TO:<${input.to}>`, 250);
      await client.command("DATA", 354);
      await client.command(`${message}\r\n.`, 250);
      await client.command("QUIT", 221);
    } finally {
      client.close();
    }
  }
}

class SmtpClient {
  private socket: Socket | TLSSocket;
  private buffer = "";
  private pending:
    | {
        resolve: (line: string) => void;
        reject: (error: Error) => void;
      }
    | null = null;

  private constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    socket.on("data", (chunk) => this.handleData(chunk.toString("utf8")));
    socket.on("error", (error) => this.pending?.reject(error));
  }

  static connect(options: {
    host: string;
    port: number;
    secure: boolean;
  }): Promise<SmtpClient> {
    return withTimeout(
      new Promise((resolve, reject) => {
        const socket = options.secure
          ? tlsConnect(
              {
                port: options.port,
                host: options.host,
                servername: options.host,
              },
              () => resolve(new SmtpClient(socket)),
            )
          : netConnect(options.port, options.host, () =>
              resolve(new SmtpClient(socket)),
            );
        socket.once("error", reject);
      }),
      "SMTP connection timed out",
    );
  }

  async upgradeTls(host: string): Promise<void> {
    this.socket.removeAllListeners("data");
    this.socket.removeAllListeners("error");
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const tlsSocket = tlsConnect(
          { socket: this.socket, servername: host },
          () => resolve(),
        );
        tlsSocket.once("error", reject);
        this.socket = tlsSocket;
      }),
      "SMTP STARTTLS timed out",
    );
    this.socket.on("data", (chunk) => this.handleData(chunk.toString("utf8")));
    this.socket.on("error", (error) => this.pending?.reject(error));
  }

  async command(command: string, expectedCode: number): Promise<string> {
    this.socket.write(`${command}\r\n`);
    return this.expect(expectedCode);
  }

  expect(expectedCode: number): Promise<string> {
    return withTimeout(
      new Promise<string>((resolve, reject) => {
        this.pending = {
          resolve: (line) => {
            const code = Number(line.slice(0, 3));
            if (code !== expectedCode) {
              reject(new Error(`SMTP expected ${expectedCode}, got ${line}`));
              return;
            }
            resolve(line);
          },
          reject,
        };
        this.drainLines();
      }),
      `SMTP response timed out waiting for ${expectedCode}`,
    ).finally(() => {
      this.pending = null;
    });
  }

  close(): void {
    this.socket.end();
  }

  private handleData(data: string): void {
    this.buffer += data;
    this.drainLines();
  }

  private drainLines(): void {
    if (!this.pending) {
      return;
    }
    const lines = this.buffer.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) {
      return;
    }
    const last = lines[lines.length - 1];
    if (!last || /^\d{3}-/.test(last)) {
      return;
    }
    this.buffer = "";
    const pending = this.pending;
    this.pending = null;
    pending.resolve(last);
  }
}

function extractEmail(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return match?.[1] ?? value;
}

function clientHostname(): string {
  return "omniwork-relay.local";
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), SMTP_TIMEOUT_MS);
  });
  return Promise.race([promise, timer]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}
