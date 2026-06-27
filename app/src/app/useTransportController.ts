import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppNetworkChangedPayload,
  MessageEnvelope,
  TransportPath,
  TransportPreference,
} from "@omniwork/protocol-ts";

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
    "Enter the Desktop key to pair.",
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
      setConnectionMessage("Enter the Desktop key to pair.");
      return undefined;
    }

    let closed = false;
    const relay = createAppSessionTransport(pairing, transportPreference, {
      onForceClose: (reason) => {
        if (closed) {
          return;
        }
        setConnectionStatus("failed");
        setConnectionMessage(formatStrictForceCloseMessage(reason));
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
      if (closed) {
        return;
      }
      onMessageRef.current(message, relay, pairing);
    });
    const unsubscribeClose = relay.onClose((event) => {
      if (closed) {
        return;
      }
      setConnectionStatus("failed");
      setConnectionMessage(formatRelayCloseMessage(event));
    });
    const unsubscribePathChange = relay.onPathChange((path) => {
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
      directBusinessReadyRef.current = true;
      if (
        transportPreference === "prefer_p2p" &&
        relay.getCurrentPath() === "p2p"
      ) {
        onDirectConnectionReadyRef.current();
      }
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
