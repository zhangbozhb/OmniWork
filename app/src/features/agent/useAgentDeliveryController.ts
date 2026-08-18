import { useMemo, useState } from "react";
import type {
  AgentDeliveryPayload,
  DeliveryEpisodeSummary,
} from "@omni-work/protocol-ts";

export function useAgentDeliveryController() {
  const [episodes, setEpisodes] = useState<DeliveryEpisodeSummary[]>([]);

  const episodesBySurfaceId = useMemo(() => {
    const grouped: Record<string, DeliveryEpisodeSummary[]> = {};
    for (const episode of episodes) {
      if (!episode.surface_id) {
        continue;
      }
      (grouped[episode.surface_id] ??= []).push(episode);
    }
    for (const items of Object.values(grouped)) {
      items.sort(
        (left, right) =>
          Date.parse(left.started_at) - Date.parse(right.started_at),
      );
    }
    return grouped;
  }, [episodes]);

  function applyAgentDelivery(payload: AgentDeliveryPayload): void {
    if (payload.kind === "sync_response") {
      setEpisodes((current) => mergeEpisodes(current, payload.episodes));
      return;
    }
    if (
      payload.kind === "episode_updated" ||
      payload.kind === "outcome_result"
    ) {
      setEpisodes((current) => mergeEpisodes(current, [payload.episode]));
    }
  }

  function clearAgentDeliveries(): void {
    setEpisodes([]);
  }

  return {
    deliveryEpisodesBySurfaceId: episodesBySurfaceId,
    applyAgentDelivery,
    clearAgentDeliveries,
  };
}

export function mergeEpisodes(
  current: readonly DeliveryEpisodeSummary[],
  incoming: readonly DeliveryEpisodeSummary[],
): DeliveryEpisodeSummary[] {
  const merged = new Map(current.map((episode) => [episode.episode_id, episode]));
  for (const episode of incoming) {
    merged.set(episode.episode_id, episode);
  }
  return [...merged.values()].sort(
    (left, right) =>
      Date.parse(left.started_at) - Date.parse(right.started_at),
  );
}
