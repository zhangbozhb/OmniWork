import { useEffect, useRef, useState } from "react";
import type {
  AgentAppMessage,
  AgentNotificationSettingsPayload,
  MessageEnvelope,
} from "@omniwork/protocol-ts";

import type { AppView, ConnectionStatus } from "../../app/appTypes";
import { formatErrorMessage } from "../../app/connectionMessages";
import type { PairingConfig } from "../auth/types";
import {
  agentMessageDeliveredRequest,
  setAgentNotificationSettingsRequest,
} from "./agentMessages";
import {
  createAgentMessageStore,
  type LocalAgentMessageRecord,
} from "./agentMessageStore";

const DEFAULT_AGENT_NOTIFICATION_SETTINGS: AgentNotificationSettingsPayload = {
  enabled: true,
  min_priority: "high",
  muted_providers: [],
  muted_message_kinds: [],
};

type UseAgentMessageControllerOptions = {
  getPairing(): PairingConfig | null;
  getConnectionStatus(): ConnectionStatus;
  getAppConnectionId(): string | null;
  getCurrentSessionId(): string | undefined;
  getCurrentView(): AppView;
  sendToRelay(message: MessageEnvelope): void;
  setConnectionMessage(message: string): void;
  onOpenMessageTarget(message: AgentAppMessage): void;
};

export function useAgentMessageController({
  getPairing,
  getConnectionStatus,
  getAppConnectionId,
  getCurrentSessionId,
  getCurrentView,
  sendToRelay,
  setConnectionMessage,
  onOpenMessageTarget,
}: UseAgentMessageControllerOptions) {
  const [agentNotificationSettings, setAgentNotificationSettings] =
    useState<AgentNotificationSettingsPayload>(
      DEFAULT_AGENT_NOTIFICATION_SETTINGS,
    );
  const [agentMessages, setAgentMessages] = useState<LocalAgentMessageRecord[]>(
    [],
  );
  const [agentUnreadCount, setAgentUnreadCount] = useState(0);
  const [agentMessageBanner, setAgentMessageBanner] =
    useState<LocalAgentMessageRecord | null>(null);
  const agentMessageStoreRef = useRef(createAgentMessageStore());
  const agentMessageBannerTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const agentNotificationSettingsRef = useRef<AgentNotificationSettingsPayload>(
    DEFAULT_AGENT_NOTIFICATION_SETTINGS,
  );

  useEffect(() => {
    agentNotificationSettingsRef.current = agentNotificationSettings;
  }, [agentNotificationSettings]);

  useEffect(() => {
    loadAgentMessages();
    return () => {
      if (agentMessageBannerTimerRef.current) {
        clearTimeout(agentMessageBannerTimerRef.current);
        agentMessageBannerTimerRef.current = null;
      }
    };
  }, []);

  function handleChangeAgentNotifications(enabled: boolean): void {
    const nextSettings = {
      ...agentNotificationSettings,
      enabled,
    };
    setAgentNotificationSettings(nextSettings);
    const pairing = getPairing();
    if (!pairing || getConnectionStatus() !== "authenticated") {
      return;
    }
    sendToRelay(
      setAgentNotificationSettingsRequest(pairing.deviceId, nextSettings),
    );
  }

  function loadAgentMessages(): void {
    const store = agentMessageStoreRef.current;
    store
      .initialize()
      .then(() => Promise.all([store.listMessages(), store.unreadCount()]))
      .then(([records, unreadCount]) => {
        setAgentMessages(records);
        setAgentUnreadCount(unreadCount);
      })
      .catch((error: unknown) => {
        setConnectionMessage(
          `Agent messages unavailable: ${formatErrorMessage(error)}`,
        );
      });
  }

  function handleAgentMessage(message: AgentAppMessage): void {
    const store = agentMessageStoreRef.current;
    store
      .saveMessage(message)
      .then((record) => {
        return Promise.all([store.listMessages(), store.unreadCount()]).then(
          ([records, unreadCount]) => ({ record, records, unreadCount }),
        );
      })
      .then(({ record, records, unreadCount }) => {
        setAgentMessages(records);
        setAgentUnreadCount(unreadCount);
        sendAgentMessageDelivered(message.id);
        maybeShowAgentMessageBanner(record);
      })
      .catch((error: unknown) => {
        setConnectionMessage(
          `Agent message save failed: ${formatErrorMessage(error)}`,
        );
      });
  }

  function sendAgentMessageDelivered(messageId: string): void {
    const pairing = getPairing();
    if (!pairing) {
      return;
    }
    const appConnectionId = getAppConnectionId();
    sendToRelay(
      agentMessageDeliveredRequest(pairing.deviceId, {
        message_id: messageId,
        app_connection_id: appConnectionId ?? undefined,
        delivered_at: new Date().toISOString(),
      }),
    );
  }

  function maybeShowAgentMessageBanner(record: LocalAgentMessageRecord): void {
    if (!agentNotificationSettingsRef.current.enabled) {
      return;
    }
    const message = record.message;
    if (message.priority === "low") {
      return;
    }
    if (
      getCurrentSessionId() === message.session_id &&
      getCurrentView() === "terminal"
    ) {
      return;
    }
    setAgentMessageBanner(record);
    if (agentMessageBannerTimerRef.current) {
      clearTimeout(agentMessageBannerTimerRef.current);
    }
    agentMessageBannerTimerRef.current = setTimeout(
      () => {
        setAgentMessageBanner(null);
        agentMessageBannerTimerRef.current = null;
      },
      message.priority === "normal" ? 4000 : 8000,
    );
  }

  function handleRefreshAgentMessages(): void {
    loadAgentMessages();
  }

  function handleMarkAgentMessageRead(messageId: string): void {
    const store = agentMessageStoreRef.current;
    store
      .markRead(messageId)
      .then(() => Promise.all([store.listMessages(), store.unreadCount()]))
      .then(([records, unreadCount]) => {
        setAgentMessages(records);
        setAgentUnreadCount(unreadCount);
      })
      .catch(() => undefined);
  }

  function handleMarkAgentMessageHandled(messageId: string): void {
    const store = agentMessageStoreRef.current;
    store
      .markHandled(messageId)
      .then(() => Promise.all([store.listMessages(), store.unreadCount()]))
      .then(([records, unreadCount]) => {
        setAgentMessages(records);
        setAgentUnreadCount(unreadCount);
      })
      .catch(() => undefined);
  }

  function handleOpenAgentMessage(record: LocalAgentMessageRecord): void {
    handleMarkAgentMessageRead(record.message.id);
    onOpenMessageTarget(record.message);
  }

  function handleAgentNotificationSettings(
    payload: AgentNotificationSettingsPayload,
  ): void {
    setAgentNotificationSettings(payload);
  }

  function dismissAgentMessageBanner(): void {
    setAgentMessageBanner(null);
  }

  return {
    agentNotificationSettings,
    agentMessages,
    agentUnreadCount,
    agentMessageBanner,
    dismissAgentMessageBanner,
    handleChangeAgentNotifications,
    handleRefreshAgentMessages,
    handleMarkAgentMessageRead,
    handleMarkAgentMessageHandled,
    handleOpenAgentMessage,
    handleAgentMessage,
    handleAgentNotificationSettings,
  };
}
