import type { JSX } from "react";
import { View } from "react-native";

import type { WorkspaceDefinition } from "@omni-work/protocol-ts";

import { Button } from "../../ui/components";
import { styles } from "./styles";
import type { WorkspaceTab } from "./workbenchTypes";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function WorkspaceTabBar({
  activeWorkspace,
  activeWorkspaceTab,
  t,
  onOpenWorkspaceTab,
}: {
  activeWorkspace: WorkspaceDefinition;
  activeWorkspaceTab: WorkspaceTab;
  t: Translate;
  onOpenWorkspaceTab(workspace: WorkspaceDefinition, tab: WorkspaceTab): void;
}): JSX.Element {
  return (
    <View style={styles.workspaceTabBar}>
      <Button
        icon="terminal"
        style={[
          styles.workspaceTabButton,
          activeWorkspaceTab === "sessions" && styles.workspaceTabButtonActive,
        ]}
        onPress={() => onOpenWorkspaceTab(activeWorkspace, "sessions")}
      >
        {t("workspaces.tabs.sessions")}
      </Button>
      {activeWorkspace.isGitRepository ? (
        <Button
          icon="git"
          style={[
            styles.workspaceTabButton,
            activeWorkspaceTab === "git" && styles.workspaceTabButtonActive,
          ]}
          onPress={() => onOpenWorkspaceTab(activeWorkspace, "git")}
        >
          {t("workspaces.tabs.git")}
        </Button>
      ) : null}
      <Button
        icon="folder"
        style={[
          styles.workspaceTabButton,
          activeWorkspaceTab === "files" && styles.workspaceTabButtonActive,
        ]}
        onPress={() => onOpenWorkspaceTab(activeWorkspace, "files")}
      >
        {t("workspaces.tabs.files")}
      </Button>
    </View>
  );
}
