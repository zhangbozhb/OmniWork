import {
  createMessage,
  type CodexSession,
  type FilesListRequestPayload,
  type FilesReadRequestPayload,
  type FilesWriteRequestPayload,
  type GitDiffRequestPayload,
  type GitStatusRequestPayload,
  type MessageEnvelope,
} from "@omniwork/protocol-ts";
import { FileService } from "../files/fileService.ts";
import { GitService } from "../git/gitService.ts";
import { WorkspaceManager } from "../workspace/workspaceManager.ts";

type AgentDispatchContext = {
  appConnectionId: string;
  trustedE2E: boolean;
};

type ResourceRequestHandlerOptions = {
  deviceId: string;
  workspaces: WorkspaceManager;
  files?: FileService;
  git?: GitService;
  listSessions(): Promise<CodexSession[]>;
  sendToApp(
    context: AgentDispatchContext | undefined,
    message: MessageEnvelope,
  ): void;
};

export class ResourceRequestHandler {
  private readonly deviceId: string;
  private readonly workspaces: WorkspaceManager;
  private readonly files: FileService;
  private readonly git: GitService;
  private readonly listSessions: () => Promise<CodexSession[]>;
  private readonly sendToApp: (
    context: AgentDispatchContext | undefined,
    message: MessageEnvelope,
  ) => void;

  constructor(options: ResourceRequestHandlerOptions) {
    this.deviceId = options.deviceId;
    this.workspaces = options.workspaces;
    this.files = options.files ?? new FileService();
    this.git = options.git ?? new GitService();
    this.listSessions = options.listSessions;
    this.sendToApp = options.sendToApp;
  }

  async handleWorkspaceList(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void> {
    this.sendToApp(
      context,
      createMessage(
        "workspace.list",
        {
          workspaces: await this.workspaces.list(await this.listSessions()),
        },
        {
          device_id: this.deviceId,
          id: message.id,
        },
      ),
    );
  }

  async handleFilesList(
    message: MessageEnvelope<FilesListRequestPayload>,
    context?: AgentDispatchContext,
  ): Promise<void> {
    const workspace = await this.requireWorkspace(message.payload.workspacePath);
    this.sendToApp(
      context,
      createMessage(
        "files.list",
        await this.files.list(workspace, message.payload.relativePath),
        {
          device_id: this.deviceId,
          id: message.id,
        },
      ),
    );
  }

  async handleFilesRead(
    message: MessageEnvelope<FilesReadRequestPayload>,
    context?: AgentDispatchContext,
  ): Promise<void> {
    const workspace = await this.requireWorkspace(message.payload.workspacePath);
    this.sendToApp(
      context,
      createMessage(
        "files.read",
        await this.files.read(workspace, message.payload.relativePath),
        {
          device_id: this.deviceId,
          id: message.id,
        },
      ),
    );
  }

  async handleFilesWrite(
    message: MessageEnvelope<FilesWriteRequestPayload>,
    context?: AgentDispatchContext,
  ): Promise<void> {
    let payload;
    try {
      const workspace = await this.requireWorkspace(message.payload.workspacePath);
      payload = await this.files.write(workspace, message.payload);
    } catch (error) {
      payload = {
        workspacePath: message.payload.workspacePath,
        relativePath: message.payload.relativePath,
        status: "unsupported" as const,
        encoding: "utf8" as const,
        size: 0,
        baseHash: message.payload.baseHash,
        message: error instanceof Error ? error.message : "Failed to save file.",
      };
    }
    this.sendToApp(
      context,
      createMessage("files.write", payload, {
        device_id: this.deviceId,
        id: message.id,
      }),
    );
  }

  async handleGitStatus(
    message: MessageEnvelope<GitStatusRequestPayload>,
    context?: AgentDispatchContext,
  ): Promise<void> {
    const workspace = await this.requireWorkspace(message.payload.workspacePath);
    this.sendToApp(
      context,
      createMessage("git.status", await this.git.status(workspace), {
        device_id: this.deviceId,
        id: message.id,
      }),
    );
  }

  async handleGitDiff(
    message: MessageEnvelope<GitDiffRequestPayload>,
    context?: AgentDispatchContext,
  ): Promise<void> {
    const workspace = await this.requireWorkspace(message.payload.workspacePath);
    this.sendToApp(
      context,
      createMessage(
        "git.diff",
        await this.git.diff(
          workspace,
          message.payload.relativePath,
          message.payload.scope,
        ),
        {
          device_id: this.deviceId,
          id: message.id,
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
}
