import {
  createMessage,
  type MessageEnvelope,
} from "../../../../packages/protocol-ts/src/index.ts";
import type {
  AgentHelloPayload,
  AuthVerifyPayload,
  CodexSession,
  FilesListRequestPayload,
  FilesReadRequestPayload,
  GitDiffRequestPayload,
  GitStatusRequestPayload,
  SessionCreatePayload,
  SessionListPayload,
  SessionRenamePayload,
  TerminalErrorPayload,
  TerminalFramePayload,
  TerminalInputPayload,
  TerminalResizePayload,
  TunnelUpgradeAnswerPayload,
  TunnelUpgradeCandidatePayload,
  TunnelUpgradeCommittedPayload,
  TunnelUpgradeDowngradePayload,
  TunnelUpgradeOfferPayload,
  TunnelUpgradeProposePayload,
} from "../../../../packages/protocol-ts/src/index.ts";
import { createHash } from "node:crypto";

import type { AgentConfig } from "../config/config.ts";
import {
  createAndPersistSessionKey,
  createAgentInstanceId,
  verifyProof,
} from "../auth-key/authKey.ts";
import type { SessionKeyRecord } from "../auth-key/authKey.ts";
import { AgentRelayClient } from "../relay-client/agentRelayClient.ts";
import { RuntimeRegistry } from "../runtime/runtimeAdapter.ts";
import { SessionManager } from "./sessionManager.ts";
import { JsonSessionStore } from "../session-store/sessionStore.ts";
import { TerminalBridge } from "../pty-bridge/terminalBridge.ts";
import {
  TmuxManager,
  TmuxTargetMissingError,
} from "../tmux-manager/tmuxManager.ts";
import { Logger } from "../telemetry/logger.ts";
import { FileService } from "../files/fileService.ts";
import { GitService } from "../git/gitService.ts";
import { WorkspaceManager } from "../workspace/workspaceManager.ts";
import {
  createPairingQrDetails,
  printPairingDetailsWithoutRelay,
  printPairingQr,
} from "../pairing/pairingQr.ts";
import {
  AgentRelayPath,
  AgentSessionTransport,
} from "../transport/index.ts";
import { UpgradeCoordinator } from "../transport/upgradeCoordinator.ts";
import { createAgentWebRtcPeerAdapter } from "../transport/webRtcPeerAdapter.ts";

export class AgentService {
  private readonly logger = new Logger("omniwork-agent");
  private readonly tmux = new TmuxManager();
  private readonly runtimes: RuntimeRegistry;
  private readonly workspaces: WorkspaceManager;
  private readonly files = new FileService();
  private readonly git = new GitService();
  private readonly sessionManager: SessionManager;
  private readonly terminalBridge: TerminalBridge;
  private readonly config: AgentConfig;
  private keyRecord: SessionKeyRecord | null = null;
  private relay: AgentRelayClient | null = null;
  private transport: AgentSessionTransport | null = null;
  private upgradeCoordinator: UpgradeCoordinator | null = null;
  private readonly logTransport =
    (process.env.OMNIWORK_LOG_TRANSPORT ?? "") === "1";
  /**
   * 每个 session 的终端推流定时器：基于内容哈希去重，仅在变化时推送 terminal.frame，
   * 取代 App 端 3s 全量轮询 + 输入后多次轮询。
   */
  private readonly terminalPushers = new Map<string, NodeJS.Timeout>();
  private readonly terminalLastFrameHash = new Map<string, string>();

  constructor(config: AgentConfig) {
    this.config = config;
    this.runtimes = new RuntimeRegistry({
      providers: config.agentProviders,
    });
    this.workspaces = new WorkspaceManager({
      defaultCwd: config.defaultCwd,
    });
    this.sessionManager = new SessionManager(
      new JsonSessionStore(config.sessionStorePath),
      this.tmux,
      this.runtimes,
      this.workspaces,
      {
        cwd: config.defaultCwd,
        terminalSize: config.terminalSize,
      },
    );
    this.terminalBridge = new TerminalBridge(this.tmux);
  }

