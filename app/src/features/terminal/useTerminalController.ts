import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MessageEnvelope,
  TerminalFramePayload,
  TerminalInputPayload,
  TerminalResizePayload,
  TerminalSession,
  TerminalSnapshotPayload,
  TerminalStreamDataPayload,
  TerminalStreamErrorPayload,
} from "@omniwork/protocol-ts";

import { appConfig } from "../../app/appConfig";
import type { AppView, ConnectionStatus } from "../../app/appTypes";
import type { PairingConfig } from "../auth/types";
import { getSessionCapabilities } from "../sessions/sessionCapabilities";
import { terminalFrameWatermarkAfterSnapshot } from "./terminalFrameWatermark";
import {
  terminalInputRequest,
  terminalResizeRequest,
  terminalSnapshotRequest,
  terminalStreamStartRequest,
  terminalStreamStopRequest,
} from "./terminalMessages";

const EMPTY_TERMINAL_FRAME =
  "Waiting for the connected computer terminal snapshot...";

export type TerminalStreamChunk = {
  surfaceId: string;
  data: string;
  seq?: number;
  streamId: string;
};

type UseTerminalControllerOptions = {
  pairing: PairingConfig | null;
  connectionStatus: ConnectionStatus;
  connectionPath: string;
  currentView: AppView;
  selectedSession: TerminalSession | null;
  closingSessionIds: readonly string[];
  killingSessionIds: readonly string[];
  sendToRelay(message: MessageEnvelope): void;
  setConnectionMessage(message: string): void;
  applySelectedSessionTerminalSize(size: TerminalResizePayload): void;
};

