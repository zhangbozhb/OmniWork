import { useEffect, useRef, useState } from "react";
import type {
  AgentAppMessage,
  AgentNotificationSettingsPayload,
  MessageEnvelope,
} from "@omniwork/protocol-ts";

import type { AppView, ConnectionStatus } from "../../app/appTypes";
import { formatErrorMessage } from "../../app/connectionMessages";
import type { ConfirmOptions } from "../../ui/confirm/ConfirmProvider";
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

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

type UseAgentMessageControllerOptions = {
  t(key: string): string;
  confirm: Confirm;
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
  t,
  confirm,
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
  const [agentMessagesRefreshing, setAgentMessagesRefreshing] = useState(false);
  const [agentMessageEditing, setAgentMessageEditing] = useState(false);
  const [selectedAgentMessageIds, setSelectedAgentMessageIds] = useState<
    Set<string>
  >(new Set());
  const agentMessageStoreRef = useRef(createAgentMessageStore());
  const agentMessageBannerTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const agentMessagesRefreshRef = useRef<Promise<void> | null>(null);
  const agentNotificationSettingsRef = useRef<AgentNotificationSettingsPayload>(
    DEFAULT_AGENT_NOTIFICATION_SETTINGS,
  );

  useEffect(() => {
    agentNotificationSettingsRef.current = agentNotificationSettings;
  }, [agentNotificationSettings]);

  useEffect(() => {
    const visibleIds = new Set(
      agentMessages.map((record) => record.message.id),
    );
    setSelectedAgentMessageIds((current) => {
      const next = new Set(
        [...current].filter((messageId) => visibleIds.has(messageId)),
      );
      return next.size === current.size ? current : next;
    });
  }, [agentMessages]);

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

  function loadAgentMessages(): Promise<void> {
    const store = agentMessageStoreRef.current;
    return store
      .initialize()
      .then(refreshAgentMessages)
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

  function handleRefreshAgentMessages(): Promise<void> {
    if (agentMessagesRefreshRef.current) {
      return agentMessagesRefreshRef.current;
    }
    setAgentMessagesRefreshing(true);
    const refresh = loadAgentMessages().finally(() => {
      agentMessagesRefreshRef.current = null;
      setAgentMessagesRefreshing(false);
    });
    agentMessagesRefreshRef.current = refresh;
    return refresh;
  }

  function handleMarkAgentMessageRead(messageId: string): void {
    const store = agentMessageStoreRef.current;
    store
      .markRead(messageId)
      .then(refreshAgentMessages)
      .catch(() => undefined);
  }

  function handleMarkAgentMessageHandled(messageId: string): void {
    const store = agentMessageStoreRef.current;
    store
      .markHandled(messageId)
      .then(refreshAgentMessages)
      .catch(() => undefined);
  }

  function handleOpenAgentMessage(record: LocalAgentMessageRecord): void {
    if (agentMessageEditing) {
      handleToggleAgentMessageSelected(record.message.id);
      return;
    }
    handleMarkAgentMessageRead(record.message.id);
    onOpenMessageTarget(record.message);
  }

  function handleChangeAgentMessageEditing(editing: boolean): void {
    setAgentMessageEditing(editing);
    if (!editing) {
      setSelectedAgentMessageIds(new Set());
    }
  }

  function handleToggleAgentMessageSelected(messageId: string): void {
    setSelectedAgentMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }

  function handleSelectAllAgentMessages(): void {
    setSelectedAgentMessageIds(
      new Set(agentMessages.map((record) => record.message.id)),
    );
  }

  function handleClearSelectedAgentMessages(): void {
    setSelectedAgentMessageIds(new Set());
  }

  function handleDeleteAgentMessage(messageId: string): void {
    const store = agentMessageStoreRef.current;
    store
      .dismissMessage(messageId)
      .then(() => {
        clearDeletedBanner([messageId]);
        setSelectedAgentMessageIds((current) => {
          if (!current.has(messageId)) {
            return current;
          }
          const next = new Set(current);
          next.delete(messageId);
          return next;
        });
      })
      .then(refreshAgentMessages)
      .catch((error: unknown) => {
        setConnectionMessage(
          `Agent message delete failed: ${formatErrorMessage(error)}`,
        );
      });
  }

  function handleDeleteSelectedAgentMessages(): void {
    const messageIds = [...selectedAgentMessageIds];
    if (!messageIds.length) {
      return;
    }
    confirm({
      title: t("messages.deleteSelectedTitle"),
      message: t("messages.deleteSelectedMessage"),
      confirmText: t("messages.delete"),
      cancelText: t("common.cancel"),
      tone: "danger",
      confirmIcon: "trash",
    })
      .then((confirmed) => {
        if (!confirmed) {
          return undefined;
        }
        const store = agentMessageStoreRef.current;
        return store.dismissMessages(messageIds).then(() => {
          clearDeletedBanner(messageIds);
          setSelectedAgentMessageIds(new Set());
          setAgentMessageEditing(false);
          return refreshAgentMessages();
        });
      })
      .catch((error: unknown) => {
        setConnectionMessage(
          `Agent messages delete failed: ${formatErrorMessage(error)}`,
        );
      });
  }

  function refreshAgentMessages(): Promise<void> {
    const store = agentMessageStoreRef.current;
    return Promise.all([store.listMessages(), store.unreadCount()]).then(
      ([records, unreadCount]) => {
        setAgentMessages(records);
        setAgentUnreadCount(unreadCount);
      },
    );
  }

  function clearDeletedBanner(messageIds: string[]): void {
    setAgentMessageBanner((current) =>
      current && messageIds.includes(current.message.id) ? null : current,
    );
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
    agentMessagesRefreshing,
    agentMessageEditing,
    selectedAgentMessageIds,
    dismissAgentMessageBanner,
    handleChangeAgentNotifications,
    handleRefreshAgentMessages,
    handleMarkAgentMessageRead,
    handleMarkAgentMessageHandled,
    handleChangeAgentMessageEditing,
    handleToggleAgentMessageSelected,
    handleSelectAllAgentMessages,
    handleClearSelectedAgentMessages,
    handleDeleteAgentMessage,
    handleDeleteSelectedAgentMessages,
    handleOpenAgentMessage,
    handleAgentMessage,
    handleAgentNotificationSettings,
  };
}
