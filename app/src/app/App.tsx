import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type {
  AuthFailedPayload,
  CodexSession,
  MessageEnvelope,
  RuntimeKind,
  SessionListPayload,
  TerminalFramePayload,
  TerminalInputPayload,
  TerminalResizePayload,
  TerminalSnapshotPayload,
} from "../../../packages/protocol-ts/src/index.ts";
import { createMessage } from "../../../packages/protocol-ts/src/index.ts";
import { PairingScreen } from "../screens/pairing/PairingScreen";
import { DeviceListScreen } from "../screens/devices/DeviceListScreen";
import { SessionListScreen } from "../screens/sessions/SessionListScreen";
import { TerminalScreen } from "../screens/terminal/TerminalScreen";
import type { PairingConfig } from "../features/auth/types";
import {
  closeSessionRequest,
  listSessionsRequest,
  createSessionRequest,
} from "../features/sessions/sessionMessages";
import {
  terminalInputRequest,
  terminalResizeRequest,
  terminalSnapshotRequest,
} from "../features/terminal/terminalMessages";
import { computeInitialTerminalSize } from "../features/terminal/terminalLayout";
import { MobileRelaySession } from "../lib/relay-client/mobileRelaySession";
import {
  clearPairing,
  loadPairings,
  savePairings,
} from "../native/secure-storage/securePairingStore";

type AppView = "pairing" | "devices" | "sessions" | "terminal";
type ConnectionStatus =
  | "idle"
  | "connecting"
  | "authenticating"
  | "authenticated"
  | "failed";

const EMPTY_TERMINAL_FRAME = "Waiting for the Mac Agent terminal snapshot...";

