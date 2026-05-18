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
import { Button } from "../../ui/components";
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
  const [focusMode, setFocusMode] = useState(false);
  const [toolbarHidden, setToolbarHidden] = useState(false);
  const [displayControlsVisible, setDisplayControlsVisible] = useState(false);
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
  const floatingControlsBottom =
    bottomDockHeight +
    keyboardBottomInset +
    BOTTOM_DOCK_BOTTOM_MARGIN +
    spacing.md;

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
      {!focusMode && !toolbarHidden ? (
        <View style={styles.toolbar}>
          <Button
            accessibilityLabel="Back to sessions"
            icon="arrowLeft"
            iconOnly
            style={styles.backButton}
            onPress={onBack}
          >
            Sessions
          </Button>
          <Pressable
            accessibilityLabel={statusLabel ?? agentStatus.accessibilityLabel}
            style={styles.sessionMetaArea}
            onPress={Keyboard.dismiss}
          >
            <Text
              numberOfLines={1}
              style={[styles.sessionTitle, { color: agentStatus.color }]}
            >
              {session.title}
            </Text>
          </Pressable>
          <Button
            accessibilityLabel="Kill tmux session"
            disabled={!canKillTmux}
            icon="trash"
            iconOnly
            style={[styles.killButton, !canKillTmux && styles.disabled]}
            onPress={onKillTmux}
          >
            Kill
          </Button>
        </View>
      ) : null}

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
        {!focusMode && readOnly && readOnlyReason ? (
          <View style={styles.readOnlyBanner}>
            <Text style={styles.readOnlyTitle}>Session is read-only</Text>
            <Text style={styles.readOnlyText}>{readOnlyReason}</Text>
            <Button
              icon="refresh"
              style={styles.readOnlyAction}
              onPress={onRefreshSessions}
            >
              Refresh Sessions
            </Button>
          </View>
        ) : null}
        {!focusMode ? (
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
                accessibilityLabel={`Send ${item.label} key`}
                accessibilityRole="button"
                key={item.key}
                disabled={readOnly}
                style={[styles.keyButton, readOnly && styles.disabled]}
                onPress={() => onInput(createControlInput(item.key))}
              >
                <Text style={styles.keyButtonText}>{item.label}</Text>
              </Pressable>
            ))}
            <Button
              disabled={!draft}
              icon="close"
              iconOnly
              style={[styles.keyButton, !draft && styles.disabled]}
              onPress={() => setDraft("")}
            >
              Clear
            </Button>
            {!canShowAllQuickKeys ? (
              <Button
                icon={advancedKeysVisible ? "chevronUp" : "more"}
                iconOnly
                style={styles.keyButton}
                onPress={() => setAdvancedKeysVisible((visible) => !visible)}
              >
                {advancedKeysVisible ? "Less" : "More"}
              </Button>
            ) : null}
          </ScrollView>
        ) : null}

        {!focusMode && displayControlsVisible ? (
          <View style={styles.displayPanel}>
            <View style={styles.displayPanelHeader}>
              <Text style={styles.displayPanelTitle}>Display</Text>
              <Text style={styles.gridMeta}>
                {terminalLayout.terminalSize.cols}x
                {terminalLayout.terminalSize.rows}
                {" · "}
                {Math.round(terminalLayout.fontSize * 10) / 10}
                {Platform.OS === "ios" ? "pt" : "sp"}
              </Text>
            </View>
            <View style={styles.profileRow}>
              {PROFILE_OPTIONS.map((item) => {
                const selected = profile === item.key;
                return (
                  <Pressable
                    accessibilityLabel={`Use ${item.label} terminal profile`}
                    accessibilityRole="button"
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
              {terminalLayout.fitLimited ? (
                <Text numberOfLines={1} style={styles.fitPill}>
                  Fit limited
                </Text>
              ) : null}
            </View>
          </View>
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
            <Button
              disabled={readOnly || (!hasDraft && !canHideKeyboard)}
              icon={canHideKeyboard ? "keyboard" : "send"}
              style={[
                styles.sendButton,
                canHideKeyboard && styles.sendButtonSecondary,
                (readOnly || (!hasDraft && !canHideKeyboard)) &&
                  styles.disabled,
              ]}
              onPress={handlePrimaryComposerAction}
            >
              {canHideKeyboard ? "Hide" : "Send"}
            </Button>
          </View>
        </View>
      </View>
      <View
        style={[
          styles.floatingControls,
          {
            bottom: floatingControlsBottom,
          },
        ]}
      >
        <Button
          accessibilityLabel={
            focusMode ? "Exit focus mode" : "Enter focus mode"
          }
          icon={focusMode ? "minimize" : "maximize"}
          iconOnly
          style={styles.floatingControlButton}
          onPress={() => {
            setFocusMode((current) => !current);
            setDisplayControlsVisible(false);
          }}
        >
          {focusMode ? "Exit focus" : "Focus"}
        </Button>
        {!focusMode ? (
          <>
            <Button
              accessibilityLabel={
                displayControlsVisible
                  ? "Hide display controls"
                  : "Show display controls"
              }
              icon="settings"
              iconOnly
              style={[
                styles.floatingControlButton,
                displayControlsVisible && styles.floatingControlButtonActive,
              ]}
              onPress={() => setDisplayControlsVisible((visible) => !visible)}
            >
              Display
            </Button>
            <Button
              accessibilityLabel={
                toolbarHidden ? "Show top toolbar" : "Hide top toolbar"
              }
              icon={toolbarHidden ? "eye" : "eyeOff"}
              iconOnly
              style={styles.floatingControlButton}
              onPress={() => setToolbarHidden((hidden) => !hidden)}
            >
              Toolbar
            </Button>
          </>
        ) : null}
      </View>
    </View>
  );
}

function getAgentStatusPresentation(status: TerminalConnectionStatus): {
  accessibilityLabel: string;
  color: string;
} {
  switch (status) {
    case "authenticated":
      return {
        accessibilityLabel: "Agent connected",
        color: colors.success,
      };
    case "connecting":
    case "authenticating":
      return {
        accessibilityLabel: "Agent connecting",
        color: colors.warning,
      };
    case "failed":
      return {
        accessibilityLabel: "Agent disconnected",
        color: colors.danger,
      };
    case "idle":
    default:
      return {
        accessibilityLabel: "Agent idle",
        color: colors.textDim,
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
    alignItems: "center",
    justifyContent: "center",
  },
  backButton: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 19,
    width: 38,
    minHeight: 38,
    justifyContent: "center",
    paddingHorizontal: 0,
  },
  sessionTitle: {
    fontSize: 17,
    fontWeight: "800",
    textAlign: "center",
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
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.sm,
  },
  displayPanel: {
    gap: spacing.sm,
    borderColor: colors.borderSubtle,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    backgroundColor: colors.surfaceRaised,
  },
  displayPanelHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  displayPanelTitle: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: 13,
    fontWeight: "800",
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
  fitPill: {
    color: colors.warning,
    fontSize: 11,
    fontWeight: "800",
    borderColor: colors.warning,
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: 8,
    paddingVertical: 4,
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
  floatingControls: {
    position: "absolute",
    right: spacing.lg,
    zIndex: 3,
    gap: spacing.sm,
    borderColor: colors.borderSubtle,
    borderWidth: 1,
    borderRadius: radii.pill,
    padding: 5,
    backgroundColor: "rgba(17, 24, 29, 0.92)",
  },
  floatingControlButton: {
    width: 40,
    minHeight: 40,
    borderRadius: 20,
    paddingHorizontal: 0,
    backgroundColor: colors.surface,
  },
  floatingControlButtonActive: {
    borderColor: colors.success,
    backgroundColor: colors.successSoft,
  },
  disabled: {
    opacity: 0.45,
  },
});
