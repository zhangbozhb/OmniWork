import { useState } from "react";
import type { AgentSurfaceEventPayload } from "@omni-work/protocol-ts";

export function useAgentSurfaceController() {
  const [eventsBySurfaceId, setEventsBySurfaceId] = useState<
    Record<string, AgentSurfaceEventPayload[]>
  >({});

  function applyAgentSurfaceEvent(event: AgentSurfaceEventPayload): void {
    setEventsBySurfaceId((current) => {
      const existing = current[event.surface_id] ?? [];
      const index = existing.findIndex(
        (item) => item.event_id === event.event_id,
      );
      const nextEvents =
        index >= 0
          ? existing.map((item, itemIndex) =>
              itemIndex === index ? event : item,
            )
          : [...existing, event];
      nextEvents.sort(
        (left, right) =>
          Date.parse(left.created_at) - Date.parse(right.created_at),
      );
      return {
        ...current,
        [event.surface_id]: nextEvents,
      };
    });
  }

  function clearAgentSurfaceEvents(): void {
    setEventsBySurfaceId({});
  }

  return {
    agentSurfaceEventsBySurfaceId: eventsBySurfaceId,
    applyAgentSurfaceEvent,
    clearAgentSurfaceEvents,
  };
}
