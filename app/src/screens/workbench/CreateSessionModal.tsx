import type { JSX } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";

import type {
  TerminalProviderDefinition,
  WorkspaceDefinition,
} from "@omniwork/protocol-ts";

import { Button, Card } from "../../ui/components";
import { getWorkspaceDisplayName } from "./workbenchModel";
import { styles } from "./styles";
import type {
  CreatableTerminalProviderKind,
  RuntimePreference,
} from "./workbenchTypes";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function CreateSessionModal({
  visible,
  createWorkspaceLocked,
  createCwd,
  createWorkspacePath,
  createTerminalProviderKind,
  createRuntimePreference,
  creatableProviders,
  workspaces,
  creating,
  t,
  onClose,
  onChangeCwd,
  onSelectWorkspace,
  onSelectProvider,
  onSelectRuntime,
  onConfirm,
}: {
  visible: boolean;
  createWorkspaceLocked: boolean;
  createCwd: string;
  createWorkspacePath?: string;
  createTerminalProviderKind: CreatableTerminalProviderKind;
  createRuntimePreference: RuntimePreference;
  creatableProviders: readonly TerminalProviderDefinition[];
  workspaces: readonly WorkspaceDefinition[];
  creating: boolean;
  t: Translate;
  onClose(): void;
  onChangeCwd(value: string): void;
  onSelectWorkspace(workspace: WorkspaceDefinition): void;
  onSelectProvider(providerKind: CreatableTerminalProviderKind): void;
  onSelectRuntime(runtime: RuntimePreference): void;
  onConfirm(): void;
}): JSX.Element {
  const appServerAvailable = createTerminalProviderKind === "codex";
  const runtimeOptions: Array<{
    kind: RuntimePreference;
    title: string;
    summary: string;
  }> = [
    {
      kind: "tmux",
      title: t("workspaces.runtime.tmux.title"),
      summary: t("workspaces.runtime.tmux.summary"),
    },
    ...(appServerAvailable
      ? [
          {
            kind: "app_server" as const,
            title: t("workspaces.runtime.appServer.title"),
            summary: t("workspaces.runtime.appServer.summary"),
          },
        ]
      : []),
  ];

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.modalAvoidingView}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            Keyboard.dismiss();
            onClose();
          }}
        >
          <Pressable onPress={() => {}}>
            <Card style={styles.modalCard}>
              <Text style={styles.modalTitle}>
                {createWorkspaceLocked
                  ? t("workspaces.newSession")
                  : t("workspaces.newWorkspace")}
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.workspacePicker}
              >
                {creatableProviders.map((provider) => {
                  const selected =
                    provider.kind === createTerminalProviderKind;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      key={provider.kind}
                      style={[
                        styles.workspaceChip,
                        selected && styles.workspaceChipSelected,
                      ]}
                      onPress={() => onSelectProvider(provider.kind)}
                    >
                      <Text
                        numberOfLines={1}
                        style={[
                          styles.workspaceChipText,
                          selected && styles.workspaceChipTextSelected,
                        ]}
                      >
                        {provider.displayName}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
              {!createWorkspaceLocked && workspaces.length > 0 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.workspacePicker}
                >
                  {workspaces.map((workspace) => {
                    const selected = workspace.path === createWorkspacePath;
                    return (
                      <Pressable
                        accessibilityRole="button"
                        key={workspace.path}
                        style={[
                          styles.workspaceChip,
                          selected && styles.workspaceChipSelected,
                        ]}
                        onPress={() => onSelectWorkspace(workspace)}
                      >
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.workspaceChipText,
                            selected && styles.workspaceChipTextSelected,
                          ]}
                        >
                          {getWorkspaceDisplayName(workspace, t)}
                        </Text>
                        {workspace.isGitRepository ? (
                          <Text style={styles.workspaceChipMeta}>Git</Text>
                        ) : null}
                      </Pressable>
                    );
                  })}
                </ScrollView>
              ) : null}
              {!createWorkspaceLocked ? (
                <TextInput
                  value={createCwd}
                  onChangeText={onChangeCwd}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={t("workspaces.modal.workingDirectory")}
                  placeholderTextColor="#66727c"
                  style={styles.cwdInput}
                />
              ) : null}
              <View style={styles.runtimeSection}>
                <Text style={styles.runtimeSectionTitle}>
                  {t("workspaces.runtime.title")}
                </Text>
                {runtimeOptions.map((option) => {
                  const selected = option.kind === createRuntimePreference;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      key={option.kind}
                      style={[
                        styles.runtimeOption,
                        selected && styles.runtimeOptionSelected,
                      ]}
                      onPress={() => onSelectRuntime(option.kind)}
                    >
                      <View style={styles.runtimeOptionHeader}>
                        <Text style={styles.runtimeOptionTitle}>
                          {option.title}
                        </Text>
                        {selected ? (
                          <Text style={styles.runtimeOptionBadge}>
                            {t("common.default")}
                          </Text>
                        ) : null}
                      </View>
                      <Text style={styles.runtimeOptionSummary}>
                        {option.summary}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <View style={styles.modalActions}>
                <Button
                  icon="close"
                  style={styles.modalSecondaryButton}
                  onPress={onClose}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  disabled={!createCwd.trim() || creating}
                  icon={creating ? "refresh" : "add"}
                  style={styles.modalPrimaryButton}
                  tone="primary"
                  onPress={onConfirm}
                >
                  {creating ? t("common.starting") : t("common.create")}
                </Button>
              </View>
            </Card>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}
