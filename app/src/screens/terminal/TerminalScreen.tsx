import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dimensions,
  Keyboard,
  type KeyboardEvent,
  type LayoutChangeEvent,
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
  CodexSession,
  TerminalInputPayload,
  TerminalResizePayload,
} from "../../../../packages/protocol-ts/src/index.ts";
import {
  createControlInput,
  createTextInput,
  sanitizeTerminalText,
  type TerminalControlKey,
} from "../../../../packages/terminal-core/src/index.ts";
import {
  computeTerminalLayout,
  getDefaultTerminalDisplayProfile,
  type TerminalDisplayProfile,
  type TerminalViewport,
} from "../../features/terminal/terminalLayout";
import { NativeTerminalView } from "../../terminal/NativeTerminalView";
import { colors, radii, spacing } from "../../ui/theme";

export interface TerminalScreenProps {
  session: CodexSession;
  frame: string;
  canInput?: boolean;
  canKillTmux?: boolean;
  canResize?: boolean;
  connectionStatus?: TerminalConnectionStatus;
  readOnlyReason?: string;
  statusLabel?: string;
  onBack(): void;
  onKillTmux(): void;
  onRefreshSessions(): void;
  onInput(input: TerminalInputPayload): void;
  onResize(size: TerminalResizePayload): void;
}

type TerminalConnectionStatus =
  | "idle"
  | "connecting"
  | "authenticating"
  | "authenticated"
  | "failed";

type QuickKeyItem = { label: string; key: TerminalControlKey };

const ALWAYS_VISIBLE_QUICK_KEYS: QuickKeyItem[] = [
  { label: "Esc", key: "escape" },
  { label: "Tab", key: "tab" },
  { label: "Ctrl+C", key: "ctrlC" },
  { label: "Enter", key: "enter" },
  { label: "⌫", key: "backspace" },
  { label: "←", key: "arrowLeft" },
  { label: "→", key: "arrowRight" },
  { label: "↑", key: "arrowUp" },
  { label: "↓", key: "arrowDown" },
];

const OVERFLOW_QUICK_KEYS: QuickKeyItem[] = [
  { label: "Ctrl+D", key: "ctrlD" },
  { label: "Ctrl+L", key: "ctrlL" },
];

const FULL_QUICK_KEYS: QuickKeyItem[] = [
  { label: "Esc", key: "escape" },
  { label: "Tab", key: "tab" },
  { label: "Ctrl+C", key: "ctrlC" },
  { label: "Ctrl+D", key: "ctrlD" },
  { label: "Ctrl+L", key: "ctrlL" },
  { label: "Enter", key: "enter" },
  { label: "⌫", key: "backspace" },
  { label: "←", key: "arrowLeft" },
  { label: "→", key: "arrowRight" },
  { label: "↑", key: "arrowUp" },
  { label: "↓", key: "arrowDown" },
];

const BOTTOM_DOCK_BOTTOM_MARGIN = 12;
const INITIAL_BOTTOM_DOCK_HEIGHT = 156;
const ESTIMATED_FULL_QUICK_KEYS_WIDTH = 760;
const TERMINAL_PROFILE_STORAGE_KEY = "omniwork.terminal.displayProfile";
const PROFILE_OPTIONS: Array<{ key: TerminalDisplayProfile; label: string }> = [
  { key: "readableScroll", label: "Readable" },
  { key: "fitPreview", label: "Fit" },
  { key: "landscapeWide", label: "Wide" },
];

function getKeyboardBottomInset(event: KeyboardEvent): number {
  const keyboardHeight = event.endCoordinates.height;
  if (keyboardHeight > 0) {
    return keyboardHeight;
  }

  return Math.max(
    0,
    Dimensions.get("window").height - event.endCoordinates.screenY,
  );
}

