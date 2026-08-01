import {
  createMessage,
  type FilesListRequestPayload,
  type FilesReadRequestPayload,
  type FilesWriteRequestPayload,
  type GitActionRequestPayload,
  type GitWorktreePayload,
  type GitDiffRequestPayload,
  type GitStatusRequestPayload,
  type MessageEnvelope,
  type WorkspaceDefinition,
} from "@omni-work/protocol-ts";
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
  listWorkspaces(): Promise<WorkspaceDefinition[]>;
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
  private readonly listWorkspaces: () => Promise<WorkspaceDefinition[]>;
  private readonly sendToApp: (
    context: AgentDispatchContext | undefined,
    message: MessageEnvelope,
  ) => void;

  constructor(options: ResourceRequestHandlerOptions) {
    this.deviceId = options.deviceId;
    this.workspaces = options.workspaces;
    this.files = options.files ?? new FileService();
    this.git = options.git ?? new GitService();
    this.listWorkspaces = options.listWorkspaces;
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
          workspaces: await this.listWorkspaces(),
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
    const workspace = await this.requireWorkspace(
      message.payload.workspacePath,
    );
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
    const workspace = await this.requireWorkspace(
      message.payload.workspacePath,
    );
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
      const workspace = await this.requireWorkspace(
        message.payload.workspacePath,
      );
      payload = await this.files.write(workspace, message.payload);
    } catch (error) {
      payload = {
        workspacePath: message.payload.workspacePath,
        relativePath: message.payload.relativePath,
        status: "unsupported" as const,
        encoding: "utf8" as const,
        size: 0,
        baseHash: message.payload.baseHash,
        message:
          error instanceof Error ? error.message : "Failed to save file.",
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
    const workspace = await this.requireWorkspace(
      message.payload.workspacePath,
    );
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
    const workspace = await this.requireWorkspace(
      message.payload.workspacePath,
    );
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

  async handleGitAction(
    message: MessageEnvelope<GitActionRequestPayload>,
    context?: AgentDispatchContext,
  ): Promise<void> {
    const response = {
      kind: "response" as const,
      request_id: message.id,
      action_id: message.payload.action_id,
      workspacePath: message.payload.workspacePath,
      operation: message.payload.operation.type,
      paths: message.payload.operation.paths,
    };
    try {
      const workspace = await this.requireWorkspace(
        message.payload.workspacePath,
      );
      const gitStatus = await this.git.action(
        workspace,
        message.payload.operation,
      );
      this.sendToApp(
        context,
        createMessage(
          "git.action",
          {
            ...response,
            result: "completed",
            git_status: gitStatus,
          },
          { device_id: this.deviceId },
        ),
      );
    } catch (error) {
      this.sendToApp(
        context,
        createMessage(
          "git.action",
          {
            ...response,
            result: "failed",
            error:
              error instanceof Error
                ? error.message
                : "Git action failed.",
          },
          { device_id: this.deviceId },
        ),
      );
    }
  }

  async handleGitWorktree(
    message: MessageEnvelope<
      Extract<
        GitWorktreePayload,
        { kind: "list_request" | "create_request" }
      >
    >,
    context?: AgentDispatchContext,
  ): Promise<void> {
    const payload = message.payload;
    try {
      const workspace = await this.requireWorkspace(payload.workspacePath);
      if (payload.kind === "list_request") {
        const worktrees = await this.git.listWorktrees(workspace);
        this.sendToApp(
          context,
          createMessage(
            "git.worktree",
            {
              kind: "list_response",
              request_id: message.id,
              workspacePath: payload.workspacePath,
              result: "completed",
              worktrees,
            },
            { device_id: this.deviceId },
          ),
        );
        return;
      }
      const result = await this.git.createWorktree(workspace, payload.name);
      this.sendToApp(
        context,
        createMessage(
          "git.worktree",
          {
            kind: "create_result",
            request_id: message.id,
            action_id: payload.action_id,
            workspacePath: payload.workspacePath,
            result: "completed",
            ...result,
          },
          { device_id: this.deviceId },
        ),
      );
    } catch (error) {
      const common = {
        request_id: message.id,
        workspacePath: payload.workspacePath,
        result: "failed" as const,
        worktrees: [],
        error:
          error instanceof Error ? error.message : "Git worktree request failed.",
      };
      this.sendToApp(
        context,
        createMessage(
          "git.worktree",
          payload.kind === "list_request"
            ? { kind: "list_response", ...common }
            : {
                kind: "create_result",
                action_id: payload.action_id,
                ...common,
              },
          { device_id: this.deviceId },
        ),
      );
    }
  }

  private async requireWorkspace(workspacePath: string) {
    const workspace = await this.workspaces.get(workspacePath);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspacePath}`);
    }
    return workspace;
  }
}
