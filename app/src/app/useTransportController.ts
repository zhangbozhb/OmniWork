import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppNetworkChangedPayload,
  MessageEnvelope,
  TransportPath,
  TransportPreference,
} from "@omni-work/protocol-ts";

import type { PairingConfig } from "../features/auth/types";
import {
  formatErrorMessage,
  formatRelayCloseMessage,
  formatStrictForceCloseMessage,
} from "./connectionMessages";
import { createAppSessionTransport } from "./appTransport";
import type {
  AppSessionTransport,
  ConnectionStatus,
  NetworkChangeDetails,
} from "./appTypes";

type UseTransportControllerOptions = {
  pairing: PairingConfig | null;
  transportPreference: TransportPreference;
  onMessage(
    message: MessageEnvelope,
    relay: AppSessionTransport,
    activePairing: PairingConfig,
  ): void;
  onPreferP2pConnectStart(): void;
  onDirectConnectionReady(): void;
  setPairing(pairing: PairingConfig | null): void;
};

export function useTransportController({
  pairing,
  transportPreference,
  onMessage,
  onPreferP2pConnectStart,
  onDirectConnectionReady,
  setPairing,
}: UseTransportControllerOptions) {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("idle");
  const [connectionPath, setConnectionPath] = useState<TransportPath>("relay");
  const [connectionMessage, setConnectionMessage] = useState(
    "Scan or paste a Desktop pairing link.",
  );
  const relayRef = useRef<AppSessionTransport | null>(null);
  const directBusinessReadyRef = useRef(false);
  const onMessageRef = useRef(onMessage);
  const onPreferP2pConnectStartRef = useRef(onPreferP2pConnectStart);
  const onDirectConnectionReadyRef = useRef(onDirectConnectionReady);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    onPreferP2pConnectStartRef.current = onPreferP2pConnectStart;
  }, [onPreferP2pConnectStart]);

  useEffect(() => {
    onDirectConnectionReadyRef.current = onDirectConnectionReady;
  }, [onDirectConnectionReady]);

  useEffect(() => {
    if (!pairing) {
      relayRef.current?.close();
      relayRef.current = null;
      setConnectionStatus("idle");
      setConnectionPath("relay");
      setConnectionMessage("Scan or paste a Desktop pairing link.");
      return undefined;
    }

    let closed = false;
    let failed = false;
    const relay = createAppSessionTransport(pairing, transportPreference, {
      onForceClose: (reason) => {
        if (closed || failed) {
          return;
        }
        failed = true;
        setConnectionStatus("failed");
        setConnectionMessage(formatStrictForceCloseMessage(reason));
        relay.close();
      },
    });
    relayRef.current = relay;
    directBusinessReadyRef.current = false;
    if (transportPreference === "prefer_p2p") {
      onPreferP2pConnectStartRef.current();
    }
    setConnectionStatus("connecting");
    setConnectionPath(relay.getCurrentPath());
    setConnectionMessage("Opening secure connection...");

    const unsubscribe = relay.onMessage((message) => {
      if (closed || failed) {
        return;
      }
      onMessageRef.current(message, relay, pairing);
    });
    const unsubscribeClose = relay.onClose((event) => {
      if (closed || failed) {
        return;
      }
      failed = true;
      setConnectionStatus("failed");
      setConnectionMessage(formatRelayCloseMessage(event));
    });
    const unsubscribePathChange = relay.onPathChange((path) => {
      if (closed || failed) {
        return;
      }
      setConnectionPath(path);
      if (
        transportPreference === "prefer_p2p" &&
        path === "p2p" &&
        directBusinessReadyRef.current
      ) {
        onDirectConnectionReadyRef.current();
      }
    });
    const unsubscribeBusinessReady = relay.onBusinessReady(() => {
      if (closed || failed) {
        return;
      }
      directBusinessReadyRef.current = true;
      if (transportPreference === "prefer_p2p") {
        if (relay.getCurrentPath() === "p2p") {
          onDirectConnectionReadyRef.current();
        }
      } else {
        setConnectionStatus("authenticated");
        setConnectionMessage("Connected to Desktop.");
      }
    });

    relay
      .connect()
      .then(() => {
        if (!closed && !failed && !directBusinessReadyRef.current) {
          setConnectionStatus("authenticating");
          setConnectionMessage(
            "Waiting for the Agent authentication challenge...",
          );
        }
      })
      .catch((error: unknown) => {
        if (!closed && !failed) {
          failed = true;
          relay.close();
          setConnectionStatus("failed");
          setConnectionMessage(
            `Secure connection failed: ${formatErrorMessage(error)}`,
          );
        }
      });

    return () => {
      closed = true;
      unsubscribe();
      unsubscribeClose();
      unsubscribePathChange();
      unsubscribeBusinessReady();
      relay.close();
      if (relayRef.current === relay) {
        relayRef.current = null;
      }
    };
  }, [pairing, transportPreference]);

  const sendToRelay = useCallback((message: MessageEnvelope): void => {
    try {
      relayRef.current?.send(message);
    } catch (error: unknown) {
      setConnectionStatus("failed");
      setConnectionMessage(`Relay send failed: ${formatErrorMessage(error)}`);
    }
  }, []);

  const reconnectActivePairing = useCallback((): void => {
    if (!pairing) {
      return;
    }
    setConnectionStatus("connecting");
    setConnectionMessage("Reconnecting securely...");
    setPairing({ ...pairing });
  }, [pairing, setPairing]);

  const closeActiveTransport = useCallback((reason?: string): void => {
    relayRef.current?.close(reason);
    relayRef.current = null;
  }, []);

  const getAppConnectionId = useCallback((): string | null => {
    return relayRef.current?.getAppConnectionId() ?? null;
  }, []);

  const withActiveTransport = useCallback(
    (callback: (relay: AppSessionTransport) => void): void => {
      const relay = relayRef.current;
      if (relay) {
        callback(relay);
      }
    },
    [],
  );

  const requestP2pReconnect = useCallback(
    (
      reason: AppNetworkChangedPayload["reason"],
      details?: NetworkChangeDetails,
    ): void => {
      relayRef.current?.requestP2pReconnect(reason, details);
    },
    [],
  );

  return {
    connectionStatus,
    connectionPath,
    connectionMessage,
    setConnectionStatus,
    setConnectionMessage,
    sendToRelay,
    reconnectActivePairing,
    closeActiveTransport,
    getAppConnectionId,
    withActiveTransport,
    requestP2pReconnect,
  };
}
