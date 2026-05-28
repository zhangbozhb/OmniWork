import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { TransportPreference } from "../../../../packages/protocol-ts/src/index.ts";
import { Button } from "../../ui/components";
import { colors, radii, spacing, typography } from "../../ui/theme";

export interface ConnectionPreferenceScreenProps {
  /**
   * 当前生效的传输偏好；展示在三态选项的选中态。由 App.tsx 从 AsyncStorage 加载。
   * 详见 docs/relay-architecture.md "传输偏好可控"小节。
   */
  transportPreference: TransportPreference;
  onChangeTransportPreference(preference: TransportPreference): void;
  onBack(): void;
}

const TRANSPORT_PREFERENCE_OPTIONS: ReadonlyArray<{
  value: TransportPreference;
  label: string;
  hint: string;
}> = [
  {
    value: "auto",
    label: "Auto",
    hint: "Follow Relay rollout (default)",
  },
  {
    value: "prefer_p2p",
    label: "Strict P2P",
    hint: "Require WebRTC; session unavailable if it cannot be established",
  },
  {
    value: "relay_only",
    label: "Relay Only",
    hint: "Disable WebRTC upgrade",
  },
];

export function ConnectionPreferenceScreen({
  transportPreference,
  onChangeTransportPreference,
  onBack,
}: ConnectionPreferenceScreenProps): JSX.Element {
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.header}>
        <Button
          accessibilityLabel="Back"
          icon="arrowLeft"
          iconOnly
          style={styles.backButton}
          onPress={onBack}
        >
          Back
        </Button>
        <View style={styles.headerText}>
          <Text style={styles.headerEyebrow}>Settings</Text>
          <Text style={styles.headerTitle}>Connection preference</Text>
        </View>
      </View>

      <Text style={styles.sectionHint}>
        Choose how the App connects to the Mac Agent. The selection is saved on
        this device and triggers an immediate reconnect; if you pick Strict P2P
        and a direct WebRTC link cannot be established, the session will fail
        instead of falling back to Relay.
      </Text>

      <View style={styles.optionList}>
        {TRANSPORT_PREFERENCE_OPTIONS.map((option) => {
          const selected = option.value === transportPreference;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`${option.label}: ${option.hint}`}
              style={({ pressed }) => [
                styles.optionRow,
                selected && styles.optionRowActive,
                pressed && styles.optionRowPressed,
              ]}
              onPress={() => {
                if (!selected) onChangeTransportPreference(option.value);
              }}
            >
              <View style={styles.optionText}>
                <Text
                  style={[
                    styles.optionLabel,
                    selected && styles.optionLabelActive,
                  ]}
                >
                  {option.label}
                </Text>
                <Text style={styles.optionHint}>{option.hint}</Text>
              </View>
              <View
                style={[styles.radio, selected && styles.radioActive]}
                pointerEvents="none"
              >
                {selected ? <View style={styles.radioDot} /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    padding: spacing.xxl,
    gap: spacing.lg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  backButton: {
    minHeight: 36,
    width: 36,
    paddingHorizontal: 0,
    borderRadius: radii.pill,
  },
  headerText: {
    flex: 1,
  },
  headerEyebrow: {
    color: colors.textDim,
    ...typography.eyebrow,
  },
  headerTitle: {
    color: colors.textPrimary,
    ...typography.title,
    marginTop: spacing.xs,
  },
  sectionHint: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  optionList: {
    gap: spacing.sm,
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface,
  },
  optionRowActive: {
    borderColor: colors.success,
  },
  optionRowPressed: {
    opacity: 0.85,
  },
  optionText: {
    flex: 1,
    gap: 4,
  },
  optionLabel: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: "700",
  },
  optionLabelActive: {
    color: colors.success,
  },
  optionHint: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 16,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.borderSubtle,
    alignItems: "center",
    justifyContent: "center",
  },
  radioActive: {
    borderColor: colors.success,
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.success,
  },
});
