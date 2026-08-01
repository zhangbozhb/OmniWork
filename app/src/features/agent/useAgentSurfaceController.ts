import { useRef, useState } from "react";
import type {
  AgentSurfaceEventPayload,
  AgentSurfaceSyncResponsePayload,
} from "@omni-work/protocol-ts";

export function useAgentSurfaceController() {
  const [eventsBySurfaceId, setEventsBySurfaceId] = useState<
    Record<string, AgentSurfaceEventPayload[]>
  >({});
  const cursorsBySurfaceIdRef = useRef<Record<string, number>>({});

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
    cursorsBySurfaceIdRef.current = {};
    setEventsBySurfaceId({});
  }

  function applyAgentSurfaceSync(
    payload: AgentSurfaceSyncResponsePayload,
  ): void {
    cursorsBySurfaceIdRef.current[payload.surface_id] = Math.max(
      cursorsBySurfaceIdRef.current[payload.surface_id] ?? 0,
      payload.next_cursor,
    );
    if (payload.events.length === 0) {
      return;
    }
    setEventsBySurfaceId((current) => {
      return {
        ...current,
        [payload.surface_id]: mergeAgentSurfaceEvents(
          current[payload.surface_id] ?? [],
          payload.events,
        ),
      };
    });
  }

  function getAgentSurfaceCursor(surfaceId: string): number {
    return cursorsBySurfaceIdRef.current[surfaceId] ?? 0;
  }

  return {
    agentSurfaceEventsBySurfaceId: eventsBySurfaceId,
    applyAgentSurfaceEvent,
    applyAgentSurfaceSync,
    getAgentSurfaceCursor,
    clearAgentSurfaceEvents,
  };
}

export function mergeAgentSurfaceEvents(
  existing: readonly AgentSurfaceEventPayload[],
  incoming: readonly AgentSurfaceEventPayload[],
): AgentSurfaceEventPayload[] {
  const merged = new Map(
    existing.map((event) => [event.event_id, event]),
  );
  for (const event of incoming) {
    merged.set(event.event_id, event);
  }
  return [...merged.values()].sort(
    (left, right) =>
      Date.parse(left.created_at) - Date.parse(right.created_at),
  );
}