export function TerminalScreen({
  session,
  frame,
  canInput = true,
  canKillTmux = true,
  canResize = true,
  connectionStatus = "idle",
  readOnlyReason,
  statusLabel,
  onBack,
  onKillTmux,
  onRefreshSessions,
  onInput,
  onResize,
}: TerminalScreenProps): JSX.Element {
  const [draft, setDraft] = useState("");
  const [bottomDockHeight, setBottomDockHeight] = useState(
    INITIAL_BOTTOM_DOCK_HEIGHT,
  );
  const [advancedKeysVisible, setAdvancedKeysVisible] = useState(false);
  const [quickKeysWidth, setQuickKeysWidth] = useState(
    Dimensions.get("window").width,
  );
  const [keyboardBottomInset, setKeyboardBottomInset] = useState(0);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [terminalViewport, setTerminalViewport] = useState<TerminalViewport>({
    width: Dimensions.get("window").width,
    height: Math.max(260, Dimensions.get("window").height - 260),
  });
  const [profile, setProfile] = useState<TerminalDisplayProfile>(() =>
    getDefaultTerminalDisplayProfile(Dimensions.get("window")),
  );
  const profileLoadedRef = useRef(false);
  const lastResizeKeyRef = useRef("");
  const agentStatus = getAgentStatusPresentation(connectionStatus);
  const runtimeLabel = session.runtime_label || session.runtime_kind;
  const hasDraft = draft.trim().length > 0;
  const canHideKeyboard = keyboardVisible && !hasDraft;
  const readOnly = !canInput;
  const canShowAllQuickKeys = quickKeysWidth >= ESTIMATED_FULL_QUICK_KEYS_WIDTH;
  const quickKeys = canShowAllQuickKeys
    ? FULL_QUICK_KEYS
    : advancedKeysVisible
      ? [...ALWAYS_VISIBLE_QUICK_KEYS, ...OVERFLOW_QUICK_KEYS]
      : ALWAYS_VISIBLE_QUICK_KEYS;
  const terminalLayout = useMemo(
    () => computeTerminalLayout(terminalViewport, profile),
    [profile, terminalViewport],
  );

  useEffect(() => {
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSubscription = Keyboard.addListener(showEvent, (event) => {
      const inset = getKeyboardBottomInset(event);
      setKeyboardBottomInset(inset);
      setKeyboardVisible(inset > 0);
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      setKeyboardBottomInset(0);
      setKeyboardVisible(false);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(TERMINAL_PROFILE_STORAGE_KEY)
      .then((value) => {
        if (isTerminalDisplayProfile(value)) {
          setProfile(value);
        }
      })
      .finally(() => {
        profileLoadedRef.current = true;
      });
  }, []);

  useEffect(() => {
    if (!profileLoadedRef.current) {
      return;
    }

    AsyncStorage.setItem(TERMINAL_PROFILE_STORAGE_KEY, profile).catch(() => {
      // Display preferences are best-effort and should not block terminal use.
    });
  }, [profile]);

  useEffect(() => {
    const subscription = Dimensions.addEventListener("change", ({ window }) => {
      setProfile((currentProfile) => {
        if (currentProfile === "fitPreview") {
          return currentProfile;
        }
        return getDefaultTerminalDisplayProfile(window);
      });
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const size = terminalLayout.terminalSize;
    const resizeKey = `${session.session_id}:${size.cols}x${size.rows}`;
    if (lastResizeKeyRef.current === resizeKey) {
      return undefined;
    }

    const timer = setTimeout(() => {
      lastResizeKeyRef.current = resizeKey;
      if (canResize) {
        onResize(size);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [canResize, onResize, session.session_id, terminalLayout.terminalSize]);

  function sendDraft(): void {
    if (readOnly) {
      return;
    }
    const normalizedDraft = sanitizeTerminalText(draft.trimEnd());
    if (!normalizedDraft) {
      return;
    }
    onInput(createTextInput(`${normalizedDraft}\r`));
    setDraft("");
  }

  function handlePrimaryComposerAction(): void {
    if (hasDraft) {
      sendDraft();
      return;
    }

    if (canHideKeyboard) {
      Keyboard.dismiss();
    }
  }

  function handleTerminalAreaLayout(event: LayoutChangeEvent): void {
    const { width, height } = event.nativeEvent.layout;
    setTerminalViewport({
      width: Math.max(1, width),
      height: Math.max(1, height),
    });
  }

  function handleBottomDockLayout(event: LayoutChangeEvent): void {
    const nextHeight = Math.ceil(event.nativeEvent.layout.height);
    setBottomDockHeight((currentHeight) =>
      Math.abs(currentHeight - nextHeight) > 1 ? nextHeight : currentHeight,
    );
  }

  function handleQuickKeysLayout(event: LayoutChangeEvent): void {
    setQuickKeysWidth(event.nativeEvent.layout.width);
    if (event.nativeEvent.layout.width >= ESTIMATED_FULL_QUICK_KEYS_WIDTH) {
      setAdvancedKeysVisible(false);
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <Pressable style={styles.backButton} onPress={onBack}>
          <Text style={styles.backText}>Sessions</Text>
        </Pressable>
        <Pressable
          accessibilityLabel={statusLabel ?? agentStatus.accessibilityLabel}
          style={styles.sessionMetaArea}
          onPress={Keyboard.dismiss}
        >
          <Text numberOfLines={1} style={styles.sessionTitle}>
            {session.title}
          </Text>
          <Text numberOfLines={1} style={styles.meta}>
            {runtimeLabel} · {formatCompactPath(session.cwd)}
          </Text>
          <Text style={[styles.statusIcon, { color: agentStatus.color }]}>
            {agentStatus.icon}
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Kill tmux session"
          disabled={!canKillTmux}
          style={[styles.killButton, !canKillTmux && styles.disabled]}
          onPress={onKillTmux}
        >
          <Text style={styles.killText}>×</Text>
        </Pressable>
      </View>

      <View
        style={[
          styles.terminalArea,
          {
            marginBottom:
              bottomDockHeight +
              keyboardBottomInset +
              BOTTOM_DOCK_BOTTOM_MARGIN,
          },
        ]}
        onLayout={handleTerminalAreaLayout}
        onStartShouldSetResponderCapture={() => {
          Keyboard.dismiss();
          return false;
        }}
      >
        <NativeTerminalView
          frame={frame}
          layout={terminalLayout}
          terminalSize={terminalLayout.terminalSize}
        />
      </View>

      <View
        style={[
          styles.bottomDock,
          {
            bottom:
              keyboardBottomInset > 0
                ? keyboardBottomInset
                : BOTTOM_DOCK_BOTTOM_MARGIN,
          },
        ]}
        onLayout={handleBottomDockLayout}
      >
        {readOnly && readOnlyReason ? (
          <View style={styles.readOnlyBanner}>
            <Text style={styles.readOnlyTitle}>Session is read-only</Text>
            <Text style={styles.readOnlyText}>{readOnlyReason}</Text>
            <Pressable
              style={styles.readOnlyAction}
              onPress={onRefreshSessions}
            >
              <Text style={styles.readOnlyActionText}>Refresh Sessions</Text>
            </Pressable>
          </View>
        ) : null}
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          style={styles.quickKeys}
          contentContainerStyle={styles.quickKeysContent}
          onLayout={handleQuickKeysLayout}
        >
          {quickKeys.map((item) => (
            <Pressable
              key={item.key}
              disabled={readOnly}
              style={[styles.keyButton, readOnly && styles.disabled]}
              onPress={() => onInput(createControlInput(item.key))}
            >
              <Text style={styles.keyButtonText}>{item.label}</Text>
            </Pressable>
          ))}
          <Pressable
            disabled={!draft}
            style={[styles.keyButton, !draft && styles.disabled]}
            onPress={() => setDraft("")}
          >
            <Text style={styles.keyButtonText}>Clear</Text>
          </Pressable>
          {!canShowAllQuickKeys ? (
            <Pressable
              style={styles.keyButton}
              onPress={() => setAdvancedKeysVisible((visible) => !visible)}
            >
              <Text style={styles.keyButtonText}>
                {advancedKeysVisible ? "Less" : "More"}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>

        <View style={styles.profileRow}>
          {PROFILE_OPTIONS.map((item) => {
            const selected = profile === item.key;
            return (
              <Pressable
                key={item.key}
                style={[
                  styles.profileButton,
                  selected && styles.profileSelected,
                ]}
                onPress={() => setProfile(item.key)}
              >
                <Text
                  style={[
                    styles.profileButtonText,
                    selected && styles.profileSelectedText,
                  ]}
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
          <Text style={styles.gridMeta}>
            {terminalLayout.terminalSize.cols}x
            {terminalLayout.terminalSize.rows}
            {" · "}
            {Math.round(terminalLayout.fontSize * 10) / 10}
            {Platform.OS === "ios" ? "pt" : "sp"}
          </Text>
        </View>

        {terminalLayout.fitLimited ? (
          <Text style={styles.fitNotice}>
            Fit would make text too small; horizontal scrolling keeps it
            readable.
          </Text>
        ) : null}

        <View style={styles.composer}>
          <View style={styles.inputRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              placeholder={`Ask ${runtimeLabel} to inspect, edit, test, or explain...`}
              placeholderTextColor="#66727c"
              editable={!readOnly}
              returnKeyType="default"
              scrollEnabled
              submitBehavior="newline"
              style={styles.input}
            />
            <Pressable
              disabled={readOnly || (!hasDraft && !canHideKeyboard)}
              style={[
                styles.sendButton,
                canHideKeyboard && styles.sendButtonSecondary,
                (readOnly || (!hasDraft && !canHideKeyboard)) &&
                  styles.disabled,
              ]}
              onPress={handlePrimaryComposerAction}
            >
              <Text
                style={[
                  styles.sendText,
                  canHideKeyboard && styles.sendTextSecondary,
                ]}
              >
                {canHideKeyboard ? "Hide" : "Send"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
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
  return `${prefix}/…/${parts[parts.length - 1]}`;
}

function getAgentStatusPresentation(status: TerminalConnectionStatus): {
  accessibilityLabel: string;
  color: string;
  icon: string;
} {
  switch (status) {
    case "authenticated":
      return {
        accessibilityLabel: "Agent connected",
        color: colors.success,
        icon: "●",
      };
    case "connecting":
    case "authenticating":
      return {
        accessibilityLabel: "Agent connecting",
        color: colors.warning,
        icon: "◐",
      };
    case "failed":
      return {
        accessibilityLabel: "Agent disconnected",
        color: colors.danger,
        icon: "×",
      };
    case "idle":
    default:
      return {
        accessibilityLabel: "Agent idle",
        color: colors.textDim,
        icon: "○",
      };
  }
}

function isTerminalDisplayProfile(
  value: string | null,
): value is TerminalDisplayProfile {
  return (
    value === "readableScroll" ||
    value === "fitPreview" ||
    value === "landscapeWide"
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    gap: spacing.md,
  },
  terminalArea: {
    flex: 1,
  },
  bottomDock: {
    position: "absolute",
    left: 12,
    right: 12,
    gap: spacing.xs,
    paddingTop: spacing.xs,
    backgroundColor: colors.background,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  sessionMetaArea: {
    flex: 1,
    minWidth: 0,
    paddingRight: 32,
  },
  backButton: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    minHeight: 38,
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  backText: {
    color: colors.textSecondary,
    fontWeight: "700",
  },
  sessionTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: "800",
  },
  meta: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  statusIcon: {
    position: "absolute",
    right: 0,
    top: 8,
    fontSize: 18,
    fontWeight: "800",
    minWidth: 24,
    textAlign: "right",
  },
  killButton: {
    width: 38,
    minHeight: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    borderColor: colors.dangerBorder,
    borderWidth: 1,
    backgroundColor: colors.dangerSurface,
  },
  killText: {
    color: colors.danger,
    fontSize: 22,
    fontWeight: "800",
    lineHeight: 24,
  },
  quickKeys: {
    flexGrow: 0,
  },
  readOnlyBanner: {
    gap: spacing.xs,
    borderColor: colors.warning,
    borderWidth: 1,
    borderRadius: radii.sm,
    padding: spacing.md,
    backgroundColor: colors.warningSoft,
  },
  readOnlyTitle: {
    color: colors.warning,
    fontSize: 12,
    fontWeight: "800",
  },
  readOnlyText: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  readOnlyAction: {
    alignSelf: "flex-start",
    borderColor: colors.warning,
    borderWidth: 1,
    borderRadius: radii.sm,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
  },
  readOnlyActionText: {
    color: colors.warning,
    fontSize: 12,
    fontWeight: "800",
  },
  quickKeysContent: {
    gap: spacing.sm,
    paddingRight: spacing.xs,
  },
  keyButton: {
    minWidth: 52,
    minHeight: 36,
    borderRadius: radii.sm,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  keyButtonText: {
    color: colors.textSecondary,
    fontWeight: "700",
  },
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  profileButton: {
    minHeight: 30,
    borderRadius: radii.sm,
    borderColor: colors.border,
    borderWidth: 1,
    justifyContent: "center",
    paddingHorizontal: 10,
    backgroundColor: colors.surface,
  },
  profileSelected: {
    borderColor: colors.success,
    backgroundColor: "#1a3028",
  },
  profileButtonText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "800",
  },
  profileSelectedText: {
    color: "#d7ffe9",
  },
  gridMeta: {
    color: colors.textDim,
    flex: 1,
    fontSize: 12,
    textAlign: "right",
  },
  fitNotice: {
    color: colors.warning,
    fontSize: 12,
  },
  composer: {},
  inputRow: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "flex-end",
  },
  input: {
    flex: 1,
    minHeight: 48,
    maxHeight: 112,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    color: colors.textPrimary,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
    backgroundColor: colors.surface,
    textAlignVertical: "top",
  },
  sendButton: {
    minHeight: 44,
    borderRadius: radii.sm,
    backgroundColor: colors.success,
    paddingHorizontal: spacing.xl,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonSecondary: {
    backgroundColor: "#1d272d",
    borderColor: colors.border,
    borderWidth: 1,
  },
  disabled: {
    opacity: 0.45,
  },
  sendText: {
    color: colors.successText,
    fontWeight: "800",
  },
  sendTextSecondary: {
    color: colors.textSecondary,
  },
});
