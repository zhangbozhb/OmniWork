import type { JSX } from "react";
import {
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";

import type {
  TerminalSession,
  WorkspaceDefinition,
} from "@omniwork/protocol-ts";

import { colors } from "../../ui/theme";
import { getWorkspaceDisplayName } from "./workbenchModel";
import { styles } from "./styles";

type Translate = (key: string, options?: Record<string, unknown>) => string;
type WorkspaceSessionGroup = {
  workspace: WorkspaceDefinition;
  sessions: TerminalSession[];
};

export function WorkspaceList({
  realWorkspaceGroups,
  unassignedSessions,
  sessionRefreshing,
  t,
  renderSessionRow,
  onRefreshSessions,
  onOpenWorkspace,
}: {
  realWorkspaceGroups: readonly WorkspaceSessionGroup[];
  unassignedSessions: readonly TerminalSession[];
  sessionRefreshing: boolean;
  t: Translate;
  renderSessionRow(session: TerminalSession): JSX.Element;
  onRefreshSessions(): void;
  onOpenWorkspace(workspace: WorkspaceDefinition): void;
}): JSX.Element {
  return (
    <ScrollView
      alwaysBounceVertical
      contentContainerStyle={[styles.list, styles.listStretch]}
      refreshControl={
        Platform.OS !== "web" ? (
          <RefreshControl
            refreshing={sessionRefreshing}
            tintColor={colors.success}
            onRefresh={onRefreshSessions}
          />
        ) : undefined
      }
    >
      <>
        {realWorkspaceGroups.length === 0 ? (
          <Text style={styles.empty}>{t("workspaces.empty")}</Text>
        ) : (
          <View style={styles.workspaceList}>
            {realWorkspaceGroups.map(({ workspace, sessions }) => (
              <Pressable
                key={workspace.path}
                style={styles.workspaceRow}
                onPress={() => onOpenWorkspace(workspace)}
              >
                <View style={styles.workspaceRowIcon}>
                  <Text style={styles.workspaceRowIconText}>
                    {getWorkspaceDisplayName(workspace, t)
                      .charAt(0)
                      .toUpperCase()}
                  </Text>
                </View>
                <View style={styles.workspaceRowContent}>
                  <View style={styles.workspaceRowTitleLine}>
                    <Text numberOfLines={1} style={styles.workspaceRowName}>
                      {getWorkspaceDisplayName(workspace, t)}
                    </Text>
                    {workspace.isGitRepository ? (
                      <View style={styles.gitDot} />
                    ) : null}
                  </View>
                  <Text
                    ellipsizeMode="middle"
                    numberOfLines={1}
                    style={styles.workspaceRowPath}
                  >
                    {workspace.path}
                  </Text>
                </View>
                <Text style={styles.workspaceRowMeta}>
                  {sessions.length > 0 ? `${sessions.length}` : ""}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {unassignedSessions.length > 0 ? (
          <View style={styles.providerSection}>
            <Text style={styles.sessionGroupLabel}>
              {t("workspaces.unassigned")}
            </Text>
            <View style={styles.sessionGroup}>
              {unassignedSessions.map(renderSessionRow)}
            </View>
          </View>
        ) : null}
      </>
    </ScrollView>
  );
}
