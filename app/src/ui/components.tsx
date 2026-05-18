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
import { Icon, type IconName } from "./icons";

export type ButtonTone = "primary" | "secondary" | "danger";
export type ButtonVariant = "solid" | "outline" | "ghost";

export interface ButtonProps {
  accessibilityLabel?: string;
  children: ReactNode;
  disabled?: boolean;
  icon?: IconName;
  iconOnly?: boolean;
  variant?: ButtonVariant;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  tone?: ButtonTone;
  onPress(): void;
}

export function Button({
  accessibilityLabel,
  children,
  disabled,
  icon,
  iconOnly,
  variant = "outline",
  style,
  textStyle,
  tone = "secondary",
  onPress,
}: ButtonProps): JSX.Element {
  return (
    <Pressable
      accessibilityLabel={
        accessibilityLabel ?? (typeof children === "string" ? children : undefined)
      }
      accessibilityRole="button"
      disabled={disabled}
      style={[
        styles.button,
        iconOnly && styles.iconOnlyButton,
        variant === "ghost" && styles.ghostButton,
        tone === "primary" && variant !== "ghost" && styles.primaryButton,
        tone === "danger" && variant !== "ghost" && styles.dangerButton,
        disabled && styles.disabled,
        style,
      ]}
      onPress={onPress}
    >
      {icon ? (
        <Icon
          name={icon}
          size={iconOnly ? 21 : 18}
          color={getButtonIconColor(tone, variant)}
        />
      ) : null}
      {!iconOnly ? (
        <Text
          style={[
            styles.buttonText,
            tone === "primary" &&
              variant !== "ghost" &&
              styles.primaryButtonText,
            tone === "danger" &&
              variant !== "ghost" &&
              styles.dangerButtonText,
            textStyle,
          ]}
        >
          {children}
        </Text>
      ) : null}
    </Pressable>
  );
}

function getButtonIconColor(tone: ButtonTone, variant: ButtonVariant): string {
  if (tone === "primary" && variant !== "ghost") {
    return colors.successText;
  }
  if (tone === "danger") {
    return colors.danger;
  }
  return colors.textSecondary;
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
    flexDirection: "row",
    gap: spacing.sm,
    borderColor: colors.border,
    borderWidth: 1,
  },
  iconOnlyButton: {
    width: 42,
    paddingHorizontal: 0,
  },
  ghostButton: {
    borderColor: "transparent",
    backgroundColor: "transparent",
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
