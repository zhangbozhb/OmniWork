export const colors = {
  background: "#101417",
  surface: "#151c21",
  surfaceRaised: "#11181d",
  surfaceSuccess: "#12231d",
  border: "#34424c",
  borderSubtle: "#263037",
  textPrimary: "#f5f7f8",
  textSecondary: "#d7dde2",
  textMuted: "#94a3ad",
  textDim: "#66727c",
  success: "#30c48d",
  successText: "#08110d",
  successSoft: "rgba(48, 196, 141, 0.16)",
  warning: "#f4c95d",
  warningSoft: "rgba(244, 201, 93, 0.18)",
  danger: "#ff8d8d",
  dangerSurface: "#2a1517",
  dangerBorder: "#5b3030",
  dangerSoft: "rgba(255, 141, 141, 0.16)",
  neutralSoft: "rgba(148, 163, 173, 0.16)",
} as const;

export const radii = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 10,
  lg: 12,
  xl: 16,
  xxl: 18,
} as const;

export const typography = {
  eyebrow: {
    fontSize: 12,
    fontWeight: "800" as const,
    letterSpacing: 0.6,
    textTransform: "uppercase" as const,
  },
  title: {
    fontSize: 20,
    fontWeight: "800" as const,
  },
  label: {
    fontSize: 13,
    fontWeight: "600" as const,
  },
  action: {
    fontWeight: "800" as const,
  },
} as const;