  async start(): Promise<void> {
    const agentInstanceId = createAgentInstanceId();
    this.keyRecord = await createAndPersistSessionKey({
      path: this.config.sessionKeyPath,
      agentInstanceId,
      relayUrl: this.config.relayUrl,
    });

    this.logger.info("generated temporary session key", {
      key_id: this.keyRecord.key_id,
      key_path: this.config.sessionKeyPath,
      agent_instance_id: this.keyRecord.agent_instance_id,
    });
    const pairingQr = createPairingQrDetails(this.config, this.keyRecord);
    if (pairingQr) {
      printPairingQr(pairingQr);
    } else {
      printPairingDetailsWithoutRelay(this.config, this.keyRecord);
    }

    const tmuxAvailable = await this.tmux.isAvailable();
    if (!tmuxAvailable) {
      this.logger.warn(
        "tmux is not available; session creation will fail until tmux is installed",
      );
    }

    if (!this.config.relayUrl) {
      this.logger.info(
        "OMNIWORK_RELAY_URL is not set; running without relay connection",
      );
      return;
    }

    await this.connectRelay(this.config.relayUrl);
  }

  private async connectRelay(url: string): Promise<void> {
    const keyRecord = this.requireKeyRecord();
    const relay = new AgentRelayClient(url);
    this.relay = relay;
    const relayPath = new AgentRelayPath(relay);
    const transport = new AgentSessionTransport(relayPath);
    this.transport = transport;

    // Agent 端固定为 answerer（mobile 是 offerer）。
    const coordinator = new UpgradeCoordinator({
      role: "answerer",
      deviceId: this.config.deviceId,
      peerFactory: (opts) =>
        createAgentWebRtcPeerAdapter({
          iceServers: opts.iceServers,
          role: opts.role,
        }),
      sendControl: (envelope) => relay.send(envelope),
      onSwitchPath: (path) => {
        if (path === "p2p") {
          const peer = coordinator.getPeer();
          const upgradeId = coordinator.getUpgradeId();
          if (peer) {
            transport.attachP2pPeer(peer, {
              upgradeId: upgradeId ?? undefined,
              onDowngrade: (reason) => coordinator.downgrade(reason),
            });
          }
        }
        void transport.switchPath(path);
      },
    });
    this.upgradeCoordinator = coordinator;

    // transport 健康事件 → Logger（pong_received 仅在 OMNIWORK_LOG_TRANSPORT=1 时打印）。
    transport.onEvent((event) => {
      switch (event.type) {
        case "path_change":
          this.logger.info("transport path changed", {
            from: event.from,
            to: event.to,
          });
          break;
        case "ping_timeout":
          this.logger.warn("transport ping timeout", {
            seq: event.seq,
            count: event.count,
          });
          break;
        case "pong_received":
          if (this.logTransport) {
            this.logger.debug("transport pong received", {
              seq: event.seq,
              rtt_ms: event.rtt_ms,
            });
          }
          break;
        case "downgrade":
          this.logger.warn("transport downgrade", { reason: event.reason });
          break;
      }
    });

    coordinator.onEvent((event) => {
      switch (event.type) {
        case "propose":
          this.logger.info("upgrade propose", {
            upgrade_id: event.upgrade_id,
            role: event.role,
          });
          break;
        case "upgrade_success":
          this.logger.info("upgrade success", {
            upgrade_id: event.upgrade_id,
          });
          break;
        case "upgrade_failed":
          this.logger.warn("upgrade failed", {
            upgrade_id: event.upgrade_id,
            reason: event.reason,
          });
          break;
      }
    });

    relay.onMessage((message) => {
      this.handleRelayMessage(message).catch((error: unknown) => {
        this.logger.error("failed to handle relay message", {
          message_type: message.type,
          error: String(error),
        });
      });
    });

    try {
      await relay.connect();
    } catch (error) {
      throw new Error(
        [
          `Unable to connect to OMNIWORK_RELAY_URL: ${url}`,
          "Start the relay first with `pnpm dev:relay`, then restart the Mac Agent.",
          `Original error: ${formatRelayConnectionError(error)}`,
        ].join("\n"),
      );
    }

    relay.send(
      createMessage<AgentHelloPayload>(
        "agent.hello",
        {
          device_id: this.config.deviceId,
          agent_instance_id: keyRecord.agent_instance_id,
          key_id: keyRecord.key_id,
          hostname: this.config.hostname,
          platform: "darwin",
          agent_version: this.config.agentVersion,
          providers: this.runtimes.providers(),
          workspaces: await this.workspaces.list(),
          capabilities: [
            "terminal.tui",
            "terminal.snapshot",
            "session.tmux",
            "session.tmux.attach",
            "session.tmux.kill",
            "workspace.list",
            "files.read",
            "git.read",
            ...this.runtimes.capabilities(),
          ],
        },
        { device_id: this.config.deviceId },
      ),
    );

    this.logger.info("connected to relay", {
      relay_url: url,
      key_id: keyRecord.key_id,
    });
  }

