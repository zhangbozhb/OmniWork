import { useMemo, useState } from "react";

import type {
  AgentInteractionPayload,
  AgentInteractionRequestPayload,
} from "@omni-work/protocol-ts";

export function useAgentInteractionController() {
  const [pending, setPending] = useState<AgentInteractionRequestPayload[]>([]);

  const pendingBySurfaceId = useMemo(() => {
    const grouped: Record<string, AgentInteractionRequestPayload[]> = {};
    for (const interaction of pending) {
      (grouped[interaction.surface_id] ??= []).push(interaction);
    }
    return grouped;
  }, [pending]);

  function applyAgentInteraction(payload: AgentInteractionPayload): void {
    setPending((current) => reducePendingAgentInteractions(current, payload));
  }

  function clearAgentInteractions(): void {
    setPending([]);
  }

  return {
    pendingAgentInteractionsBySurfaceId: pendingBySurfaceId,
    applyAgentInteraction,
    clearAgentInteractions,
  };
}

export function reducePendingAgentInteractions(
  current: readonly AgentInteractionRequestPayload[],
  payload: AgentInteractionPayload,
): AgentInteractionRequestPayload[] {
  if (payload.kind === "sync_response") {
    return sortInteractions(payload.interactions);
  }
  if (payload.kind === "request") {
    return sortInteractions([
      ...current.filter(
        (interaction) =>
          interaction.interaction_id !== payload.interaction_id,
      ),
      payload,
    ]);
  }
  if (
    payload.kind === "result" ||
    (payload.kind === "error" && payload.interaction_id)
  ) {
    return current.filter(
      (interaction) =>
        interaction.interaction_id !== payload.interaction_id,
    );
  }
  return [...current];
}

function sortInteractions(
  interactions: readonly AgentInteractionRequestPayload[],
): AgentInteractionRequestPayload[] {
  return [...interactions].sort(
    (left, right) =>
      Date.parse(left.created_at) - Date.parse(right.created_at),
  );
}
