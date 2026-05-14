import type { JSX, ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";

import { colors, radii, spacing, typography } from "./theme";

export type ButtonTone = "primary" | "secondary" | "danger";

export interface ButtonProps {
  accessibilityLabel?: string;
  children: ReactNode;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  tone?: ButtonTone;
  onPress(): void;
}

export function Button({
  accessibilityLabel,
  children,
  disabled,
  style,
  textStyle,
  tone = "secondary",
  onPress,
}: ButtonProps): JSX.Element {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      style={[
        styles.button,
        tone === "primary" && styles.primaryButton,
        tone === "danger" && styles.dangerButton,
        disabled && styles.disabled,
        style,
      ]}
      onPress={onPress}
    >
      <Text
        style={[
          styles.buttonText,
          tone === "primary" && styles.primaryButtonText,
          tone === "danger" && styles.dangerButtonText,
          textStyle,
        ]}
      >
        {children}
      </Text>
    </Pressable>
  );
}

export interface CardProps {
  children: ReactNode;
  elevated?: boolean;
  success?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Card({
  children,
  elevated,
  success,
  style,
}: CardProps): JSX.Element {
  return (
    <View
      style={[
        styles.card,
        elevated && styles.elevatedCard,
        success && styles.successCard,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export interface BadgeProps {
  children: ReactNode;
  backgroundColor?: string;
  color?: string;
  style?: StyleProp<ViewStyle>;
}

export function Badge({
  children,
  backgroundColor = colors.neutralSoft,
  color = colors.textMuted,
  style,
}: BadgeProps): JSX.Element {
  return (
    <View style={[styles.badge, { backgroundColor }, style]}>
      <Text style={[styles.badgeText, { color }]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 42,
    paddingHorizontal: 14,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    borderColor: colors.border,
    borderWidth: 1,
  },
  primaryButton: {
    borderColor: colors.success,
    backgroundColor: colors.success,
  },
  dangerButton: {
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSurface,
  },
  buttonText: {
    color: colors.textSecondary,
    fontWeight: "700",
  },
  primaryButtonText: {
    color: colors.successText,
    ...typography.action,
  },
  dangerButtonText: {
    color: colors.danger,
    fontWeight: "800",
  },
  card: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  elevatedCard: {
    borderColor: colors.borderSubtle,
    borderRadius: 14,
    backgroundColor: colors.surfaceRaised,
  },
  successCard: {
    borderColor: "rgba(48, 196, 141, 0.38)",
    borderRadius: radii.lg,
    backgroundColor: colors.surfaceSuccess,
  },
  badge: {
    alignSelf: "flex-start",
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: "800",
  },
  disabled: {
    opacity: 0.55,
  },
});