  private async handleRelayMessage(message: MessageEnvelope): Promise<void> {
    switch (message.type) {
      case "auth.verify":
        this.handleAuthVerify(message as MessageEnvelope<AuthVerifyPayload>);
        break;
      case "session.list":
        await this.handleSessionList(message);
        break;
      case "session.create":
        await this.handleSessionCreate(
          message as MessageEnvelope<SessionCreatePayload>,
        );
        break;
      case "session.retry":
        await this.handleSessionRecovery(message, "retry");
        break;
      case "session.recover":
        await this.handleSessionRecovery(message, "recover");
        break;
      case "session.restart":
        await this.handleSessionRecovery(message, "restart");
        break;
      case "session.close":
        if (message.session_id) {
          this.stopTerminalPusher(message.session_id);
          await this.sessionManager.close(message.session_id);
          await this.handleSessionList(message);
        }
        break;
      case "session.rename":
        await this.handleSessionRename(
          message as MessageEnvelope<SessionRenamePayload>,
        );
        break;
      case "session.kill_tmux":
        if (message.session_id) {
          this.stopTerminalPusher(message.session_id);
          await this.sessionManager.killTmux(message.session_id);
          await this.handleSessionList(message);
        }
        break;
      case "workspace.list":
        await this.handleWorkspaceList(message);
        break;
      case "files.list":
        await this.handleFilesList(
          message as MessageEnvelope<FilesListRequestPayload>,
        );
        break;
      case "files.read":
        await this.handleFilesRead(
          message as MessageEnvelope<FilesReadRequestPayload>,
        );
        break;
      case "git.status":
        await this.handleGitStatus(
          message as MessageEnvelope<GitStatusRequestPayload>,
        );
        break;
      case "git.diff":
        await this.handleGitDiff(
          message as MessageEnvelope<GitDiffRequestPayload>,
        );
        break;
      case "terminal.input":
        await this.handleTerminalInput(
          message as MessageEnvelope<TerminalInputPayload>,
        );
        break;
      case "terminal.resize":
        await this.handleTerminalResize(
          message as MessageEnvelope<TerminalResizePayload>,
        );
        break;
      case "session.attach":
        await this.handleSessionAttach(message);
        break;
      case "terminal.snapshot":
        await this.handleTerminalSnapshot(message);
        break;
      case "tunnel.upgrade.propose":
        await this.upgradeCoordinator?.propose(
          (message as MessageEnvelope<TunnelUpgradeProposePayload>).payload,
        );
        break;
      case "tunnel.upgrade.offer":
        await this.upgradeCoordinator?.handleOffer(
          (message as MessageEnvelope<TunnelUpgradeOfferPayload>).payload,
        );
        break;
      case "tunnel.upgrade.answer":
        await this.upgradeCoordinator?.handleAnswer(
          (message as MessageEnvelope<TunnelUpgradeAnswerPayload>).payload,
        );
        break;
      case "tunnel.upgrade.candidate":
        await this.upgradeCoordinator?.handleCandidate(
          (message as MessageEnvelope<TunnelUpgradeCandidatePayload>).payload,
        );
        break;
      case "tunnel.upgrade.committed":
        this.upgradeCoordinator?.handleCommitted(
          (message as MessageEnvelope<TunnelUpgradeCommittedPayload>).payload,
        );
        break;
      case "tunnel.upgrade.downgrade":
        this.upgradeCoordinator?.downgrade(
          (message as MessageEnvelope<TunnelUpgradeDowngradePayload>).payload
            .reason,
        );
        break;
      default:
        this.logger.debug("ignored relay message", {
          message_type: message.type,
        });
    }
  }