export default function App(): JSX.Element {
  const [pairings, setPairings] = useState<PairingConfig[]>([]);
  const [pairing, setPairing] = useState<PairingConfig | null>(null);
  const [view, setView] = useState<AppView>("pairing");
  const [editingPairing, setEditingPairing] = useState<
    PairingConfig | undefined
  >();
  const [selectedSession, setSelectedSession] = useState<CodexSession | null>(
    null,
  );
  const [sessions, setSessions] = useState<CodexSession[]>([]);
  const [defaultSessionCwd, setDefaultSessionCwd] = useState("");
  const [terminalFrames, setTerminalFrames] = useState<Record<string, string>>(
    {},
  );
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("idle");
  const [connectionMessage, setConnectionMessage] = useState(
    "Enter the Mac Agent key to pair.",
  );
  const [pairingError, setPairingError] = useState<string | undefined>();
  const [creatingSession, setCreatingSession] = useState(false);
  const [closingSessionIds, setClosingSessionIds] = useState<string[]>([]);
  const relayRef = useRef<MobileRelaySession | null>(null);
  const pendingCreateRef = useRef(false);
  const pairingsRef = useRef<PairingConfig[]>([]);
  const selectedSessionRef = useRef<CodexSession | null>(null);

  const canUseWorkspace = pairings.length > 0;
  const title = useMemo(() => {
    if (view === "pairing") return editingPairing ? "Edit Device" : "Pair Mac";
    if (view === "terminal") return selectedSession?.title ?? "Terminal";
    if (view === "sessions") return "Sessions";
    return "Devices";
  }, [editingPairing, selectedSession?.title, view]);

  const selectedFrame = selectedSession
    ? (terminalFrames[selectedSession.session_id] ?? EMPTY_TERMINAL_FRAME)
    : EMPTY_TERMINAL_FRAME;

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  useEffect(() => {
    pairingsRef.current = pairings;
  }, [pairings]);

  useEffect(() => {
    let active = true;
    loadPairings()
      .then((savedPairings) => {
        if (!active) {
          return;
        }
        setPairings(savedPairings);
        setPairing(savedPairings[0] ?? null);
        setView(savedPairings.length > 0 ? "devices" : "pairing");
      })
      .catch(() => {
        if (active) {
          setPairingError(
            "Could not restore the saved pairing. Enter the latest key again.",
          );
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!pairing) {
      relayRef.current?.close();
      relayRef.current = null;
      setConnectionStatus("idle");
      setConnectionMessage("Enter the Mac Agent key to pair.");
      return undefined;
    }

    let closed = false;
    const relay = new MobileRelaySession(pairing);
    relayRef.current = relay;
    setConnectionStatus("connecting");
    setConnectionMessage("Connecting to Relay...");

    const unsubscribe = relay.onMessage((message) => {
      if (closed) {
        return;
      }
      handleRelayMessage(message, relay, pairing);
    });

    relay
      .connect()
      .then(() => {
        if (!closed) {
          setConnectionStatus("authenticating");
          setConnectionMessage("Waiting for key proof challenge...");
        }
      })
      .catch((error: unknown) => {
        if (!closed) {
          setConnectionStatus("failed");
          setConnectionMessage(
            `Relay connection failed: ${formatErrorMessage(error)}`,
          );
        }
      });

    return () => {
      closed = true;
      unsubscribe();
      relay.close();
      if (relayRef.current === relay) {
        relayRef.current = null;
      }
    };
  }, [pairing]);

  useEffect(() => {
    if (
      connectionStatus !== "authenticated" ||
      view !== "terminal" ||
      !pairing ||
      !selectedSession
    ) {
      return undefined;
    }

    requestTerminalSnapshot(pairing.deviceId, selectedSession.session_id);
    const timer = setInterval(() => {
      requestTerminalSnapshot(pairing.deviceId, selectedSession.session_id);
    }, 1500);

    return () => clearInterval(timer);
  }, [connectionStatus, pairing, selectedSession, view]);

  async function handlePair(nextPairing: PairingConfig): Promise<void> {
    setPairingError(undefined);
    const nextPairings = editingPairing
      ? pairings.map((item) =>
          isSamePairing(item, editingPairing) ? nextPairing : item,
        )
      : upsertPairing(pairings, nextPairing);
    await savePairings(nextPairings);
    setPairings(nextPairings);
    setPairing(nextPairing);
    setEditingPairing(undefined);
    setView("devices");
  }

  function handleAddDevice(): void {
    setPairingError(undefined);
    setEditingPairing(undefined);
    setView("pairing");
  }

  function handleEditDevice(nextPairing: PairingConfig): void {
    setPairingError(undefined);
    setEditingPairing(nextPairing);
    setView("pairing");
  }

  function handleCancelPairing(): void {
    setEditingPairing(undefined);
    setView(pairings.length > 0 ? "devices" : "pairing");
  }

  function handleDeleteDevice(targetPairing: PairingConfig): void {
    Alert.alert(
      "Delete device",
      `Delete ${targetPairing.deviceId} from linked devices?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            removeDevice(targetPairing).catch((error: unknown) => {
              setPairingError(`Could not delete device: ${String(error)}`);
            });
          },
        },
      ],
    );
  }

  async function removeDevice(targetPairing: PairingConfig): Promise<void> {
    const nextPairings = await removeSavedPairing(targetPairing);
    setSessions([]);
    setSelectedSession(null);
    setTerminalFrames({});
    setClosingSessionIds([]);
    setEditingPairing(undefined);

    if (pairing && isSamePairing(pairing, targetPairing)) {
      relayRef.current?.close();
      setPairing(nextPairings[0] ?? null);
    }

    setView(nextPairings.length > 0 ? "devices" : "pairing");
  }

  async function removeSavedPairing(
    targetPairing: PairingConfig,
  ): Promise<PairingConfig[]> {
    const nextPairings = pairingsRef.current.filter(
      (item) => !isSamePairing(item, targetPairing),
    );
    if (nextPairings.length > 0) {
      await savePairings(nextPairings);
    } else {
      await clearPairing();
    }

    pairingsRef.current = nextPairings;
    setPairings(nextPairings);
    return nextPairings;
  }

  function handleOpenDevice(nextPairing: PairingConfig): void {
    if (!pairing || !isSamePairing(pairing, nextPairing)) {
      setPairing(nextPairing);
      setSessions([]);
      setSelectedSession(null);
      setTerminalFrames({});
      setClosingSessionIds([]);
      setView("devices");
      return;
    }

    if (connectionStatus === "authenticated") {
      setView("sessions");
      sendToRelay(listSessionsRequest(nextPairing.deviceId));
    }
  }

  function handleRefreshSessions(): void {
    if (!pairing) {
      return;
    }
    if (connectionStatus !== "authenticated") {
      setPairing({ ...pairing });
      return;
    }
    sendToRelay(listSessionsRequest(pairing.deviceId));
  }

  function handleCreateSession(input: {
    cwd: string;
    runtimeKind: RuntimeKind;
  }): void {
    if (!pairing || connectionStatus !== "authenticated") {
      return;
    }
    pendingCreateRef.current = true;
    setCreatingSession(true);
    sendToRelay(
      createSessionRequest(pairing.deviceId, {
        cwd: input.cwd,
        runtime_kind: input.runtimeKind,
        terminal_size: computeInitialTerminalSize(),
      }),
    );
  }

  function handleCloseSession(session: CodexSession): void {
    if (!pairing || connectionStatus !== "authenticated") {
      return;
    }

    Alert.alert("Close session", `Close ${session.title} on the Mac Agent?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Close",
        style: "destructive",
        onPress: () => {
          setClosingSessionIds((current) =>
            current.includes(session.session_id)
              ? current
              : [...current, session.session_id],
          );
          sendToRelay(
            closeSessionRequest(pairing.deviceId, session.session_id),
          );
        },
      },
    ]);
  }

  function handleOpenSession(session: CodexSession): void {
    setSelectedSession(session);
    setView("terminal");
    if (pairing && connectionStatus === "authenticated") {
      sendToRelay(
        createMessage(
          "session.attach",
          { session_id: session.session_id },
          {
            device_id: pairing.deviceId,
            session_id: session.session_id,
          },
        ),
      );
      requestTerminalSnapshot(pairing.deviceId, session.session_id);
    }
  }

  function handleTerminalInput(input: TerminalInputPayload): void {
    if (!pairing || !selectedSession || connectionStatus !== "authenticated") {
      return;
    }

    sendToRelay(
      terminalInputRequest(pairing.deviceId, selectedSession.session_id, input),
    );
    requestTerminalSnapshotsAfterInput(
      pairing.deviceId,
      selectedSession.session_id,
    );
  }

  function handleTerminalResize(size: TerminalResizePayload): void {
    if (!pairing || !selectedSession || connectionStatus !== "authenticated") {
      return;
    }

    setSelectedSession((current) =>
      current && current.session_id === selectedSession.session_id
        ? { ...current, terminal_size: size }
        : current,
    );
    setSessions((current) =>
      current.map((session) =>
        session.session_id === selectedSession.session_id
          ? { ...session, terminal_size: size }
          : session,
      ),
    );
    sendToRelay(
      terminalResizeRequest(pairing.deviceId, selectedSession.session_id, size),
    );
    requestTerminalSnapshot(pairing.deviceId, selectedSession.session_id);
  }

  function requestTerminalSnapshot(deviceId: string, sessionId: string): void {
    sendToRelay(terminalSnapshotRequest(deviceId, sessionId));
  }

  function requestTerminalSnapshotsAfterInput(
    deviceId: string,
    sessionId: string,
  ): void {
    for (const delayMs of [250, 700, 1400]) {
      setTimeout(() => {
        requestTerminalSnapshot(deviceId, sessionId);
      }, delayMs);
    }
  }

  function sendToRelay(message: MessageEnvelope): void {
    try {
      relayRef.current?.send(message);
    } catch (error: unknown) {
      setConnectionStatus("failed");
      setConnectionMessage(`Relay send failed: ${formatErrorMessage(error)}`);
    }
  }

  function handleRelayMessage(
    message: MessageEnvelope,
    relay: MobileRelaySession,
    activePairing: PairingConfig,
  ): void {
    switch (message.type) {
      case "auth.challenge":
        setConnectionStatus("authenticating");
        setConnectionMessage("Verifying temporary key...");
        break;
      case "auth.ok":
        setConnectionStatus("authenticated");
        setConnectionMessage("Connected to Mac Agent.");
        relay.send(listSessionsRequest(activePairing.deviceId));
        break;
      case "auth.failed": {
        const payload = message.payload as AuthFailedPayload;
        setConnectionStatus("failed");
        setConnectionMessage(`Authentication failed: ${payload.reason}`);
        setPairingError(
          "The Mac Agent rejected this key. The saved device is kept; edit it to enter the latest key.",
        );
        Alert.alert(
          "Authentication failed",
          "The saved device is still kept. Edit the device to enter the latest key, or try again after the Mac Agent is online.",
        );
        break;
      }
      case "session.list": {
        const payload = message.payload as SessionListPayload;
        const remoteSessionIds = new Set(
          payload.sessions.map((session) => session.session_id),
        );
        if (payload.default_cwd) {
          setDefaultSessionCwd(payload.default_cwd);
        }
        setSessions(payload.sessions);
        setClosingSessionIds((current) =>
          current.filter((sessionId) => remoteSessionIds.has(sessionId)),
        );
        setTerminalFrames((current) => {
          const nextFrames = { ...current };
          for (const sessionId of Object.keys(nextFrames)) {
            if (!remoteSessionIds.has(sessionId)) {
              delete nextFrames[sessionId];
            }
          }
          return nextFrames;
        });
        if (
          selectedSessionRef.current &&
          !remoteSessionIds.has(selectedSessionRef.current.session_id)
        ) {
          setSelectedSession(null);
          setView("sessions");
        }
        setCreatingSession(false);
        break;
      }
      case "session.status": {
        const payload = message.payload as { session: CodexSession };
        setSessions((current) => upsertSession(current, payload.session));
        setCreatingSession(false);
        if (pendingCreateRef.current) {
          pendingCreateRef.current = false;
          setSelectedSession(payload.session);
          setView("terminal");
        }
        break;
      }
      case "terminal.snapshot": {
        const payload = message.payload as TerminalSnapshotPayload;
        if (message.session_id) {
          setTerminalFrames((current) => ({
            ...current,
            [message.session_id as string]: payload.data,
          }));
        }
        break;
      }
      case "terminal.frame": {
        const payload = message.payload as TerminalFramePayload;
        if (message.session_id) {
          setTerminalFrames((current) => ({
            ...current,
            [message.session_id as string]: payload.data,
          }));
        }
        break;
      }
      case "terminal.error":
        setConnectionMessage("Terminal error from Mac Agent.");
        break;
      default:
        break;
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        {canUseWorkspace ? (
          <Text style={styles.subtitle}>
            {getHeaderSubtitle(view, pairings.length, pairing)}
          </Text>
        ) : null}
      </View>

      {view === "pairing" ? (
        <PairingScreen
          errorMessage={pairingError}
          initialPairing={editingPairing}
          submitLabel={editingPairing ? "Save Device" : "Pair Mac"}
          onCancel={pairings.length > 0 ? handleCancelPairing : undefined}
          onPair={handlePair}
        />
      ) : view === "devices" ? (
        <DeviceListScreen
          pairings={pairings}
          activePairing={pairing ?? undefined}
          connectionStatus={connectionStatus}
          connectionMessage={connectionMessage}
          onAddDevice={handleAddDevice}
          onEditDevice={handleEditDevice}
          onDeleteDevice={handleDeleteDevice}
          onOpenDevice={handleOpenDevice}
          onRefreshSessions={handleRefreshSessions}
        />
      ) : view === "sessions" ? (
        <SessionListScreen
          sessions={sessions}
          creating={creatingSession}
          closingSessionIds={closingSessionIds}
          defaultCwd={defaultSessionCwd || sessions[0]?.cwd || ""}
          onBack={() => setView("devices")}
          onCreateSession={handleCreateSession}
          onOpenSession={handleOpenSession}
          onCloseSession={handleCloseSession}
        />
      ) : selectedSession ? (
        <TerminalScreen
          session={selectedSession}
          frame={selectedFrame}
          connectionStatus={connectionStatus}
          statusLabel={connectionMessage}
          onBack={() => setView("sessions")}
          onInput={handleTerminalInput}
          onResize={handleTerminalResize}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#101417",
  },
  header: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomColor: "#263037",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    color: "#f5f7f8",
    fontSize: 20,
    fontWeight: "700",
  },
  subtitle: {
    color: "#94a3ad",
    fontSize: 12,
    marginTop: 3,
  },
});

function upsertSession(
  sessions: CodexSession[],
  nextSession: CodexSession,
): CodexSession[] {
  const index = sessions.findIndex(
    (session) => session.session_id === nextSession.session_id,
  );
  if (index < 0) {
    return [nextSession, ...sessions];
  }

  const nextSessions = [...sessions];
  nextSessions[index] = nextSession;
  return nextSessions;
}

function upsertPairing(
  pairings: PairingConfig[],
  nextPairing: PairingConfig,
): PairingConfig[] {
  const index = pairings.findIndex((pairing) =>
    isSamePairing(pairing, nextPairing),
  );
  if (index < 0) {
    return [...pairings, nextPairing];
  }

  const nextPairings = [...pairings];
  nextPairings[index] = nextPairing;
  return nextPairings;
}

function isSamePairing(left: PairingConfig, right: PairingConfig): boolean {
  return left.relayUrl === right.relayUrl && left.deviceId === right.deviceId;
}

function getHeaderSubtitle(
  view: AppView,
  deviceCount: number,
  activePairing: PairingConfig | null,
): string {
  if (view === "devices") {
    return `${deviceCount} linked ${deviceCount === 1 ? "device" : "devices"}`;
  }

  return activePairing?.deviceId ?? "";
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}
