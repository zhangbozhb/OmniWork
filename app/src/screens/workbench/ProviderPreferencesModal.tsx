import type { JSX } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";

import type {
  TerminalProviderDefinition,
  TerminalProviderKind,
} from "@omniwork/protocol-ts";

import { Badge, Button, Card } from "../../ui/components";
import { colors } from "../../ui/theme";
import type { ProviderPreferences } from "./providerPreferences";
import { styles } from "./styles";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function ProviderPreferencesModal({
  visible,
  orderedProviders,
  providerPreferences,
  effectiveDefaultProviderKind,
  modalMaxHeight,
  listMaxHeight,
  t,
  onClose,
  onReset,
  onToggleProviderHidden,
  onMoveProvider,
  onSetDefaultProvider,
}: {
  visible: boolean;
  orderedProviders: readonly TerminalProviderDefinition[];
  providerPreferences: ProviderPreferences;
  effectiveDefaultProviderKind: TerminalProviderKind;
  modalMaxHeight: number;
  listMaxHeight: number;
  t: Translate;
  onClose(): void;
  onReset(): void;
  onToggleProviderHidden(kind: TerminalProviderKind): void;
  onMoveProvider(kind: TerminalProviderKind, direction: -1 | 1): void;
  onSetDefaultProvider(kind: TerminalProviderKind): void;
}): JSX.Element {
  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.modalBackdrop}>
        <Pressable style={styles.modalDismissLayer} onPress={onClose} />
        <Card style={[styles.modalCard, { maxHeight: modalMaxHeight }]}>
          <Text style={styles.modalTitle}>
            {t("workspaces.modal.providerPreferences")}
          </Text>
          <ScrollView
            contentContainerStyle={styles.providerStack}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
            style={[styles.providerPreferencesList, { maxHeight: listMaxHeight }]}
          >
            {orderedProviders.map((provider, index) => {
              const hidden = providerPreferences.hiddenKinds.includes(
                provider.kind,
              );
              const isDefault =
                provider.kind === effectiveDefaultProviderKind;
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
                          {t("common.default")}
                        </Badge>
                      ) : null}
                      {hidden ? (
                        <Badge
                          backgroundColor={colors.neutralSoft}
                          color={colors.textMuted}
                          style={styles.defaultBadge}
                        >
                          {t("common.hidden")}
                        </Badge>
                      ) : null}
                    </View>
                    <Text numberOfLines={1} style={styles.providerSummary}>
                      {provider.summary}
                    </Text>
                  </View>
                  <View style={styles.providerActions}>
                    <Button
                      accessibilityLabel={t("workspaces.actions.moveUp", {
                        provider: provider.displayName,
                      })}
                      disabled={index === 0}
                      icon="chevronUp"
                      iconOnly
                      style={styles.providerActionButton}
                      onPress={() => onMoveProvider(provider.kind, -1)}
                    >
                      {t("common.up")}
                    </Button>
                    <Button
                      accessibilityLabel={t("workspaces.actions.moveDown", {
                        provider: provider.displayName,
                      })}
                      disabled={index === orderedProviders.length - 1}
                      icon="chevronDown"
                      iconOnly
                      style={styles.providerActionButton}
                      onPress={() => onMoveProvider(provider.kind, 1)}
                    >
                      {t("common.down")}
                    </Button>
                    <Button
                      icon={hidden ? "eye" : "eyeOff"}
                      iconOnly
                      style={styles.providerActionButton}
                      onPress={() => onToggleProviderHidden(provider.kind)}
                    >
                      {hidden ? t("common.show") : t("common.hide")}
                    </Button>
                    <Button
                      disabled={hidden || isDefault || !provider.creatable}
                      icon="check"
                      iconOnly
                      style={[
                        styles.providerActionButton,
                        isDefault && styles.providerDefaultActive,
                      ]}
                      tone={isDefault ? "primary" : "secondary"}
                      onPress={() => onSetDefaultProvider(provider.kind)}
                    >
                      {t("common.default")}
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
              onPress={onReset}
            >
              {t("common.reset")}
            </Button>
            <Button
              icon="check"
              style={styles.modalPrimaryButton}
              tone="primary"
              onPress={onClose}
            >
              {t("common.done")}
            </Button>
          </View>
        </Card>
      </View>
    </Modal>
  );
}