export function useTerminalController({
  pairing,
  connectionStatus,
  connectionPath,
  currentView,
  selectedSession,
  closingSessionIds,
  killingSessionIds,
  sendToRelay,
  setConnectionMessage,
  applySelectedSessionTerminalSize,
}: UseTerminalControllerOptions) {
  const [terminalFrames, setTerminalFrames] = useState<Record<string, string>>(
    {},
  );
  const [terminalStreamChunk, setTerminalStreamChunk] =
    useState<TerminalStreamChunk | null>(null);
  const pairingRef = useRef<PairingConfig | null>(null);
  const selectedSessionRef = useRef<TerminalSession | null>(null);
  const terminalFrameSeqRef = useRef<Record<string, number>>({});
  const terminalStreamSeqRef = useRef<Record<string, number>>({});
  const terminalStreamActiveRef = useRef<Record<string, string>>({});
  const terminalLastFrameAtRef = useRef<Record<string, number>>({});
  const terminalLastSnapshotRequestAtRef = useRef<Record<string, number>>({});
  const pendingTerminalFramesRef = useRef<Record<string, string>>({});
  const terminalFrameFlushTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  useEffect(() => {
    pairingRef.current = pairing;
  }, [pairing]);

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  const flushPendingTerminalFrames = useCallback(() => {
    terminalFrameFlushTimerRef.current = null;
    const pending = pendingTerminalFramesRef.current;
    pendingTerminalFramesRef.current = {};
    if (Object.keys(pending).length === 0) {
      return;
    }
    setTerminalFrames((current) => ({
      ...current,
      ...pending,
    }));
  }, []);

  const queueTerminalFrame = useCallback(
    (surfaceId: string, payload: TerminalFramePayload, seq?: number) => {
      if (typeof seq === "number") {
        const lastSeq = terminalFrameSeqRef.current[surfaceId] ?? 0;
        if (seq <= lastSeq) {
          return;
        }
        terminalFrameSeqRef.current[surfaceId] = seq;
      }
      terminalLastFrameAtRef.current[surfaceId] = Date.now();
      pendingTerminalFramesRef.current = {
        ...pendingTerminalFramesRef.current,
        [surfaceId]: payload.data,
      };
      if (terminalFrameFlushTimerRef.current) {
        return;
      }
      terminalFrameFlushTimerRef.current = setTimeout(
        flushPendingTerminalFrames,
        16,
      );
    },
    [flushPendingTerminalFrames],
  );

  useEffect(() => {
    return () => {
      if (terminalFrameFlushTimerRef.current) {
        clearTimeout(terminalFrameFlushTimerRef.current);
        terminalFrameFlushTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (connectionPath !== "p2p" || connectionStatus !== "authenticated") {
      return undefined;
    }
    const timer = setInterval(() => {
      const session = selectedSessionRef.current;
      if (!session) {
        return;
      }
      const lastFrameAt =
        terminalLastFrameAtRef.current[session.primary_surface_id] ?? 0;
      if (Date.now() - lastFrameAt >= 3_000) {
        requestTerminalSnapshotForCurrentSession();
      }
    }, 3_000);
    return () => clearInterval(timer);
  }, [connectionPath, connectionStatus]);

  useEffect(() => {
    if (
      connectionStatus !== "authenticated" ||
      currentView !== "terminal" ||
      !pairing ||
      !selectedSession
    ) {
      return undefined;
    }

    requestTerminalSnapshot(pairing.deviceId, selectedSession);
    if (appConfig.terminal.streamEnabled) {
      sendToRelay(
        terminalStreamStartRequest(
          pairing.deviceId,
          selectedSession.session_id,
          selectedSession.primary_surface_id,
        ),
      );
    }
    return () => {
      if (appConfig.terminal.streamEnabled) {
        sendToRelay(
          terminalStreamStopRequest(
            pairing.deviceId,
            selectedSession.session_id,
            selectedSession.primary_surface_id,
          ),
        );
      }
    };
  }, [connectionStatus, currentView, pairing, selectedSession, sendToRelay]);

  const selectedFrame = selectedSession
    ? (terminalFrames[selectedSession.primary_surface_id] ??
      EMPTY_TERMINAL_FRAME)
    : EMPTY_TERMINAL_FRAME;

  function handleTerminalInput(input: TerminalInputPayload): void {
    if (!pairing || !selectedSession || connectionStatus !== "authenticated") {
      return;
    }
    const capabilities = getSessionCapabilities(selectedSession, {
      closing: closingSessionIds.includes(selectedSession.session_id),
      killing: killingSessionIds.includes(selectedSession.session_id),
    });
    if (!capabilities.canInput) {
      setConnectionMessage(
        capabilities.unavailableReason ??
          "This session is not accepting input right now.",
      );
      return;
    }

    sendToRelay(
      terminalInputRequest(
        pairing.deviceId,
        selectedSession.session_id,
        selectedSession.primary_surface_id,
        input,
      ),
    );
  }

  function handleTerminalResize(size: TerminalResizePayload): void {
    if (!pairing || !selectedSession || connectionStatus !== "authenticated") {
      return;
    }
    const capabilities = getSessionCapabilities(selectedSession, {
      closing: closingSessionIds.includes(selectedSession.session_id),
      killing: killingSessionIds.includes(selectedSession.session_id),
    });
    if (!capabilities.canResize) {
      return;
    }

    applySelectedSessionTerminalSize(size);
    sendToRelay(
      terminalResizeRequest(
        pairing.deviceId,
        selectedSession.session_id,
        selectedSession.primary_surface_id,
        size,
      ),
    );
    requestTerminalSnapshot(pairing.deviceId, selectedSession);
  }

  function requestTerminalSnapshot(
    deviceId: string,
    session: TerminalSession,
  ): void {
    sendToRelay(
      terminalSnapshotRequest(
        deviceId,
        session.session_id,
        session.primary_surface_id,
      ),
    );
  }

  function requestTerminalSnapshotForCurrentSession(): void {
    const activePairing = pairingRef.current;
    const session = selectedSessionRef.current;
    if (!activePairing || !session) {
      return;
    }
    const now = Date.now();
    const lastRequest =
      terminalLastSnapshotRequestAtRef.current[session.primary_surface_id] ?? 0;
    if (now - lastRequest < 2_000) {
      return;
    }
    terminalLastSnapshotRequestAtRef.current[session.primary_surface_id] = now;
    sendToRelay(
      terminalSnapshotRequest(
        activePairing.deviceId,
        session.session_id,
        session.primary_surface_id,
      ),
    );
  }

  function clearTerminalState(): void {
    setTerminalFrames({});
    setTerminalStreamChunk(null);
    pendingTerminalFramesRef.current = {};
    terminalFrameSeqRef.current = {};
    terminalStreamSeqRef.current = {};
    terminalStreamActiveRef.current = {};
    terminalLastFrameAtRef.current = {};
    terminalLastSnapshotRequestAtRef.current = {};
  }

  function pruneTerminalSurfaces(remoteSurfaceIds: Set<string>): void {
    setTerminalFrames((current) => {
      const nextFrames = { ...current };
      for (const surfaceId of Object.keys(nextFrames)) {
        if (!remoteSurfaceIds.has(surfaceId)) {
          delete nextFrames[surfaceId];
          delete terminalFrameSeqRef.current[surfaceId];
          delete terminalStreamSeqRef.current[surfaceId];
          delete terminalStreamActiveRef.current[surfaceId];
          delete terminalLastFrameAtRef.current[surfaceId];
          delete terminalLastSnapshotRequestAtRef.current[surfaceId];
          delete pendingTerminalFramesRef.current[surfaceId];
        }
      }
      return nextFrames;
    });
    setTerminalStreamChunk((current) =>
      current && !remoteSurfaceIds.has(current.surfaceId) ? null : current,
    );
  }

  function applyTerminalSnapshot(
    payload: TerminalSnapshotPayload,
    message: MessageEnvelope,
  ): void {
    if (!message.surface_id) {
      return;
    }
    const nextWatermark = terminalFrameWatermarkAfterSnapshot(
      terminalFrameSeqRef.current[message.surface_id],
      message.seq,
    );
    if (typeof nextWatermark === "number") {
      terminalFrameSeqRef.current[message.surface_id] = nextWatermark;
    } else {
      delete terminalFrameSeqRef.current[message.surface_id];
    }
    delete pendingTerminalFramesRef.current[message.surface_id];
    terminalLastFrameAtRef.current[message.surface_id] = Date.now();
    setTerminalFrames((current) => ({
      ...current,
      [message.surface_id as string]: payload.data,
    }));
  }

  function applyTerminalFrame(
    payload: TerminalFramePayload,
    message: MessageEnvelope,
  ): void {
    if (!message.surface_id) {
      return;
    }
    if (terminalStreamActiveRef.current[message.surface_id]) {
      return;
    }
    queueTerminalFrame(message.surface_id, payload, message.seq);
  }

  function applyTerminalStreamReady(
    payload: { stream_id?: string },
    message: MessageEnvelope,
  ): void {
    if (message.surface_id && payload.stream_id) {
      terminalStreamActiveRef.current[message.surface_id] = payload.stream_id;
      terminalStreamSeqRef.current[message.surface_id] = 0;
    }
  }

  function applyTerminalStreamData(
    payload: TerminalStreamDataPayload,
    message: MessageEnvelope,
  ): void {
    if (!message.surface_id) {
      return;
    }
    const activeStreamId = terminalStreamActiveRef.current[message.surface_id];
    if (activeStreamId && activeStreamId !== payload.stream_id) {
      return;
    }
    if (typeof message.seq === "number") {
      const lastSeq = terminalStreamSeqRef.current[message.surface_id] ?? 0;
      if (message.seq <= lastSeq) {
        return;
      }
      terminalStreamSeqRef.current[message.surface_id] = message.seq;
    }
    terminalLastFrameAtRef.current[message.surface_id] = Date.now();
    setTerminalStreamChunk({
      surfaceId: message.surface_id,
      data: payload.data,
      seq: message.seq,
      streamId: payload.stream_id,
    });
  }

  function applyTerminalStreamError(
    payload: TerminalStreamErrorPayload,
    message: MessageEnvelope,
  ): void {
    if (message.surface_id) {
      delete terminalStreamActiveRef.current[message.surface_id];
      delete terminalStreamSeqRef.current[message.surface_id];
    }
    if (payload.code !== "TERMINAL_STREAM_DISABLED") {
      setConnectionMessage(payload.message);
    }
  }

  return {
    selectedFrame,
    terminalStreamChunk,
    handleTerminalInput,
    handleTerminalResize,
    requestTerminalSnapshot,
    requestTerminalSnapshotForCurrentSession,
    clearTerminalState,
    pruneTerminalSurfaces,
    applyTerminalSnapshot,
    applyTerminalFrame,
    applyTerminalStreamReady,
    applyTerminalStreamData,
    applyTerminalStreamError,
  };
}
