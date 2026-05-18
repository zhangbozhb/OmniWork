import { type JSX, useEffect, useMemo, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

import type {
  AgentCapability,
  AgentProviderDefinition,
  CodexSession,
  RuntimeKind,
} from "../../../../packages/protocol-ts/src/index.ts";
import {
  getAgentProviderDefinition,
  getCreatableAgentProviders,
  getRuntimeLabel,
  isCreatableRuntimeKind,
} from "../../../../packages/protocol-ts/src/index.ts";
import { getSessionCapabilities } from "../../features/sessions/sessionCapabilities";
import { Badge, Button, Card } from "../../ui/components";
import { colors, radii, spacing, typography } from "../../ui/theme";

type CreatableRuntimeKind = RuntimeKind;

type RuntimeGroup = {
  kind: RuntimeKind;
  label: string;
  summary: string;
  capability?: AgentCapability;
  creatable: boolean;
  hidden?: boolean;
  default?: boolean;
};

export interface SessionListScreenProps {
  sessions: CodexSession[];
  providers: AgentProviderDefinition[];
  providerPreferenceScope: string;
  creating: boolean;
  closingSessionIds?: string[];
  killingSessionIds?: string[];
  defaultCwd: string;
  onBack(): void;
  onRefreshSessions(): void;
  onCreateSession(input: {
    cwd: string;
    runtimeKind: CreatableRuntimeKind;
  }): void;
  onOpenSession(session: CodexSession): void;
  onCloseSession(session: CodexSession): void;
  onRenameSession(session: CodexSession, title: string): void;
  onRecoverSession(session: CodexSession): void;
  onKillTmuxSession(session: CodexSession): void;
}

type ProviderPreferences = {
  hiddenKinds: string[];
  orderedKinds: string[];
  defaultKind?: string;
};

const EMPTY_PROVIDER_PREFERENCES: ProviderPreferences = {
  hiddenKinds: [],
  orderedKinds: [],
};

const PROVIDER_PREFERENCES_STORAGE_PREFIX =
  "omniwork.session.providerPreferences";

export function SessionListScreen({
  sessions,
  providers,
  providerPreferenceScope,
  creating,
  closingSessionIds = [],
  killingSessionIds = [],
  defaultCwd,
  onBack,
  onRefreshSessions,
  onCreateSession,
  onOpenSession,
  onCloseSession,
  onRenameSession,
  onRecoverSession,
  onKillTmuxSession,
}: SessionListScreenProps): JSX.Element {
  const [providerPreferences, setProviderPreferences] =
    useState<ProviderPreferences>(EMPTY_PROVIDER_PREFERENCES);
  const [providerPreferencesLoaded, setProviderPreferencesLoaded] =
    useState(false);
  const [providersModalVisible, setProvidersModalVisible] = useState(false);
  const orderedProviders = useMemo(
    () => orderProviders(providers, providerPreferences.orderedKinds),
    [providerPreferences.orderedKinds, providers],
  );
  const enabledProviders = useMemo(
    () =>
      orderedProviders.filter(
        (provider) => !providerPreferences.hiddenKinds.includes(provider.kind),
      ),
    [orderedProviders, providerPreferences.hiddenKinds],
  );
  const creatableProviders = useMemo(
    () => getCreatableAgentProviders(enabledProviders),
    [enabledProviders],
  );
  const defaultCreateRuntimeKind = creatableProviders[0]?.kind ?? "other";
  const preferredCreateRuntimeKind =
    creatableProviders.find(
      (provider) => provider.kind === providerPreferences.defaultKind,
    )?.kind ?? defaultCreateRuntimeKind;
  const effectiveDefaultKind = preferredCreateRuntimeKind;
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [createCwd, setCreateCwd] = useState(defaultCwd);
  const [createRuntimeKind, setCreateRuntimeKind] =
    useState<CreatableRuntimeKind>(preferredCreateRuntimeKind);
  const [renamingSession, setRenamingSession] = useState<CodexSession | null>(
    null,
  );
  const [renameTitle, setRenameTitle] = useState("");
  const [managingSession, setManagingSession] = useState<CodexSession | null>(
    null,
  );

  const runtimeGroups = useMemo<RuntimeGroup[]>(
    () => [
      ...orderedProviders.map((provider) => ({
        kind: provider.kind,
        label: provider.displayName,
        summary: provider.summary,
        capability: provider.capability,
        creatable: provider.creatable,
        hidden: providerPreferences.hiddenKinds.includes(provider.kind),
        default: provider.kind === effectiveDefaultKind,
      })),
      {
        kind: "other",
        label: "Other",
        summary:
          "Existing tmux sessions that do not match a configured Agent CLI",
        creatable: false,
      },
    ],
    [effectiveDefaultKind, orderedProviders, providerPreferences],
  );

  useEffect(() => {
    setProviderPreferencesLoaded(false);
    AsyncStorage.getItem(getProviderPreferencesStorageKey(providerPreferenceScope))
      .then((value) => {
        setProviderPreferences(parseProviderPreferences(value));
      })
      .catch(() => {
        setProviderPreferences(EMPTY_PROVIDER_PREFERENCES);
      })
      .finally(() => {
        setProviderPreferencesLoaded(true);
      });
  }, [providerPreferenceScope]);

  useEffect(() => {
    if (!providerPreferencesLoaded) {
      return;
    }

    AsyncStorage.setItem(
      getProviderPreferencesStorageKey(providerPreferenceScope),
      JSON.stringify(providerPreferences),
    ).catch(() => {
      // Non-critical: provider preferences can be rebuilt from Agent metadata.
    });
  }, [providerPreferenceScope, providerPreferences, providerPreferencesLoaded]);

  useEffect(() => {
    if (
      !isCreatableRuntimeKind(createRuntimeKind, enabledProviders) ||
      providerPreferences.hiddenKinds.includes(createRuntimeKind)
    ) {
      setCreateRuntimeKind(preferredCreateRuntimeKind);
    }
  }, [
    createRuntimeKind,
    enabledProviders,
    preferredCreateRuntimeKind,
    providerPreferences.hiddenKinds,
  ]);

  useEffect(() => {
    setProviderPreferences((current) =>
      normalizeProviderPreferences(current, providers),
    );
  }, [providers]);

  function openCreateModal(runtimeKind: CreatableRuntimeKind): void {
    setCreateRuntimeKind(runtimeKind);
    setCreateCwd(defaultCwd);
    setCreateModalVisible(true);
  }

  function confirmCreateSession(): void {
    const cwd = createCwd.trim();
    if (!cwd) {
      return;
    }
    setCreateModalVisible(false);
    onCreateSession({ cwd, runtimeKind: createRuntimeKind });
  }

  function openRenameModal(session: CodexSession): void {
    setRenamingSession(session);
    setRenameTitle(session.title);
  }

  function confirmRenameSession(): void {
    const title = renameTitle.trim();
    if (!renamingSession || !title) {
      return;
    }

    onRenameSession(renamingSession, title);
    setRenamingSession(null);
    setRenameTitle("");
  }

  function handlePrimarySessionAction(
    session: CodexSession,
    capabilities: ReturnType<typeof getSessionCapabilities>,
  ): void {
    if (capabilities.canOpen) {
      onOpenSession(session);
      return;
    }

    if (capabilities.canRecover) {
      onRecoverSession(session);
    }
  }

  const visibleGroups = runtimeGroups.filter((group) => {
    if (group.hidden) {
      return false;
    }
    const hasSessions = sessions.some(
      (session) => getRuntimeGroupKind(session, providers) === group.kind,
    );
    if (group.creatable) {
      return hasSessions || (sessions.length === 0 && group.default);
    }

    return hasSessions;
  });

  return (
    <View style={styles.screen}>
      <View style={styles.actions}>
        <Button
          accessibilityLabel="Back to devices"
          icon="arrowLeft"
          iconOnly
          style={styles.backButton}
          onPress={onBack}
        >
          Devices
        </Button>
        <View style={styles.toolbarTitleArea}>
          <Text style={styles.toolbarTitle}>Sessions</Text>
          <Text style={styles.toolbarMeta}>
            {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
          </Text>
        </View>
        <Button
          accessibilityLabel="Refresh sessions"
          icon="refresh"
          iconOnly
          style={styles.toolbarIconButton}
          onPress={onRefreshSessions}
        >
          Refresh
        </Button>
        <Button
          accessibilityLabel="Manage providers"
          icon="provider"
          iconOnly
          style={styles.toolbarIconButton}
          onPress={() => setProvidersModalVisible(true)}
        >
          Providers
        </Button>
      </View>

      <ScrollView contentContainerStyle={styles.list}>
        {visibleGroups.map((group) => {
          const groupSessions = sessions.filter(
            (session) => getRuntimeGroupKind(session, providers) === group.kind,
          );
          return (
            <View key={group.kind} style={styles.runtimeSection}>
              <View style={styles.sectionHeader}>
                <View style={styles.sectionTitleArea}>
                  <View style={styles.sectionTitleRow}>
                    <Text style={styles.sectionTitle}>{group.label}</Text>
                    <Text style={styles.sectionMeta}>
                      {groupSessions.length}
                    </Text>
                    {group.default ? (
                      <Badge
                        backgroundColor={colors.successSoft}
                        color={colors.success}
                        style={styles.defaultBadge}
                      >
                        Default
                      </Badge>
                    ) : null}
                  </View>
                  {group.default ? (
                    <Text style={styles.sectionDescription}>
                      {group.summary}
                    </Text>
                  ) : null}
                </View>
                {group.creatable ? (
                  <Button
                    accessibilityLabel={`New ${group.label} session`}
                    disabled={creating}
                    icon="add"
                    iconOnly
                    style={styles.sectionCreateButton}
                    tone="primary"
                    onPress={() => {
                      if (isCreatableRuntimeKind(group.kind, providers)) {
                        openCreateModal(group.kind);
                      }
                    }}
                  >
                    {creating && createRuntimeKind === group.kind
                      ? "Starting..."
                      : "New"}
                  </Button>
                ) : null}
              </View>

              {groupSessions.length === 0 ? (
                <Text style={styles.empty}>No sessions yet.</Text>
              ) : (
                <View style={styles.sessionStack}>
                  {groupSessions.map((session) => {
                    const closing = closingSessionIds.includes(
                      session.session_id,
                    );
                    const killing = killingSessionIds.includes(
                      session.session_id,
                    );
                    const external = session.origin === "external";
                    const registered = session.registered !== false;
                    const capabilities = getSessionCapabilities(session, {
                      closing,
                      killing,
                    });
                    const statusColors = getStatusColors(
                      capabilities.statusTone,
                    );
                    const canUsePrimaryAction =
                      capabilities.canOpen || capabilities.canRecover;
                    return (
                      <Card key={session.session_id} style={styles.sessionCard}>
                        <Pressable
                          disabled={!capabilities.canOpen}
                          style={[
                            styles.sessionMain,
                            !capabilities.canOpen && styles.disabled,
                          ]}
                          onPress={() => onOpenSession(session)}
                        >
                          <View style={styles.sessionTitleRow}>
                            <Text numberOfLines={1} style={styles.sessionTitle}>
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
                          <View style={styles.sessionMetaRow}>
                            <Text
                              ellipsizeMode="middle"
                              numberOfLines={1}
                              style={styles.sessionMetaText}
                            >
                              {formatCompactPath(session.cwd)}
                            </Text>
                            <Text style={styles.sessionMetaDivider}>·</Text>
                            <Text style={styles.sessionTime}>
                              Active{" "}
                              {formatRelativeTime(session.last_active_at)}
                            </Text>
                          </View>
                          {external ? (
                            <Text style={styles.sessionSource}>
                              External tmux
                              {registered ? "" : " · tap Open to attach"}
                            </Text>
                          ) : null}
                          {capabilities.unavailableReason ? (
                            <Text style={styles.unavailableReason}>
                              {capabilities.unavailableReason}
                            </Text>
                          ) : null}
                        </Pressable>
                        <View style={styles.sessionActions}>
                          <Button
                            disabled={!canUsePrimaryAction}
                            icon={
                              capabilities.canRecover ? "refresh" : "terminal"
                            }
                            style={styles.primarySessionButton}
                            onPress={() =>
                              handlePrimarySessionAction(session, capabilities)
                            }
                          >
                            {capabilities.canRecover &&
                            capabilities.recoveryActionLabel
                              ? capabilities.recoveryActionLabel
                              : capabilities.primaryActionLabel}
                          </Button>
                          <Button
                            accessibilityLabel={`Manage ${session.title}`}
                            icon="more"
                            iconOnly
                            style={styles.moreButton}
                            onPress={() => setManagingSession(session)}
                          >
                            More
                          </Button>
                        </View>
                      </Card>
                    );
                  })}
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>
      <Button
        accessibilityLabel="New session"
        disabled={
          !isCreatableRuntimeKind(preferredCreateRuntimeKind, enabledProviders)
        }
        icon="add"
        style={styles.floatingCreateButton}
        tone="primary"
        onPress={() => openCreateModal(preferredCreateRuntimeKind)}
      >
        New Session
      </Button>

      <Modal
        transparent
        animationType="fade"
        visible={createModalVisible}
        onRequestClose={() => setCreateModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalAvoidingView}
        >
          <View
            style={styles.modalBackdrop}
            onStartShouldSetResponderCapture={() => {
              Keyboard.dismiss();
              return false;
            }}
          >
            <Card style={styles.modalCard}>
              <Text style={styles.modalTitle}>
                New {getRuntimeLabel(createRuntimeKind, providers)} Session
              </Text>
              <Text style={styles.modalDescription}>
                {getProviderSummary(createRuntimeKind, providers)} Confirm or
                edit the working directory before creating.
              </Text>
              <TextInput
                value={createCwd}
                onChangeText={setCreateCwd}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Working directory"
                placeholderTextColor="#66727c"
                style={styles.cwdInput}
              />
              <View style={styles.modalActions}>
                <Button
                  icon="close"
                  style={styles.modalSecondaryButton}
                  onPress={() => setCreateModalVisible(false)}
                >
                  Cancel
                </Button>
                <Button
                  disabled={!createCwd.trim() || creating}
                  icon={creating ? "refresh" : "add"}
                  style={styles.modalPrimaryButton}
                  tone="primary"
                  onPress={confirmCreateSession}
                >
                  {creating ? "Starting..." : "Create"}
                </Button>
              </View>
            </Card>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={Boolean(renamingSession)}
        onRequestClose={() => setRenamingSession(null)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalAvoidingView}
        >
          <View
            style={styles.modalBackdrop}
            onStartShouldSetResponderCapture={() => {
              Keyboard.dismiss();
              return false;
            }}
          >
            <Card style={styles.modalCard}>
              <Text style={styles.modalTitle}>Rename Session</Text>
              <Text style={styles.modalDescription}>
                Use a short task-focused name. The original tmux name stays
                unchanged.
              </Text>
              <TextInput
                value={renameTitle}
                onChangeText={setRenameTitle}
                autoCapitalize="sentences"
                autoCorrect
                maxLength={80}
                placeholder="Session title"
                placeholderTextColor="#66727c"
                style={styles.cwdInput}
              />
              <View style={styles.modalActions}>
                <Button
                  icon="close"
                  style={styles.modalSecondaryButton}
                  onPress={() => setRenamingSession(null)}
                >
                  Cancel
                </Button>
                <Button
                  disabled={!renameTitle.trim()}
                  icon="save"
                  style={styles.modalPrimaryButton}
                  tone="primary"
                  onPress={confirmRenameSession}
                >
                  Save
                </Button>
              </View>
            </Card>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={Boolean(managingSession)}
        onRequestClose={() => setManagingSession(null)}
      >
        <View style={styles.modalBackdrop}>
          <Card style={styles.modalCard}>
            {managingSession ? (
              <>
                {(() => {
                  const session = managingSession;
                  const external = session.origin === "external";
                  const registered = session.registered !== false;
                  const closing = closingSessionIds.includes(
                    session.session_id,
                  );
                  const killing = killingSessionIds.includes(
                    session.session_id,
                  );
                  const provider = getAgentProviderDefinition(
                    getRuntimeGroupKind(session, providers),
                    providers,
                  );
                  const capabilities = getSessionCapabilities(session, {
                    closing,
                    killing,
                  });
                  const statusColors = getStatusColors(
                    capabilities.statusTone,
                  );
                  return (
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
                          label="Provider"
                          value={getSessionRuntimeLabel(session, providers)}
                        />
                        <DetailRow
                          label="Folder"
                          value={formatCompactPath(session.cwd)}
                        />
                        <DetailRow label="Command" value={session.command} />
                        <DetailRow
                          label="Created"
                          value={formatAbsoluteTime(session.created_at)}
                        />
                        <DetailRow
                          label="Tmux"
                          value={session.tmux_session_name}
                        />
                        {provider ? (
                          <DetailRow
                            label="Capability"
                            value={provider.capability}
                          />
                        ) : null}
                        {external ? (
                          <DetailRow
                            label="Origin"
                            value={registered ? "Attached tmux" : "Existing tmux"}
                          />
                        ) : null}
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
                          onPress={() => {
                            setManagingSession(null);
                            openRenameModal(session);
                          }}
                        >
                          Rename
                        </Button>
                        {registered ? (
                          <Button
                            disabled={!capabilities.canClose}
                            icon={external ? "eyeOff" : "close"}
                            style={styles.manageActionButton}
                            tone="danger"
                            onPress={() => {
                              setManagingSession(null);
                              onCloseSession(session);
                            }}
                          >
                            {closing
                              ? "Closing..."
                              : external
                                ? "Forget tmux"
                                : getCloseActionLabel(session)}
                          </Button>
                        ) : null}
                        <Button
                          disabled={!capabilities.canKill}
                          icon="trash"
                          style={styles.manageActionButton}
                          tone="danger"
                          onPress={() => {
                            setManagingSession(null);
                            onKillTmuxSession(session);
                          }}
                        >
                          {killing ? "Killing..." : "Kill tmux"}
                        </Button>
                      </View>
                    </>
                  );
                })()}
                <View style={styles.modalActions}>
                  <Button
                    icon="check"
                    style={styles.modalSecondaryButton}
                    onPress={() => setManagingSession(null)}
                  >
                    Done
                  </Button>
                </View>
              </>
            ) : null}
          </Card>
        </View>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={providersModalVisible}
        onRequestClose={() => setProvidersModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <Card style={styles.modalCard}>
            <Text style={styles.modalTitle}>Provider Preferences</Text>
            <Text style={styles.modalDescription}>
              Choose which Agent CLIs appear in this app. The default provider is
              used by the floating New Session button.
            </Text>
            <ScrollView contentContainerStyle={styles.providerStack}>
              {orderedProviders.map((provider, index) => {
                const hidden = providerPreferences.hiddenKinds.includes(
                  provider.kind,
                );
                const isDefault =
                  provider.kind === effectiveDefaultKind;
                return (
                  <View
                    key={provider.kind}
                    style={[
                      styles.providerRow,
                      hidden && styles.providerRowHidden,
                    ]}
                  >
                    <View style={styles.providerInfo}>
                      <View style={styles.providerTitleRow}>
                        <Text style={styles.providerTitle}>
                          {provider.displayName}
                        </Text>
                        {isDefault ? (
                          <Badge
                            backgroundColor={colors.successSoft}
                            color={colors.success}
                            style={styles.defaultBadge}
                          >
                            Default
                          </Badge>
                        ) : null}
                        {hidden ? (
                          <Badge
                            backgroundColor={colors.neutralSoft}
                            color={colors.textMuted}
                            style={styles.defaultBadge}
                          >
                            Hidden
                          </Badge>
                        ) : null}
                      </View>
                      <Text style={styles.providerSummary}>
                        {provider.summary}
                      </Text>
                      <Text style={styles.providerMeta}>
                        {hidden
                          ? "Hidden from the session list and new-session shortcuts."
                          : isDefault
                            ? "Used when you tap New Session."
                            : "Available when creating sessions."}
                      </Text>
                    </View>
                    <View style={styles.providerActions}>
                      <Button
                        accessibilityLabel={`Move ${provider.displayName} up`}
                        disabled={index === 0}
                        icon="chevronUp"
                        iconOnly
                        style={styles.providerActionButton}
                        onPress={() => moveProvider(provider.kind, -1)}
                      >
                        Up
                      </Button>
                      <Button
                        accessibilityLabel={`Move ${provider.displayName} down`}
                        disabled={index === orderedProviders.length - 1}
                        icon="chevronDown"
                        iconOnly
                        style={styles.providerActionButton}
                        onPress={() => moveProvider(provider.kind, 1)}
                      >
                        Down
                      </Button>
                      <Button
                        icon={hidden ? "eye" : "eyeOff"}
                        style={styles.providerToggleButton}
                        onPress={() => toggleProviderHidden(provider.kind)}
                      >
                        {hidden ? "Show" : "Hide"}
                      </Button>
                      <Button
                        disabled={hidden || isDefault || !provider.creatable}
                        icon="check"
                        style={styles.providerDefaultButton}
                        tone={isDefault ? "primary" : "secondary"}
                        onPress={() => setDefaultProvider(provider.kind)}
                      >
                        {isDefault ? "Default" : "Set Default"}
                      </Button>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
            <View style={styles.modalActions}>
              <Button
                icon="refresh"
                style={styles.modalSecondaryButton}
                onPress={resetProviderPreferences}
              >
                Reset
              </Button>
              <Button
                icon="check"
                style={styles.modalPrimaryButton}
                tone="primary"
                onPress={() => setProvidersModalVisible(false)}
              >
                Done
              </Button>
            </View>
          </Card>
        </View>
      </Modal>
    </View>
  );

  function toggleProviderHidden(kind: RuntimeKind): void {
    setProviderPreferences((current) => {
      const hiddenKinds = current.hiddenKinds.includes(kind)
        ? current.hiddenKinds.filter((item) => item !== kind)
        : [...current.hiddenKinds, kind];
      const defaultKind =
        current.defaultKind === kind ? undefined : current.defaultKind;
      return normalizeProviderPreferences(
        {
          ...current,
          hiddenKinds,
          defaultKind,
        },
        providers,
      );
    });
  }

  function moveProvider(kind: RuntimeKind, direction: -1 | 1): void {
    setProviderPreferences((current) => {
      const orderedKinds = orderProviders(providers, current.orderedKinds).map(
        (provider) => provider.kind,
      );
      const index = orderedKinds.indexOf(kind);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= orderedKinds.length) {
        return current;
      }

      const nextOrderedKinds = [...orderedKinds];
      const [item] = nextOrderedKinds.splice(index, 1);
      nextOrderedKinds.splice(nextIndex, 0, item);
      return normalizeProviderPreferences(
        { ...current, orderedKinds: nextOrderedKinds },
        providers,
      );
    });
  }

  function setDefaultProvider(kind: RuntimeKind): void {
    setProviderPreferences((current) =>
      normalizeProviderPreferences(
        {
          ...current,
          defaultKind: kind,
        },
        providers,
      ),
    );
  }

  function resetProviderPreferences(): void {
    setProviderPreferences(EMPTY_PROVIDER_PREFERENCES);
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.xl,
  },
  toolbarTitleArea: {
    flex: 1,
    justifyContent: "center",
  },
  backButton: {
    minHeight: 40,
    width: 40,
    paddingHorizontal: 0,
    borderRadius: 20,
  },
  toolbarIconButton: {
    minHeight: 40,
    width: 44,
    paddingHorizontal: 0,
    borderRadius: radii.md,
  },
  toolbarTitle: {
    color: colors.textPrimary,
    fontSize: 22,
    fontWeight: "800",
  },
  toolbarMeta: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  secondaryButton: {
    minHeight: 38,
    minWidth: 86,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    borderColor: "#34424c",
    borderWidth: 1,
  },
  primaryText: {
    color: colors.successText,
    ...typography.action,
  },
  secondaryText: {
    color: colors.textSecondary,
    fontWeight: "700",
  },
  disabled: {
    opacity: 0.55,
  },
  list: {
    gap: spacing.xl,
    paddingBottom: 96,
  },
  runtimeSection: {
    gap: spacing.md,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  sectionTitleArea: {
    flex: 1,
    minWidth: 0,
  },
  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: "800",
  },
  sectionMeta: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: "800",
  },
  defaultBadge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  sectionDescription: {
    color: colors.textDim,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 4,
    maxWidth: 420,
  },
  sectionCreateButton: {
    minHeight: 40,
    width: 40,
    paddingHorizontal: 0,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.success,
  },
  sessionStack: {
    gap: spacing.md,
  },
  empty: {
    color: colors.textMuted,
    borderColor: colors.borderSubtle,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: 13,
  },
  sessionCard: {
    overflow: "hidden",
  },
  sessionMain: {
    padding: spacing.xl,
  },
  sessionActions: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
    paddingTop: spacing.sm,
    borderTopColor: colors.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  primarySessionButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    borderColor: colors.success,
    backgroundColor: colors.successSoft,
  },
  moreButton: {
    minHeight: 42,
    width: 46,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  recoveryActionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
  },
  recoveryButton: {
    minHeight: 36,
    minWidth: 92,
    borderRadius: radii.sm,
    backgroundColor: colors.success,
  },
  recoveryHint: {
    color: colors.textMuted,
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
  },
  closeButton: {
    flex: 1,
    minWidth: 132,
    minHeight: 38,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  killSessionButton: {
    flex: 1,
    minWidth: 112,
    minHeight: 38,
    borderColor: colors.dangerBorder,
    borderWidth: 1,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.dangerSurface,
  },
  sessionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  sessionTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: "700",
    flex: 1,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  runtimeBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: "hidden",
    color: "#d7ffe9",
    fontSize: 11,
    fontWeight: "800",
    backgroundColor: colors.successSoft,
  },
  originBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: "hidden",
    color: colors.warning,
    fontSize: 11,
    fontWeight: "800",
    backgroundColor: colors.warningSoft,
  },
  sessionMetaText: {
    color: colors.textMuted,
    flex: 1,
    fontSize: 14,
  },
  sessionMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  sessionMetaDivider: {
    color: colors.textDim,
  },
  sessionTime: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "700",
  },
  sessionSource: {
    color: colors.warning,
    fontSize: 13,
    fontWeight: "700",
    marginTop: spacing.xs,
  },
  unavailableReason: {
    color: colors.warning,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.sm,
  },
  closeText: {
    color: colors.danger,
    fontWeight: "800",
  },
  killSessionText: {
    color: colors.danger,
    fontWeight: "800",
  },
  attachHint: {
    color: colors.success,
    fontWeight: "800",
  },
  manageHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
  },
  manageDetails: {
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  detailRow: {
    gap: 3,
  },
  detailLabel: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
  },
  detailValue: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  manageActions: {
    gap: spacing.sm,
  },
  manageActionButton: {
    minHeight: 40,
  },
  floatingCreateButton: {
    position: "absolute",
    right: spacing.xl,
    bottom: spacing.xl,
    minHeight: 52,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.pill,
    shadowColor: colors.success,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.28,
    shadowRadius: 18,
  },
  modalAvoidingView: {
    flex: 1,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: "center",
    padding: 22,
    backgroundColor: "rgba(0, 0, 0, 0.58)",
  },
  modalCard: {
    padding: spacing.xl,
    gap: spacing.md,
  },
  modalTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: "800",
  },
  modalDescription: {
    color: colors.textMuted,
    fontSize: 13,
  },
  cwdInput: {
    minHeight: 48,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    color: colors.textPrimary,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.background,
  },
  modalActions: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  modalSecondaryButton: {
    flex: 1,
    minHeight: 44,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  modalPrimaryButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.success,
  },
  providerStack: {
    gap: spacing.md,
    maxHeight: 420,
  },
  providerRow: {
    borderColor: colors.borderSubtle,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.lg,
    gap: spacing.md,
  },
  providerRowHidden: {
    opacity: 0.62,
  },
  providerInfo: {
    gap: spacing.xs,
  },
  providerTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  providerTitle: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: "800",
  },
  providerMeta: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
  providerSummary: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  providerActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  providerActionButton: {
    minHeight: 38,
    width: 42,
    paddingHorizontal: 0,
  },
  providerToggleButton: {
    minHeight: 38,
    minWidth: 92,
  },
  providerDefaultButton: {
    flex: 1,
    minHeight: 38,
    minWidth: 132,
  },
});

function DetailRow({
  label,
  value,
}: {
  label: string;
  value?: string;
}): JSX.Element | null {
  if (!value) {
    return null;
  }

  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text ellipsizeMode="middle" numberOfLines={1} style={styles.detailValue}>
        {value}
      </Text>
    </View>
  );
}

function getProviderPreferencesStorageKey(scope: string): string {
  return `${PROVIDER_PREFERENCES_STORAGE_PREFIX}.${scope || "default"}`;
}

function parseProviderPreferences(value: string | null): ProviderPreferences {
  if (!value) {
    return EMPTY_PROVIDER_PREFERENCES;
  }

  try {
    const parsed = JSON.parse(value) as Partial<ProviderPreferences>;
    return {
      hiddenKinds: Array.isArray(parsed.hiddenKinds)
        ? parsed.hiddenKinds.filter(isNonEmptyString)
        : [],
      orderedKinds: Array.isArray(parsed.orderedKinds)
        ? parsed.orderedKinds.filter(isNonEmptyString)
        : [],
      defaultKind: isNonEmptyString(parsed.defaultKind)
        ? parsed.defaultKind
        : undefined,
    };
  } catch {
    return EMPTY_PROVIDER_PREFERENCES;
  }
}

function normalizeProviderPreferences(
  preferences: ProviderPreferences,
  providers: readonly AgentProviderDefinition[],
): ProviderPreferences {
  const providerKinds = new Set(providers.map((provider) => provider.kind));
  const hiddenKinds = preferences.hiddenKinds.filter((kind) =>
    providerKinds.has(kind),
  );
  const orderedKinds = preferences.orderedKinds.filter((kind) =>
    providerKinds.has(kind),
  );
  const defaultKind =
    preferences.defaultKind &&
    providerKinds.has(preferences.defaultKind) &&
    !hiddenKinds.includes(preferences.defaultKind)
      ? preferences.defaultKind
      : undefined;

  return {
    hiddenKinds,
    orderedKinds,
    defaultKind,
  };
}

function orderProviders(
  providers: readonly AgentProviderDefinition[],
  orderedKinds: readonly string[],
): AgentProviderDefinition[] {
  const priority = new Map(
    orderedKinds.map((kind, index) => [kind, index] as const),
  );

  return [...providers].sort((left, right) => {
    const leftPriority = priority.get(left.kind) ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = priority.get(right.kind) ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return providers.indexOf(left) - providers.indexOf(right);
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }

  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return "just now";
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function formatAbsoluteTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function formatCompactPath(path: string): string {
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return "";
  }

  const normalizedPath = trimmedPath.replace(/\/+$/g, "") || "/";
  const parts = normalizedPath.split("/").filter(Boolean);
  if (parts.length <= 2) {
    return normalizedPath;
  }

  const prefix = normalizedPath.startsWith("/") ? `/${parts[0]}` : parts[0];
  return `${prefix}/.../${parts[parts.length - 1]}`;
}


function getRuntimeGroupKind(
  session: CodexSession,
  providers: readonly AgentProviderDefinition[],
): RuntimeKind {
  return getAgentProviderDefinition(session.runtime_kind, providers)
    ? session.runtime_kind
    : "other";
}

function getSessionRuntimeLabel(
  session: CodexSession,
  providers: readonly AgentProviderDefinition[],
): string {
  return (
    session.runtime_label ||
    getRuntimeLabel(getRuntimeGroupKind(session, providers), providers)
  );
}

function getProviderSummary(
  runtimeKind: RuntimeKind,
  providers: readonly AgentProviderDefinition[],
): string {
  return (
    getAgentProviderDefinition(runtimeKind, providers)?.summary ??
    "Agent session."
  );
}

function getCloseActionLabel(session: CodexSession): string {
  if (
    session.status === "error" ||
    session.status === "exited" ||
    session.status === "archived"
  ) {
    return "Remove";
  }

  return "Close Session";
}

function getRecoveryHint(session: CodexSession): string {
  switch (session.status) {
    case "error":
      return "Starts the saved command in a fresh tmux session.";
    case "recovering":
      return "Checks whether the tmux target is back online.";
    case "exited":
      return "Restarts the saved command and keeps the session history.";
    default:
      return "Attempts to make this session interactive again.";
  }
}

function getStatusColors(tone: "success" | "warning" | "danger" | "neutral"): {
  backgroundColor: string;
  color: string;
} {
  switch (tone) {
    case "success":
      return {
        backgroundColor: colors.successSoft,
        color: "#d7ffe9",
      };
    case "warning":
      return {
        backgroundColor: colors.warningSoft,
        color: colors.warning,
      };
    case "danger":
      return {
        backgroundColor: colors.dangerSoft,
        color: colors.danger,
      };
    case "neutral":
    default:
      return {
        backgroundColor: colors.neutralSoft,
        color: colors.textMuted,
      };
  }
}
