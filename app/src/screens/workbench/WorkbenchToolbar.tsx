import type { JSX } from "react";
import { Text, View } from "react-native";

import type { WorkspaceDefinition } from "@omni-work/protocol-ts";

import { Button } from "../../ui/components";
import { getWorkspaceDisplayName } from "./workbenchModel";
import { styles } from "./styles";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function WorkbenchToolbar({
  activeWorkspace,
  realWorkspaceCount,
  sessionCount,
  t,
  onBack,
  onLeaveWorkspace,
  onRefreshSessions,
  onOpenProviders,
}: {
  activeWorkspace: WorkspaceDefinition | null;
  realWorkspaceCount: number;
  sessionCount: number;
  t: Translate;
  onBack(): void;
  onLeaveWorkspace(): void;
  onRefreshSessions(): void;
  onOpenProviders(): void;
}): JSX.Element {
  return (
    <View style={styles.actions}>
      <Button
        accessibilityLabel={
          activeWorkspace
            ? t("workspaces.backToWorkspaces")
            : t("workspaces.backToDevices")
        }
        icon="arrowLeft"
        iconOnly
        style={styles.backButton}
        onPress={activeWorkspace ? onLeaveWorkspace : onBack}
      >
        {t("common.back")}
      </Button>
      <View style={styles.toolbarTitleArea}>
        <Text style={styles.toolbarTitle}>
          {activeWorkspace
            ? getWorkspaceDisplayName(activeWorkspace, t)
            : t("workspaces.title")}
        </Text>
        <Text numberOfLines={1} style={styles.toolbarMeta}>
          {activeWorkspace
            ? activeWorkspace.path
            : t("workspaces.meta", {
                workspaceCount: realWorkspaceCount,
                sessionCount,
              })}
        </Text>
      </View>
      {!activeWorkspace ? (
        <>
          <Button
            accessibilityLabel={t("workspaces.refreshSessions")}
            icon="refresh"
            iconOnly
            style={styles.toolbarIconButton}
            onPress={onRefreshSessions}
          >
            {t("common.refresh")}
          </Button>
          <Button
            accessibilityLabel={t("workspaces.manageProviders")}
            icon="provider"
            iconOnly
            style={styles.toolbarIconButton}
            onPress={onOpenProviders}
          >
            {t("workspaces.manageProviders")}
          </Button>
        </>
      ) : null}
    </View>
  );
}
