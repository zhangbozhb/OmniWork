import {
  E2E_NOISE_NNPSK0_CAPABILITY_V1,
  E2E_SUPPORT_V1,
  ENCRYPTED_ONLY_BUSINESS_CAPABILITY_V1,
  INNER_PROTOCOL_VERSION,
  PLAINTEXT_BUSINESS_CAPABILITY_V1,
  PROTOCOL_SUPPORT_V1,
  createMessage,
  type MessageEnvelope,
} from "../../../../packages/protocol-ts/src/index.ts";
import type {
  AgentHelloPayload,
  E2EHandshakeInitPayload,
  E2EMessagePayload,
  E2EReadyPayload,
  AuthVerifyPayload,
  CodexSession,
  FilesListRequestPayload,
  FilesReadRequestPayload,
  GitDiffRequestPayload,
  GitStatusRequestPayload,
  InnerEnvelope,
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
import {
  E2ENoiseError,
  acceptInitiatorHandshake,
  type E2ENoiseSession,
} from "@omniwork/e2e-noise";
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
import { SQLiteSessionStore } from "../session-store/sessionStore.ts";
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
import { AgentRelayPath, AgentSessionTransport } from "../transport/index.ts";
import { UpgradeCoordinator } from "../transport/upgradeCoordinator.ts";
import { createAgentWebRtcPeerAdapter } from "../transport/webRtcPeerAdapter.ts";

interface AppE2EPeer {
  appConnectionId: string;
  session: E2ENoiseSession;
  ready: boolean;
}

interface AgentDispatchContext {
  appConnectionId: string;
  trustedE2E: boolean;
}

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
  private readonly upgradeCoordinators = new Map<string, UpgradeCoordinator>();
  private readonly e2ePeers = new Map<string, AppE2EPeer>();
  private readonly authenticatedAppConnectionIds = new Set<string>();
  private readonly seenAuthNonces: string[] = [];
  private readonly seenAuthNonceSet = new Set<string>();
  private readonly logTransport =
    (process.env.OMNIWORK_LOG_TRANSPORT ?? "") === "1";
  /**
   * 每个 session 的终端推流定时器：基于内容哈希去重，仅在变化时推送 terminal.frame，
   * 取代 App 端 3s 全量轮询 + 输入后多次轮询。
   */
  private readonly terminalPushers = new Map<string, NodeJS.Timeout>();
  private readonly terminalLastFrameHash = new Map<string, string>();
  private readonly terminalSubscribers = new Map<string, Set<string>>();

  constructor(config: AgentConfig) {
    this.config = config;
    this.runtimes = new RuntimeRegistry({
      providers: config.agentProviders,
    });
    this.workspaces = new WorkspaceManager({
      defaultCwd: config.defaultCwd,
    });
    this.sessionManager = new SessionManager(
      new SQLiteSessionStore(config.sessionStorePath),
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

    // 对持久化 session store 做一次性补丁（清理已废弃的 status 等），与运行期
    // reconcile 的职责分离；具体规则集中在 SessionManager.applyStartupPatches。
    await this.sessionManager.applyStartupPatches();

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

    // 通过 transport 订阅业务消息，覆盖 relay path + P2P path 两条通道；
    // P2P 升级成功后 mobile 端的业务消息只会出现在 DataChannel 上，
    // 直接订阅 relay.onMessage 会漏掉这部分流量（终端永远拿不到 snapshot）。
    transport.onMessage((message) => {
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
          v: PROTOCOL_SUPPORT_V1.current,
          device_id: this.config.deviceId,
          agent_instance_id: keyRecord.agent_instance_id,
          key_id: keyRecord.key_id,
          protocol: PROTOCOL_SUPPORT_V1,
          e2e: this.e2eSupport(),
          business_security_mode: this.config.businessSecurityMode,
          hostname: this.config.hostname,
          platform: "darwin",
          agent_version: this.config.agentVersion,
          providers: this.runtimes.providers(),
          workspaces: await this.workspaces.list(),
          capabilities: [
            E2E_NOISE_NNPSK0_CAPABILITY_V1,
            this.config.businessSecurityMode === "e2e_required"
              ? ENCRYPTED_ONLY_BUSINESS_CAPABILITY_V1
              : PLAINTEXT_BUSINESS_CAPABILITY_V1,
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

  private async handleRelayMessage(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void> {
    const trustedE2E = context?.trustedE2E === true;
    const dispatchContext =
      context ??
      (message.app_connection_id
        ? {
            appConnectionId: message.app_connection_id,
            trustedE2E: false,
          }
        : undefined);
    switch (message.type) {
      case "auth.verify":
        this.handleAuthVerify(message as MessageEnvelope<AuthVerifyPayload>);
        break;
      case "e2e.handshake.init":
        this.handleE2EHandshakeInit(
          message as MessageEnvelope<E2EHandshakeInitPayload>,
        );
        break;
      case "e2e.ready":
        this.handleE2EReady(message as MessageEnvelope<E2EReadyPayload>);
        break;
      case "e2e.message":
        await this.handleE2EMessage(
          message as MessageEnvelope<E2EMessagePayload>,
        );
        break;
      case "session.list":
        if (this.rejectPlaintextBusiness(message, trustedE2E)) return;
        await this.handleSessionList(message, dispatchContext);
        break;
      case "session.create":
        if (this.rejectPlaintextBusiness(message, trustedE2E)) return;
        await this.handleSessionCreate(
          message as MessageEnvelope<SessionCreatePayload>,
          dispatchContext,
        );
        break;
      case "session.close":
        if (this.rejectPlaintextBusiness(message, trustedE2E)) return;
        if (message.session_id) {
          this.stopTerminalPusher(message.session_id);
          await this.sessionManager.close(message.session_id);
          await this.handleSessionList(message, dispatchContext);
        }
        break;
      case "session.rename":
        if (this.rejectPlaintextBusiness(message, trustedE2E)) return;
        await this.handleSessionRename(
          message as MessageEnvelope<SessionRenamePayload>,
          dispatchContext,
        );
        break;
      case "session.kill_tmux":
        if (this.rejectPlaintextBusiness(message, trustedE2E)) return;
        if (message.session_id) {
          this.stopTerminalPusher(message.session_id);
          await this.sessionManager.killTmux(message.session_id);
          await this.handleSessionList(message, dispatchContext);
        }
        break;
      case "workspace.list":
        if (this.rejectPlaintextBusiness(message, trustedE2E)) return;
        await this.handleWorkspaceList(message, dispatchContext);
        break;
      case "files.list":
        if (this.rejectPlaintextBusiness(message, trustedE2E)) return;
        await this.handleFilesList(
          message as MessageEnvelope<FilesListRequestPayload>,
          dispatchContext,
        );
        break;
      case "files.read":
        if (this.rejectPlaintextBusiness(message, trustedE2E)) return;
        await this.handleFilesRead(
          message as MessageEnvelope<FilesReadRequestPayload>,
          dispatchContext,
        );
        break;
      case "git.status":
        if (this.rejectPlaintextBusiness(message, trustedE2E)) return;
        await this.handleGitStatus(
          message as MessageEnvelope<GitStatusRequestPayload>,
          dispatchContext,
        );
        break;
      case "git.diff":
        if (this.rejectPlaintextBusiness(message, trustedE2E)) return;
        await this.handleGitDiff(
          message as MessageEnvelope<GitDiffRequestPayload>,
          dispatchContext,
        );
        break;
      case "terminal.input":
        if (this.rejectPlaintextBusiness(message, trustedE2E)) return;
        await this.handleTerminalInput(
          message as MessageEnvelope<TerminalInputPayload>,
        );
        break;
      case "terminal.resize":
        if (this.rejectPlaintextBusiness(message, trustedE2E)) return;
        await this.handleTerminalResize(
          message as MessageEnvelope<TerminalResizePayload>,
        );
        break;
      case "session.attach":
        if (this.rejectPlaintextBusiness(message, trustedE2E)) return;
        await this.handleSessionAttach(message, dispatchContext);
        break;
      case "terminal.snapshot":
        if (this.rejectPlaintextBusiness(message, trustedE2E)) return;
        await this.handleTerminalSnapshot(message, dispatchContext);
        break;
      case "tunnel.upgrade.propose": {
        const payload = (
          message as MessageEnvelope<TunnelUpgradeProposePayload>
        ).payload;
        if (
          this.config.businessSecurityMode === "e2e_required" &&
          !trustedE2E &&
          !this.e2ePeers.get(payload.app_connection_id)?.ready
        ) {
          this.rejectPlaintextBusiness(message, trustedE2E);
          return;
        }
        await this.getUpgradeCoordinator(payload.app_connection_id).propose(
          payload,
        );
        break;
      }
      case "tunnel.upgrade.offer":
        if (this.rejectPlaintextBusiness(message, trustedE2E)) return;
        {
          const payload = (
            message as MessageEnvelope<TunnelUpgradeOfferPayload>
          ).payload;
          await this.getUpgradeCoordinator(
            payload.app_connection_id,
          ).handleOffer(payload);
        }
        break;
      case "tunnel.upgrade.answer":
        if (this.rejectPlaintextBusiness(message, trustedE2E)) return;
        {
          const payload = (
            message as MessageEnvelope<TunnelUpgradeAnswerPayload>
          ).payload;
          await this.getUpgradeCoordinator(
            payload.app_connection_id,
          ).handleAnswer(payload);
        }
        break;
      case "tunnel.upgrade.candidate":
        if (this.rejectPlaintextBusiness(message, trustedE2E)) return;
        {
          const payload = (
            message as MessageEnvelope<TunnelUpgradeCandidatePayload>
          ).payload;
          await this.getUpgradeCoordinator(
            payload.app_connection_id,
          ).handleCandidate(payload);
        }
        break;
      case "tunnel.upgrade.committed":
        if (this.rejectPlaintextBusiness(message, trustedE2E)) return;
        {
          const payload = (
            message as MessageEnvelope<TunnelUpgradeCommittedPayload>
          ).payload;
          this.getUpgradeCoordinator(payload.app_connection_id).handleCommitted(
            payload,
          );
        }
        break;
      case "tunnel.upgrade.downgrade":
        if (this.rejectPlaintextBusiness(message, trustedE2E)) return;
        {
          const payload = (
            message as MessageEnvelope<TunnelUpgradeDowngradePayload>
          ).payload;
          this.getUpgradeCoordinator(payload.app_connection_id).downgrade(
            payload.reason,
          );
        }
        break;
      default:
        this.logger.debug("ignored relay message", {
          message_type: message.type,
        });
    }
  }

  private getUpgradeCoordinator(appConnectionId: string): UpgradeCoordinator {
    const existing = this.upgradeCoordinators.get(appConnectionId);
    if (existing) {
      return existing;
    }
    if (!this.transport) {
      throw new Error("Cannot create upgrade coordinator without transport.");
    }
    const coordinator = new UpgradeCoordinator({
      role: "answerer",
      deviceId: this.config.deviceId,
      peerFactory: (opts) =>
        createAgentWebRtcPeerAdapter({
          iceServers: opts.iceServers,
          role: opts.role,
        }),
      sendControl: (envelope) =>
        this.sendToAppByConnectionId(appConnectionId, envelope),
      onSwitchPath: (path) => {
        if (path === "p2p") {
          const peer = coordinator.getPeer();
          const upgradeId = coordinator.getUpgradeId();
          if (peer) {
            this.transport?.attachP2pPeer(peer, {
              appConnectionId,
              upgradeId: upgradeId ?? undefined,
              onDowngrade: (reason) => coordinator.downgrade(reason),
            });
          }
        } else {
          this.transport?.detachP2pPeer(appConnectionId);
        }
        void this.transport?.switchPath(path);
      },
      onForceClose: (reason) => {
        this.logger.warn("strict_p2p_disconnect", {
          app_connection_id: appConnectionId,
          reason,
        });
        this.transport?.detachP2pPeer(appConnectionId);
      },
    });
    coordinator.onEvent((event) => {
      if (event.type === "propose") {
        this.logger.info("upgrade propose", {
          app_connection_id: appConnectionId,
          upgrade_id: event.upgrade_id,
          role: event.role,
        });
      } else if (event.type === "upgrade_success") {
        this.logger.info("upgrade success", {
          app_connection_id: appConnectionId,
          upgrade_id: event.upgrade_id,
        });
      } else {
        this.logger.warn("upgrade failed", {
          app_connection_id: appConnectionId,
          upgrade_id: event.upgrade_id,
          reason: event.reason,
        });
      }
    });
    this.upgradeCoordinators.set(appConnectionId, coordinator);
    return coordinator;
  }

  private handleE2EHandshakeInit(
    message: MessageEnvelope<E2EHandshakeInitPayload>,
  ): void {
    const keyRecord = this.requireKeyRecord();
    try {
      const result = acceptInitiatorHandshake(
        {
          pairingKey: keyRecord.key,
          deviceId: this.config.deviceId,
          keyId: keyRecord.key_id,
          agentInstanceId: keyRecord.agent_instance_id,
          appConnectionId: message.payload.app_connection_id,
          handshakeId: message.payload.handshake_id,
        },
        message.payload,
      );
      const peer: AppE2EPeer = {
        appConnectionId: message.payload.app_connection_id,
        session: result.session,
        ready: false,
      };
      this.e2ePeers.set(peer.appConnectionId, peer);
      this.send(
        createMessage("e2e.handshake.reply", result.reply, {
          device_id: this.config.deviceId,
        }),
      );
      this.send(
        createMessage("e2e.ready", result.session.readyPayload(), {
          device_id: this.config.deviceId,
        }),
      );
      this.logger.info("e2e handshake accepted", {
        handshake_id: result.reply.handshake_id,
        e2e_session_id: result.session.sessionId,
      });
    } catch (error) {
      this.e2ePeers.delete(message.payload.app_connection_id);
      this.logger.warn("e2e handshake failed", { error: String(error) });
      this.send(
        createMessage(
          "e2e.failed",
          {
            v: PROTOCOL_SUPPORT_V1.current,
            e2e_version: E2E_SUPPORT_V1.versions[0],
            app_connection_id: message.payload.app_connection_id,
            handshake_id: message.payload.handshake_id,
            reason:
              error instanceof E2ENoiseError &&
              error.code === "unsupported_suite"
                ? "unsupported_suite"
                : "handshake_failed",
          },
          { device_id: this.config.deviceId },
        ),
      );
    }
  }

  private handleE2EReady(message: MessageEnvelope<E2EReadyPayload>): void {
    const peer = this.e2ePeers.get(message.payload.app_connection_id);
    if (!peer) {
      this.logger.warn("e2e ready without active session", {
        app_connection_id: message.payload.app_connection_id,
        handshake_id: message.payload.handshake_id,
      });
      return;
    }
    if (
      message.payload.handshake_id !== peer.session.handshakeId ||
      message.payload.transcript_hash !== peer.session.transcriptHash
    ) {
      this.logger.warn("e2e ready transcript mismatch", {
        app_connection_id: message.payload.app_connection_id,
        handshake_id: message.payload.handshake_id,
      });
      this.e2ePeers.delete(message.payload.app_connection_id);
      return;
    }
    peer.ready = true;
    this.logger.info("e2e ready confirmed", {
      app_connection_id: message.payload.app_connection_id,
      handshake_id: message.payload.handshake_id,
      e2e_session_id: peer.session.sessionId,
    });
  }

  private async handleE2EMessage(
    message: MessageEnvelope<E2EMessagePayload>,
  ): Promise<void> {
    const peer = this.e2ePeers.get(message.payload.app_connection_id);
    if (!peer?.ready) {
      this.logger.warn("e2e message without active session", {
        app_connection_id: message.payload.app_connection_id,
        e2e_session_id: message.payload.e2e_session_id,
      });
      return;
    }
    try {
      const inner = peer.session.decrypt(message.payload);
      await this.handleRelayMessage(
        innerToMessage(inner, this.config.deviceId),
        {
          appConnectionId: message.payload.app_connection_id,
          trustedE2E: true,
        },
      );
    } catch (error) {
      this.logger.warn("failed to decrypt e2e message", {
        error: String(error),
      });
      if (
        error instanceof E2ENoiseError &&
        (error.code === "decrypt_failed" || error.code === "replay_detected")
      ) {
        this.e2ePeers.delete(message.payload.app_connection_id);
      }
    }
  }

  private rejectPlaintextBusiness(
    message: MessageEnvelope,
    trustedE2E: boolean,
  ): boolean {
    if (trustedE2E || this.config.businessSecurityMode === "plaintext_allowed") {
      return false;
    }
    this.logger.warn("rejected plaintext business message", {
      message_type: message.type,
    });
    return true;
  }

  private handleAuthVerify(message: MessageEnvelope<AuthVerifyPayload>): void {
    const keyRecord = this.requireKeyRecord();
    const authNonceKey = `${message.payload.key_id}:${message.payload.nonce}`;
    if (this.seenAuthNonceSet.has(authNonceKey)) {
      this.logger.warn("rejected replayed auth nonce", {
        key_id: message.payload.key_id,
      });
      this.send(
        createMessage(
          "auth.failed",
          {
            reason: "malformed_proof",
            connection_id: message.payload.connection_id,
            retry_after_ms: 2000,
          },
          { device_id: this.config.deviceId },
        ),
      );
      return;
    }

    const valid =
      message.payload.key_id === keyRecord.key_id &&
      verifyProof(keyRecord.key, message.payload.nonce, message.payload.proof);

    if (valid) {
      this.rememberAuthNonce(authNonceKey);
      if (message.payload.connection_id) {
        this.authenticatedAppConnectionIds.add(message.payload.connection_id);
      }
      this.send(
        createMessage(
          "auth.ok",
          {
            agent_instance_id: keyRecord.agent_instance_id,
            connection_id: message.payload.connection_id,
            business_security_mode: this.config.businessSecurityMode,
            e2e: this.e2eSupport(),
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

  private rememberAuthNonce(nonceKey: string): void {
    this.seenAuthNonceSet.add(nonceKey);
    this.seenAuthNonces.push(nonceKey);
    while (this.seenAuthNonces.length > 1024) {
      const oldest = this.seenAuthNonces.shift();
      if (oldest) {
        this.seenAuthNonceSet.delete(oldest);
      }
    }
  }

  private async handleSessionList(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void> {
    const sessions = await this.sessionManager.list();
    const payload: SessionListPayload = {
      default_cwd: this.config.defaultCwd,
      providers: this.runtimes.providers(),
      workspaces: await this.workspaces.list(sessions),
      sessions,
    };
    this.sendToApp(
      context,
      createMessage("session.list", payload, {
        device_id: this.config.deviceId,
        id: message.id,
      }),
    );
  }

  private async handleWorkspaceList(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void> {
    this.sendToApp(
      context,
      createMessage(
        "workspace.list",
        {
          workspaces: await this.workspaces.list(
            await this.sessionManager.list(),
          ),
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
    context?: AgentDispatchContext,
  ): Promise<void> {
    const workspace = await this.requireWorkspace(
      message.payload.workspacePath,
    );
    this.sendToApp(
      context,
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
    context?: AgentDispatchContext,
  ): Promise<void> {
    const workspace = await this.requireWorkspace(
      message.payload.workspacePath,
    );
    this.sendToApp(
      context,
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
    context?: AgentDispatchContext,
  ): Promise<void> {
    const workspace = await this.requireWorkspace(
      message.payload.workspacePath,
    );
    this.sendToApp(
      context,
      createMessage("git.status", await this.git.status(workspace), {
        device_id: this.config.deviceId,
        id: message.id,
      }),
    );
  }

  private async handleGitDiff(
    message: MessageEnvelope<GitDiffRequestPayload>,
    context?: AgentDispatchContext,
  ): Promise<void> {
    const workspace = await this.requireWorkspace(
      message.payload.workspacePath,
    );
    this.sendToApp(
      context,
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
    context?: AgentDispatchContext,
  ): Promise<void> {
    let session;
    try {
      session = await this.sessionManager.create(
        message.payload ?? {},
        (nextSession) => this.sendSessionStatus(nextSession),
      );
    } catch (error) {
      this.sendToApp(
        context,
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

    await this.handleTerminalSnapshot(
      {
        ...message,
        session_id: session.session_id,
      },
      context,
    );
    if (context) {
      this.addTerminalSubscriber(session.session_id, context.appConnectionId);
    }
    this.startTerminalPusher(session.session_id);
  }

  private async handleSessionRename(
    message: MessageEnvelope<SessionRenamePayload>,
    context?: AgentDispatchContext,
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
    await this.handleSessionList(message, context);
  }

  private async handleSessionAttach(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void> {
    if (!message.session_id) {
      return;
    }

    const session = await this.sessionManager.attach(message.session_id);
    if (!session) {
      return;
    }

    this.sendToApp(
      context,
      createMessage(
        "session.status",
        { session },
        {
          device_id: this.config.deviceId,
          session_id: session.session_id,
        },
      ),
    );
    if (context) {
      this.addTerminalSubscriber(session.session_id, context.appConnectionId);
    }
    await this.handleTerminalSnapshot(
      {
        ...message,
        session_id: session.session_id,
      },
      context,
    );
    this.startTerminalPusher(session.session_id);
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
    context?: AgentDispatchContext,
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

    this.sendToApp(
      context,
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
    this.terminalSubscribers.delete(sessionId);
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

    const frameMessage = createMessage<TerminalFramePayload>(
      "terminal.frame",
      frame,
      {
        device_id: this.config.deviceId,
        session_id: sessionId,
      },
    );
    const subscribers = this.terminalSubscribers.get(sessionId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }
    for (const appConnectionId of subscribers) {
      this.sendToAppByConnectionId(appConnectionId, frameMessage);
    }
  }

  private send(message: MessageEnvelope): void {
    if (!this.transport) {
      this.logger.warn("cannot send without transport", {
        message_type: message.type,
      });
      return;
    }

    if (isE2EBusinessMessage(message.type)) {
      this.broadcastToReadyApps(message);
      return;
    }

    this.transport.send(message);
  }

  private sendToApp(
    context: AgentDispatchContext | undefined,
    message: MessageEnvelope,
  ): void {
    if (!context) {
      this.logger.warn("dropped app-scoped message without context", {
        message_type: message.type,
      });
      return;
    }
    this.sendToAppByConnectionId(context.appConnectionId, message);
  }

  private sendToAppByConnectionId(
    appConnectionId: string,
    message: MessageEnvelope,
  ): void {
    if (!this.transport) {
      this.logger.warn("cannot send without transport", {
        message_type: message.type,
      });
      return;
    }
    const peer = this.e2ePeers.get(appConnectionId);
    if (this.config.businessSecurityMode === "plaintext_allowed") {
      this.transport.send({
        ...message,
        app_connection_id: appConnectionId,
      });
      return;
    }
    if (!peer?.ready) {
      this.logger.warn("dropped business message without ready app e2e peer", {
        app_connection_id: appConnectionId,
        message_type: message.type,
      });
      return;
    }
    const encrypted = peer.session.encrypt(messageToInner(message));
    this.transport.send(
      createMessage("e2e.message", encrypted.payload, {
        device_id: this.config.deviceId,
      }),
    );
  }

  private broadcastToReadyApps(message: MessageEnvelope): void {
    if (this.config.businessSecurityMode === "plaintext_allowed") {
      for (const appConnectionId of this.authenticatedAppConnectionIds) {
        this.sendToAppByConnectionId(appConnectionId, message);
      }
      return;
    }
    for (const peer of this.e2ePeers.values()) {
      if (peer.ready) {
        this.sendToAppByConnectionId(peer.appConnectionId, message);
      }
    }
  }

  private e2eSupport(): typeof E2E_SUPPORT_V1 {
    return {
      ...E2E_SUPPORT_V1,
      required: this.config.businessSecurityMode === "e2e_required",
    };
  }

  private addTerminalSubscriber(
    sessionId: string,
    appConnectionId: string,
  ): void {
    const subscribers =
      this.terminalSubscribers.get(sessionId) ?? new Set<string>();
    subscribers.add(appConnectionId);
    this.terminalSubscribers.set(sessionId, subscribers);
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

function isE2EBusinessMessage(type: string): boolean {
  return (
    type.startsWith("session.") ||
    type.startsWith("terminal.") ||
    type.startsWith("workspace.") ||
    type.startsWith("files.") ||
    type.startsWith("git.") ||
    type.startsWith("codex.") ||
    type.startsWith("tunnel.upgrade.")
  );
}

function messageToInner(message: MessageEnvelope): InnerEnvelope {
  return {
    v: INNER_PROTOCOL_VERSION,
    id: message.id,
    type: message.type,
    created_at: message.ts,
    session_id: message.session_id,
    payload: message.payload,
  };
}

function innerToMessage(
  inner: InnerEnvelope,
  deviceId: string,
): MessageEnvelope {
  return {
    v: PROTOCOL_SUPPORT_V1.current,
    id: inner.id,
    type: inner.type,
    device_id: deviceId,
    session_id: inner.session_id,
    ts: inner.created_at,
    payload: inner.payload,
  };
}