  private handleAuthVerify(message: MessageEnvelope<AuthVerifyPayload>): void {
    const keyRecord = this.requireKeyRecord();
    const valid =
      message.payload.key_id === keyRecord.key_id &&
      verifyProof(keyRecord.key, message.payload.nonce, message.payload.proof);

    if (valid) {
      this.send(
        createMessage(
          "auth.ok",
          {
            agent_instance_id: keyRecord.agent_instance_id,
            connection_id: message.payload.connection_id,
          },
          { device_id: this.config.deviceId },
        ),
      );
    } else {
      this.send(
        createMessage(
          "auth.failed",
          {
            reason: "key_mismatch",
            connection_id: message.payload.connection_id,
            retry_after_ms: 2000,
          },
          { device_id: this.config.deviceId },
        ),
      );
    }
  }

  private async handleSessionList(message: MessageEnvelope): Promise<void> {
    const sessions = await this.sessionManager.list();
    const payload: SessionListPayload = {
      default_cwd: this.config.defaultCwd,
      providers: this.runtimes.providers(),
      workspaces: await this.workspaces.list(sessions),
      sessions,
    };
    this.send(
      createMessage("session.list", payload, {
        device_id: this.config.deviceId,
        id: message.id,
      }),
    );
  }

  private async handleWorkspaceList(message: MessageEnvelope): Promise<void> {
    this.send(
      createMessage(
        "workspace.list",
        {
          workspaces: await this.workspaces.list(await this.sessionManager.list()),
        },
        {
          device_id: this.config.deviceId,
          id: message.id,
        },
      ),
    );
  }

  private async handleFilesList(
    message: MessageEnvelope<FilesListRequestPayload>,
  ): Promise<void> {
    const workspace = await this.requireWorkspace(message.payload.workspacePath);
    this.send(
      createMessage(
        "files.list",
        await this.files.list(workspace, message.payload.relativePath),
        {
          device_id: this.config.deviceId,
          id: message.id,
        },
      ),
    );
  }

  private async handleFilesRead(
    message: MessageEnvelope<FilesReadRequestPayload>,
  ): Promise<void> {
    const workspace = await this.requireWorkspace(message.payload.workspacePath);
    this.send(
      createMessage(
        "files.read",
        await this.files.read(workspace, message.payload.relativePath),
        {
          device_id: this.config.deviceId,
          id: message.id,
        },
      ),
    );
  }

  private async handleGitStatus(
    message: MessageEnvelope<GitStatusRequestPayload>,
  ): Promise<void> {
    const workspace = await this.requireWorkspace(message.payload.workspacePath);
    this.send(
      createMessage("git.status", await this.git.status(workspace), {
        device_id: this.config.deviceId,
        id: message.id,
      }),
    );
  }

  private async handleGitDiff(
    message: MessageEnvelope<GitDiffRequestPayload>,
  ): Promise<void> {
    const workspace = await this.requireWorkspace(message.payload.workspacePath);
    this.send(
      createMessage(
        "git.diff",
        await this.git.diff(workspace, message.payload.relativePath),
        {
          device_id: this.config.deviceId,
          id: message.id,
        },
      ),
    );
  }

