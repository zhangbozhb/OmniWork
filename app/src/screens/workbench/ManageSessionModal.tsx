import type { JSX } from "react";
import { Modal, Pressable, Text, View } from "react-native";

import type { TerminalSession } from "@omniwork/protocol-ts";

import { getSessionCapabilities } from "../../features/sessions/sessionCapabilities";
import { Badge, Button, Card } from "../../ui/components";
import {
  formatAbsoluteTime,
  formatCompactPath,
  getCloseActionLabel,
  getStatusColors,
} from "./workbenchModel";
import { DetailRow } from "./DetailRow";
import { styles } from "./styles";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function ManageSessionModal({
  session,
  closingSessionIds,
  killingSessionIds,
  t,
  onClose,
  onRenameSession,
  onCloseSession,
  onKillTerminalSession,
}: {
  session: TerminalSession | null;
  closingSessionIds: readonly string[];
  killingSessionIds: readonly string[];
  t: Translate;
  onClose(): void;
  onRenameSession(session: TerminalSession): void;
  onCloseSession(session: TerminalSession): void;
  onKillTerminalSession(session: TerminalSession): void;
}): JSX.Element {
  const external = session?.origin === "external";
  const registered = session?.registered !== false;
  const closing = session
    ? closingSessionIds.includes(session.session_id)
    : false;
  const killing = session
    ? killingSessionIds.includes(session.session_id)
    : false;
  const capabilities = session
    ? getSessionCapabilities(session, { closing, killing })
    : null;
  const statusColors = capabilities
    ? getStatusColors(capabilities.statusTone)
    : null;

  return (
    <Modal
      transparent
      animationType="fade"
      visible={Boolean(session)}
      onRequestClose={onClose}
    >
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable onPress={() => {}}>
          <Card style={styles.modalCard}>
            {session && capabilities && statusColors ? (
              <>
                <View style={styles.manageHeader}>
                  <Text numberOfLines={2} style={styles.modalTitle}>
                    {session.title}
                  </Text>
                  <Badge
                    backgroundColor={statusColors.backgroundColor}
                    color={statusColors.color}
                    style={styles.statusBadge}
                  >
                    {capabilities.statusLabel}
                  </Badge>
                </View>
                <View style={styles.manageDetails}>
                  <DetailRow
                    label={t("workspaces.details.folder")}
                    value={formatCompactPath(session.cwd)}
                  />
                  <DetailRow
                    label={t("workspaces.details.created")}
                    value={formatAbsoluteTime(session.created_at, t)}
                  />
                </View>
                {capabilities.unavailableReason ? (
                  <Text style={styles.unavailableReason}>
                    {capabilities.unavailableReason}
                  </Text>
                ) : null}
                <View style={styles.manageActions}>
                  <Button
                    icon="edit"
                    style={styles.manageActionButton}
                    onPress={() => onRenameSession(session)}
                  >
                    {t("workspaces.actions.rename")}
                  </Button>
                </View>
                <View style={styles.manageDangerRow}>
                  {registered ? (
                    <Button
                      disabled={!capabilities.canClose}
                      icon={external ? "eyeOff" : "close"}
                      style={styles.manageDangerButton}
                      tone="danger"
                      onPress={() => onCloseSession(session)}
                    >
                      {closing
                        ? t("workspaces.actions.closing")
                        : external
                          ? t("workspaces.actions.forget")
                          : getCloseActionLabel(session, t)}
                    </Button>
                  ) : null}
                  <Button
                    disabled={!capabilities.canKill}
                    icon="trash"
                    style={styles.manageDangerButton}
                    tone="danger"
                    onPress={() => onKillTerminalSession(session)}
                  >
                    {killing
                      ? t("workspaces.actions.killing")
                      : t("workspaces.actions.killTerminal")}
                  </Button>
                </View>
              </>
            ) : null}
          </Card>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
