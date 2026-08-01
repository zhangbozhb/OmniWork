import type {
  AgentInteractionAnswerPayload,
  AgentInteractionRequestPayload,
  AgentInteractionResultPayload,
  AgentInteractionSyncRequestPayload,
} from "@omni-work/protocol-ts";

import type {
  AgentInteractionResolveResult,
  AgentInteractionStore,
} from "./agentInteractionStore.ts";

interface PendingInteraction {
  request: AgentInteractionRequestPayload;
  resolve(answer: AgentInteractionAnswerPayload): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface AgentInteractionServiceOptions {
  store: AgentInteractionStore;
  onRequest(request: AgentInteractionRequestPayload): void;
  onResult(result: AgentInteractionResultPayload): void;
}

export class AgentInteractionService {
  private readonly store: AgentInteractionStore;
  private readonly onRequest: AgentInteractionServiceOptions["onRequest"];
  private readonly onResult: AgentInteractionServiceOptions["onResult"];
  private readonly pending = new Map<string, PendingInteraction>();

  constructor(options: AgentInteractionServiceOptions) {
    this.store = options.store;
    this.onRequest = options.onRequest;
    this.onResult = options.onResult;
  }

  request(
    request: AgentInteractionRequestPayload,
  ): Promise<AgentInteractionAnswerPayload> {
    if (this.pending.has(request.interaction_id)) {
      return Promise.reject(
        new Error(`Interaction is already pending: ${request.interaction_id}`),
      );
    }
    this.store.create(request);
    const expiresInMs = Math.max(0, Date.parse(request.expires_at) - Date.now());
    return new Promise<AgentInteractionAnswerPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.interaction_id);
        const result = this.store.expire(
          request.interaction_id,
          "The request expired before it was answered.",
        );
        if (result) {
          this.onResult(result);
        }
        reject(new Error("Interaction expired"));
      }, expiresInMs);
      timer.unref();
      this.pending.set(request.interaction_id, {
        request,
        resolve,
        reject,
        timer,
      });
      this.onRequest(request);
    });
  }

  answer(
    answer: AgentInteractionAnswerPayload,
  ): AgentInteractionResolveResult {
    const resolved = this.store.resolve(answer);
    if (resolved.outcome !== "resolved" || !resolved.result) {
      return resolved;
    }
    const pending = this.pending.get(answer.interaction_id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(answer.interaction_id);
      pending.resolve(answer);
    }
    this.onResult(resolved.result);
    return resolved;
  }

  listPending(
    filter: AgentInteractionSyncRequestPayload,
  ): AgentInteractionRequestPayload[] {
    return this.store.listPending(filter);
  }

  cancelSession(sessionId: string): void {
    for (const [interactionId, pending] of this.pending.entries()) {
      if (pending.request.session_id !== sessionId) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pending.delete(interactionId);
      const result = this.store.cancel(
        interactionId,
        "The Agent session ended before this request was answered.",
      );
      if (result) {
        this.onResult(result);
      }
      pending.reject(new Error("Agent session ended"));
    }
  }
}
