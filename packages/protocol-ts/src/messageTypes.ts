export const CONNECTION_MESSAGE_TYPES = [
  "agent.auth.init",
  "agent.auth.challenge",
  "agent.hello",
  "agent.heartbeat",
  "mobile.connect",
  "auth.challenge",
  "auth.proof",
  "auth.verify",
  "auth.ok",
  "auth.failed",
  "app.network.changed",
  "app.connection.heartbeat",
  "app.connection.goodbye",
] as const;

export const E2E_MESSAGE_TYPES = [
  "e2e.handshake.init",
  "e2e.handshake.reply",
  "e2e.ready",
  "e2e.message",
  "e2e.failed",
  "e2e.rekey.init",
  "e2e.rekey.reply",
  "e2e.rekey.ready",
  "e2e.close",
  "protocol.error",
  "relay.app.deliver",
] as const;

export const SESSION_MESSAGE_TYPES = [
  "device.list",
  "session.list",
  "session.create",
  "session.rename",
  "session.close",
  "session.kill_terminal",
  "session.attach",
  "session.detach",
  "session.status",
] as const;

export const WORKSPACE_MESSAGE_TYPES = [
  "workspace.list",
  "workspace.status",
  "files.list",
  "files.read",
  "files.write",
  "git.status",
  "git.diff",
  "git.action",
  "git.worktree",
] as const;

export const TERMINAL_MESSAGE_TYPES = [
  "terminal.frame",
  "terminal.input",
  "terminal.resize",
  "terminal.snapshot",
  "terminal.stream.start",
  "terminal.stream.ready",
  "terminal.stream.data",
  "terminal.stream.stop",
  "terminal.stream.error",
  "terminal.ack",
  "terminal.error",
] as const;

export const AGENT_MESSAGE_TYPES = [
  "codex.thread.list",
  "codex.thread.start",
  "codex.thread.resume",
  "codex.turn.event",
  "codex.approval.request",
  "codex.approval.answer",
  "codex.diff.event",
  "codex.error",
  "agent.message",
  "agent.message.list",
  "agent.message.read",
  "agent.message.ack",
  "agent.message.delivered",
  "agent.surface.event",
  "agent.surface.sync",
  "agent.interaction",
  "agent.prompt.submit",
  "agent.notification.settings.get",
  "agent.notification.settings.set",
] as const;

export const TRANSPORT_MESSAGE_TYPES = [
  "tunnel.upgrade.propose",
  "tunnel.upgrade.offer",
  "tunnel.upgrade.answer",
  "tunnel.upgrade.candidate",
  "tunnel.upgrade.committed",
  "tunnel.upgrade.downgrade",
  "transport.ping",
  "transport.pong",
] as const;

export const MESSAGE_TYPES = [
  ...CONNECTION_MESSAGE_TYPES,
  ...E2E_MESSAGE_TYPES,
  ...SESSION_MESSAGE_TYPES,
  ...WORKSPACE_MESSAGE_TYPES,
  ...TERMINAL_MESSAGE_TYPES,
  ...AGENT_MESSAGE_TYPES,
  ...TRANSPORT_MESSAGE_TYPES,
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];