  private async handleSessionCreate(
    message: MessageEnvelope<SessionCreatePayload>,
  ): Promise<void> {
    let session;
    try {
      session = await this.sessionManager.create(
        message.payload ?? {},
        (nextSession) => this.sendSessionStatus(nextSession),
      );
    } catch (error) {
      this.send(
        createMessage<TerminalErrorPayload>(
          "terminal.error",
          {
            code: "SESSION_CREATE_FAILED",
            message: formatRelayConnectionError(error),
          },
          { device_id: this.config.deviceId },
        ),
      );
      return;
    }
    this.sendSessionStatus(session);
    if (session.status !== "running" && session.status !== "detached") {
      return;
    }

    await this.handleTerminalSnapshot({
      ...message,
      session_id: session.session_id,
    });
    this.startTerminalPusher(session.session_id);
  }

  private async handleSessionRename(
    message: MessageEnvelope<SessionRenamePayload>,
  ): Promise<void> {
    const sessionId = message.payload.session_id || message.session_id;
    if (!sessionId) {
      return;
    }

    const session = await this.sessionManager.rename(
      sessionId,
      message.payload.title,
    );
    if (session) {
      this.sendSessionStatus(session);
    }
    await this.handleSessionList(message);
  }

  private async handleSessionAttach(message: MessageEnvelope): Promise<void> {
    if (!message.session_id) {
      return;
    }

    const session = await this.sessionManager.attach(message.session_id);
    if (!session) {
      return;
    }

    this.send(
      createMessage(
        "session.status",
        { session },
        {
          device_id: this.config.deviceId,
          session_id: session.session_id,
        },
      ),
    );
    await this.handleTerminalSnapshot({
      ...message,
      session_id: session.session_id,
    });
    this.startTerminalPusher(session.session_id);
  }

  private async handleSessionRecovery(
    message: MessageEnvelope,
    action: "retry" | "recover" | "restart",
  ): Promise<void> {
    if (!message.session_id) {
      return;
    }

    const session =
      action === "retry"
        ? await this.sessionManager.retry(message.session_id, (nextSession) =>
            this.sendSessionStatus(nextSession),
          )
        : action === "recover"
          ? await this.sessionManager.recover(message.session_id)
          : await this.sessionManager.restart(message.session_id, (nextSession) =>
              this.sendSessionStatus(nextSession),
            );
    if (!session) {
      return;
    }

    this.sendSessionStatus(session);
    await this.handleSessionList(message);
    if (session.status === "running" || session.status === "detached") {
      await this.handleTerminalSnapshot({
        ...message,
        session_id: session.session_id,
      });
      this.startTerminalPusher(session.session_id);
    } else {
      this.stopTerminalPusher(session.session_id);
    }
  }

  private async handleTerminalInput(
    message: MessageEnvelope<TerminalInputPayload>,
  ): Promise<void> {
    const session = message.session_id
      ? await this.sessionManager.get(message.session_id)
      : undefined;
    if (!session) {
      return;
    }

    try {
      await this.terminalBridge.writeInput(session, message.payload);
    } catch (error) {
      if (error instanceof TmuxTargetMissingError) {
        await this.handleMissingTmuxTarget(session.session_id, error);
        return;
      }

      throw error;
    }
  }

  private async handleTerminalResize(
    message: MessageEnvelope<TerminalResizePayload>,
  ): Promise<void> {
    const session = message.session_id
      ? await this.sessionManager.get(message.session_id)
      : undefined;
    if (!session) {
      return;
    }

    try {
      await this.terminalBridge.resize(session, message.payload);
      await this.sessionManager.updateTerminalSize(
        session.session_id,
        message.payload,
      );
    } catch (error) {
      if (error instanceof TmuxTargetMissingError) {
        await this.handleMissingTmuxTarget(session.session_id, error);
        return;
      }

      throw error;
    }
  }

