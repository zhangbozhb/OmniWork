import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import { Alert, SafeAreaView, StatusBar, StyleSheet, Text, View } from "react-native";

import type {
  AuthFailedPayload,
  CodexSession,
  MessageEnvelope,
  SessionListPayload,
  TerminalFramePayload,
  TerminalInputPayload,
  TerminalSnapshotPayload,
} from "../../../packages/protocol-ts/src/index.ts";
import { createMessage } from "../../../packages/protocol-ts/src/index.ts";
import { PairingScreen } from "../screens/pairing/PairingScreen";
import { DeviceListScreen } from "../screens/devices/DeviceListScreen";
import { SessionListScreen } from "../screens/sessions/SessionListScreen";
import { TerminalScreen } from "../screens/terminal/TerminalScreen";
import type { PairingConfig } from "../features/auth/types";
import { listSessionsRequest, createSessionRequest } from "../features/sessions/sessionMessages";
import { terminalInputRequest, terminalSnapshotRequest } from "../features/terminal/terminalMessages";
import { MobileRelaySession } from "../lib/relay-client/mobileRelaySession";
import { clearPairing, loadPairing, savePairing } from "../native/secure-storage/securePairingStore";

type AppView = "pairing" | "devices" | "sessions" | "terminal";
type ConnectionStatus = "idle" | "connecting" | "authenticating" | "authenticated" | "failed";

const EMPTY_TERMINAL_FRAME = "Waiting for the Mac Agent terminal snapshot...";

export default function App(): JSX.Element {
  const [pairing, setPairing] = useState<PairingConfig | null>(null);
  const [view, setView] = useState<AppView>("pairing");
  const [selectedSession, setSelectedSession] = useState<CodexSession | null>(null);
  const [sessions, setSessions] = useState<CodexSession[]>([]);
  const [terminalFrames, setTerminalFrames] = useState<Record<string, string>>({});
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [connectionMessage, setConnectionMessage] = useState("Enter the Mac Agent key to pair.");
  const [pairingError, setPairingError] = useState<string | undefined>();
  const [creatingSession, setCreatingSession] = useState(false);
  const relayRef = useRef<MobileRelaySession | null>(null);
  const pendingCreateRef = useRef(false);

  const canUseWorkspace = Boolean(pairing);
  const title = useMemo(() => {
    if (!pairing) return "Pair Mac";
    if (view === "terminal") return selectedSession?.title ?? "Terminal";
    if (view === "sessions") return "Sessions";
    return "Devices";
  }, [pairing, selectedSession?.title, view]);

  const selectedFrame = selectedSession ? terminalFrames[selectedSession.session_id] ?? EMPTY_TERMINAL_FRAME : EMPTY_TERMINAL_FRAME;

  useEffect(() => {
    let active = true;
    loadPairing()
      .then((savedPairing) => {
        if (!active || !savedPairing) {
          return;
        }
        setPairing(savedPairing);
        setView("devices");
      })
      .catch(() => {
        if (active) {
          setPairingError("Could not restore the saved pairing. Enter the latest key again.");
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
          setConnectionMessage(`Relay connection failed: ${String(error)}`);
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
    if (connectionStatus !== "authenticated" || view !== "terminal" || !pairing || !selectedSession) {
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
    await savePairing(nextPairing);
    setPairing(nextPairing);
    setView("devices");
  }

  async function handleForgetPairing(): Promise<void> {
    relayRef.current?.close();
    await clearPairing();
    setPairing(null);
    setSelectedSession(null);
    setSessions([]);
    setTerminalFrames({});
    setPairingError("The saved key was removed. Enter the Mac Agent's latest key.");
    setView("pairing");
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

  function handleCreateSession(): void {
    if (!pairing || connectionStatus !== "authenticated") {
      return;
    }
    pendingCreateRef.current = true;
    setCreatingSession(true);
    sendToRelay(createSessionRequest(pairing.deviceId, { title: `Codex ${sessions.length + 1}` }));
  }

  function handleOpenSession(session: CodexSession): void {
    setSelectedSession(session);
    setView("terminal");
    if (pairing && connectionStatus === "authenticated") {
      sendToRelay(createMessage("session.attach", { session_id: session.session_id }, {
        device_id: pairing.deviceId,
        session_id: session.session_id,
      }));
      requestTerminalSnapshot(pairing.deviceId, session.session_id);
    }
  }

  function handleTerminalInput(input: TerminalInputPayload): void {
    if (!pairing || !selectedSession || connectionStatus !== "authenticated") {
      return;
    }

    sendToRelay(terminalInputRequest(pairing.deviceId, selectedSession.session_id, input));
    setTimeout(() => {
      requestTerminalSnapshot(pairing.deviceId, selectedSession.session_id);
    }, 250);
  }

  function requestTerminalSnapshot(deviceId: string, sessionId: string): void {
    sendToRelay(terminalSnapshotRequest(deviceId, sessionId));
  }

  function sendToRelay(message: MessageEnvelope): void {
    try {
      relayRef.current?.send(message);
    } catch (error: unknown) {
      setConnectionStatus("failed");
      setConnectionMessage(`Relay send failed: ${String(error)}`);
    }
  }

  function handleRelayMessage(message: MessageEnvelope, relay: MobileRelaySession, activePairing: PairingConfig): void {
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
        if (shouldClearPairing(payload.reason)) {
          setPairingError("The Mac Agent rejected this key. Enter the latest key generated on the Mac.");
          setPairing(null);
          setView("pairing");
          clearPairing().catch(() => undefined);
          Alert.alert("Pairing expired", "The Mac Agent rejected this key. Enter the latest key generated on the Mac.");
        } else {
          Alert.alert("Mac unavailable", "The saved key is still kept. Try again after the Mac Agent is online.");
        }
        break;
      }
      case "session.list": {
        const payload = message.payload as SessionListPayload;
        setSessions(payload.sessions);
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
        {canUseWorkspace ? <Text style={styles.subtitle}>{pairing?.deviceId}</Text> : null}
      </View>

      {view === "pairing" ? (
        <PairingScreen errorMessage={pairingError} onPair={handlePair} />
      ) : view === "devices" && pairing ? (
        <DeviceListScreen
          pairing={pairing}
          connectionStatus={connectionStatus}
          connectionMessage={connectionMessage}
          onOpenSessions={() => setView("sessions")}
          onForgetPairing={handleForgetPairing}
          onRefreshSessions={handleRefreshSessions}
        />
      ) : view === "sessions" ? (
        <SessionListScreen
          sessions={sessions}
          creating={creatingSession}
          onBack={() => setView("devices")}
          onCreateSession={handleCreateSession}
          onOpenSession={handleOpenSession}
        />
      ) : selectedSession ? (
        <TerminalScreen
          session={selectedSession}
          frame={selectedFrame}
          status={connectionMessage}
          onBack={() => setView("sessions")}
          onInput={handleTerminalInput}
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

function upsertSession(sessions: CodexSession[], nextSession: CodexSession): CodexSession[] {
  const index = sessions.findIndex((session) => session.session_id === nextSession.session_id);
  if (index < 0) {
    return [nextSession, ...sessions];
  }

  const nextSessions = [...sessions];
  nextSessions[index] = nextSession;
  return nextSessions;
}

function shouldClearPairing(reason: AuthFailedPayload["reason"]): boolean {
  return reason !== "device_not_online" && reason !== "too_many_attempts";
}
