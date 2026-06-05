import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";

import type { TransportPreference } from "@omniwork/protocol-ts";
import { Button } from "../../ui/components";
import { colors, radii, spacing, typography } from "../../ui/theme";

export interface ConnectionPreferenceScreenProps {
  /**
   * 当前生效的传输偏好；展示在三态选项的选中态。由 App.tsx 从 AsyncStorage 加载。
   * 详见 docs/relay-architecture.md "传输偏好可控"小节。
   */
  transportPreference: TransportPreference;
  onChangeTransportPreference(preference: TransportPreference): void;
  onBack?: () => void;
}

export type ConnectionPreferenceContentProps = Pick<
  ConnectionPreferenceScreenProps,
  "transportPreference" | "onChangeTransportPreference"
>;

const TRANSPORT_PREFERENCE_VALUES: ReadonlyArray<TransportPreference> = [
  "auto",
  "prefer_p2p",
  "relay_only",
];

export function ConnectionPreferenceScreen({
  transportPreference,
  onChangeTransportPreference,
  onBack,
}: ConnectionPreferenceScreenProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.header}>
        {onBack ? (
          <Button
            accessibilityLabel={t("common.back")}
            icon="arrowLeft"
            iconOnly
            style={styles.backButton}
            onPress={onBack}
          >
            {t("common.back")}
          </Button>
        ) : null}
        <View style={styles.headerText}>
          <Text style={styles.headerEyebrow}>{t("settings.eyebrow")}</Text>
          <Text style={styles.headerTitle}>
            {t("connectionPreference.title")}
          </Text>
        </View>
      </View>

      <ConnectionPreferenceContent
        transportPreference={transportPreference}
        onChangeTransportPreference={onChangeTransportPreference}
      />
    </ScrollView>
  );
}

export function ConnectionPreferenceContent({
  transportPreference,
  onChangeTransportPreference,
}: ConnectionPreferenceContentProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <Text style={styles.sectionHint}>
        {t("connectionPreference.description")}
      </Text>

      <View style={styles.optionList}>
        {TRANSPORT_PREFERENCE_VALUES.map((value) => {
          const selected = value === transportPreference;
          const label = t(`connectionPreference.options.${value}.label`);
          const hint = t(`connectionPreference.options.${value}.hint`);
          return (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`${label}: ${hint}`}
              style={({ pressed }) => [
                styles.optionRow,
                selected && styles.optionRowActive,
                pressed && styles.optionRowPressed,
              ]}
              onPress={() => {
                if (!selected) onChangeTransportPreference(value);
              }}
            >
              <View style={styles.optionText}>
                <Text
                  style={[
                    styles.optionLabel,
                    selected && styles.optionLabelActive,
                  ]}
                >
                  {label}
                </Text>
                <Text style={styles.optionHint}>{hint}</Text>
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
    </>
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