  private async handleTerminalSnapshot(
    message: MessageEnvelope,
  ): Promise<void> {
    const session = message.session_id
      ? await this.sessionManager.get(message.session_id)
      : undefined;
    if (!session) {
      return;
    }

    let snapshot;
    try {
      snapshot = await this.terminalBridge.snapshot(session);
    } catch (error) {
      if (error instanceof TmuxTargetMissingError) {
        await this.handleMissingTmuxTarget(session.session_id, error);
        return;
      }

      throw error;
    }

    this.send(
      createMessage("terminal.snapshot", snapshot, {
        device_id: this.config.deviceId,
        session_id: session.session_id,
      }),
    );
    this.terminalLastFrameHash.set(
      session.session_id,
      createHash("sha1").update(snapshot.data).digest("hex"),
    );
  }

  private async handleMissingTmuxTarget(
    sessionId: string,
    error: TmuxTargetMissingError,
  ): Promise<void> {
    this.stopTerminalPusher(sessionId);
    this.logger.warn("tmux target no longer exists; removing stale session", {
      session_id: sessionId,
      tmux_target: error.tmuxTarget,
    });
    await this.sessionManager.remove(sessionId);
    this.send(
      createMessage<TerminalErrorPayload>(
        "terminal.error",
        {
          code: error.code,
          message:
            "The tmux pane no longer exists. The stale session was removed.",
        },
        {
          device_id: this.config.deviceId,
          session_id: sessionId,
        },
      ),
    );
    await this.handleSessionList(
      createMessage(
        "session.list",
        {},
        {
          device_id: this.config.deviceId,
        },
      ),
    );
  }

  private startTerminalPusher(sessionId: string): void {
    if (this.terminalPushers.has(sessionId)) {
      return;
    }
    const intervalMs = 450;
    const timer = setInterval(() => {
      void this.pushTerminalFrameIfChanged(sessionId);
    }, intervalMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    this.terminalPushers.set(sessionId, timer);
  }

  private stopTerminalPusher(sessionId: string): void {
    const timer = this.terminalPushers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.terminalPushers.delete(sessionId);
    }
    this.terminalLastFrameHash.delete(sessionId);
  }

  private async pushTerminalFrameIfChanged(sessionId: string): Promise<void> {
    const session = await this.sessionManager.get(sessionId);
    if (!session) {
      this.stopTerminalPusher(sessionId);
      return;
    }
    if (session.status !== "running" && session.status !== "detached") {
      return;
    }

    let frame: TerminalFramePayload;
    try {
      frame = await this.terminalBridge.frame(session);
    } catch (error) {
      if (error instanceof TmuxTargetMissingError) {
        await this.handleMissingTmuxTarget(sessionId, error);
        return;
      }
      this.logger.warn("terminal frame capture failed", {
        session_id: sessionId,
        error: String(error),
      });
      return;
    }

    const hash = createHash("sha1").update(frame.data).digest("hex");
    if (this.terminalLastFrameHash.get(sessionId) === hash) {
      return;
    }
    this.terminalLastFrameHash.set(sessionId, hash);

    this.send(
      createMessage<TerminalFramePayload>("terminal.frame", frame, {
        device_id: this.config.deviceId,
        session_id: sessionId,
      }),
    );
  }

  private send(message: MessageEnvelope): void {
    if (!this.transport) {
      this.logger.warn("cannot send without transport", {
        message_type: message.type,
      });
      return;
    }

    this.transport.send(message);
  }

  private sendSessionStatus(session: CodexSession): void {
    this.send(
      createMessage(
        "session.status",
        { session },
        {
          device_id: this.config.deviceId,
          session_id: session.session_id,
        },
      ),
    );
  }

  private async requireWorkspace(workspacePath: string) {
    const workspace = await this.workspaces.get(workspacePath);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspacePath}`);
    }
    return workspace;
  }

  private requireKeyRecord(): SessionKeyRecord {
    if (!this.keyRecord) {
      throw new Error("Session key has not been generated");
    }

    return this.keyRecord;
  }
}

function formatRelayConnectionError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
