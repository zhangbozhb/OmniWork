import type { JSX } from "react";
import { Pressable, Text, View } from "react-native";

import type { TerminalSession } from "@omniwork/protocol-ts";

import { getSessionCapabilities } from "../../features/sessions/sessionCapabilities";
import { formatRelativeTime, getStatusColors } from "./workbenchModel";
import { styles } from "./styles";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function SessionRow({
  session,
  closingSessionIds,
  killingSessionIds,
  t,
  onOpenSession,
  onManageSession,
}: {
  session: TerminalSession;
  closingSessionIds: readonly string[];
  killingSessionIds: readonly string[];
  t: Translate;
  onOpenSession(session: TerminalSession): void;
  onManageSession(session: TerminalSession): void;
}): JSX.Element {
  const closing = closingSessionIds.includes(session.session_id);
  const killing = killingSessionIds.includes(session.session_id);
  const external = session.origin === "external";
  const capabilities = getSessionCapabilities(session, {
    closing,
    killing,
  });
  const statusColors = getStatusColors(capabilities.statusTone);

  return (
    <Pressable
      disabled={!capabilities.canOpen}
      style={[styles.sessionRow, !capabilities.canOpen && styles.disabled]}
      onPress={() => onOpenSession(session)}
    >
      <View
        style={[styles.sessionDot, { backgroundColor: statusColors.color }]}
      />
      <View style={styles.sessionRowContent}>
        <Text numberOfLines={1} style={styles.sessionRowTitle}>
          {session.title}
        </Text>
        <Text numberOfLines={1} style={styles.sessionRowMeta}>
          {formatRelativeTime(session.last_active_at, t)}
          {external ? " · ext" : ""}
        </Text>
      </View>
      <Pressable
        accessibilityLabel={t("workspaces.actions.manageSession", {
          title: session.title,
        })}
        hitSlop={8}
        style={styles.sessionRowMore}
        onPress={() => onManageSession(session)}
      >
        <Text style={styles.sessionRowMoreText}>···</Text>
      </Pressable>
    </Pressable>
  );
}
