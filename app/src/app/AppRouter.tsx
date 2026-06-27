import type { ComponentProps, JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import type { AppView } from "./appTypes";
import { PairingScreen } from "../screens/pairing/PairingScreen";
import { DeviceListScreen } from "../screens/devices/DeviceListScreen";
import { AgentMessageInboxScreen } from "../screens/messages/AgentMessageInboxScreen";
import { SettingsScreen } from "../screens/settings/SettingsScreen";
import { SecuritySettingsScreen } from "../screens/security/SecuritySettingsScreen";
import { ConnectionPreferenceScreen } from "../screens/settings/ConnectionPreferenceScreen";
import { WorkbenchScreen } from "../screens/workbench/WorkbenchScreen";
import { GitStatusScreen } from "../screens/workspaces/GitStatusScreen";
import { TerminalScreen } from "../screens/terminal/TerminalScreen";
import { FileBrowserScreen } from "../screens/workspaces/FileBrowserScreen";
import { FileEditorScreen } from "../screens/workspaces/FileEditorScreen";

type AppRouterProps = {
  appLockScreen: JSX.Element | null;
  view: AppView;
  pairingScreenProps: ComponentProps<typeof PairingScreen>;
  deviceListScreenProps: ComponentProps<typeof DeviceListScreen>;
  agentMessageInboxScreenProps: ComponentProps<
    typeof AgentMessageInboxScreen
  >;
  settingsScreenProps: ComponentProps<typeof SettingsScreen>;
  securitySettingsScreenProps: ComponentProps<typeof SecuritySettingsScreen>;
  connectionPreferenceScreenProps: ComponentProps<
    typeof ConnectionPreferenceScreen
  >;
  workbenchScreenProps: ComponentProps<typeof WorkbenchScreen>;
  gitReviewScreenProps?: ComponentProps<typeof GitStatusScreen>;
  terminalScreenProps?: ComponentProps<typeof TerminalScreen>;
  terminalFilesScreenProps?: ComponentProps<typeof FileBrowserScreen>;
  fileEditorScreenProps?: ComponentProps<typeof FileEditorScreen>;
  onCloseTerminalFiles(): void;
};

export function AppRouter({
  appLockScreen,
  view,
  pairingScreenProps,
  deviceListScreenProps,
  agentMessageInboxScreenProps,
  settingsScreenProps,
  securitySettingsScreenProps,
  connectionPreferenceScreenProps,
  workbenchScreenProps,
  gitReviewScreenProps,
  terminalScreenProps,
  terminalFilesScreenProps,
  fileEditorScreenProps,
  onCloseTerminalFiles,
}: AppRouterProps): JSX.Element | null {
  if (appLockScreen) {
    return appLockScreen;
  }

  if (view === "pairing") {
    return <PairingScreen {...pairingScreenProps} />;
  }
  if (view === "devices") {
    return <DeviceListScreen {...deviceListScreenProps} />;
  }
  if (view === "messages") {
    return <AgentMessageInboxScreen {...agentMessageInboxScreenProps} />;
  }
  if (view === "settings") {
    return <SettingsScreen {...settingsScreenProps} />;
  }
  if (view === "securitySettings") {
    return <SecuritySettingsScreen {...securitySettingsScreenProps} />;
  }
  if (view === "connectionPreference") {
    return (
      <ConnectionPreferenceScreen {...connectionPreferenceScreenProps} />
    );
  }
  if (!isWorkbenchRoute(view)) {
    return null;
  }

  return (
    <>
      <WorkbenchScreen {...workbenchScreenProps} />
      {view === "gitReview" && gitReviewScreenProps ? (
        <View style={styles.fullScreenPage}>
          <GitStatusScreen {...gitReviewScreenProps} />
        </View>
      ) : null}
      {(view === "terminal" || view === "terminalFiles") &&
      terminalScreenProps ? (
        <View style={styles.fullScreenPage}>
          <TerminalScreen {...terminalScreenProps} />
        </View>
      ) : null}
      {view === "terminalFiles" && terminalFilesScreenProps ? (
        <Pressable
          style={styles.presentedBackdrop}
          onPress={onCloseTerminalFiles}
        >
          <Pressable
            style={styles.presentedPage}
            onPress={(event) => event.stopPropagation()}
          >
            <FileBrowserScreen {...terminalFilesScreenProps} />
          </Pressable>
        </Pressable>
      ) : null}
      {view === "fileEditor" && fileEditorScreenProps ? (
        <View style={styles.fullScreenPage}>
          <FileEditorScreen {...fileEditorScreenProps} />
        </View>
      ) : null}
    </>
  );
}

function isWorkbenchRoute(view: AppView): boolean {
  return (
    view === "workbench" ||
    view === "gitReview" ||
    view === "terminal" ||
    view === "terminalFiles" ||
    view === "fileEditor"
  );
}

const styles = StyleSheet.create({
  fullScreenPage: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#101417",
  },
  presentedBackdrop: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0, 0, 0, 0.34)",
  },
  presentedPage: {
    flex: 1,
    marginTop: 18,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    overflow: "hidden",
    backgroundColor: "#101417",
  },
});
