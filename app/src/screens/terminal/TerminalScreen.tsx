import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dimensions,
  Keyboard,
  type KeyboardEvent,
  type LayoutChangeEvent,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";

import type {
  TerminalSession,
  TerminalInputPayload,
  TerminalResizePayload,
} from "@omniwork/protocol-ts";
import {
  createControlInput,
  createTextInput,
  sanitizeTerminalText,
  type TerminalControlKey,
} from "@omniwork/terminal-core";
import i18n from "../../i18n";
import {
  computeTerminalLayout,
  TERMINAL_TEXT_SIZE_OPTIONS,
  type TerminalTextSize,
  type TerminalViewport,
} from "../../features/terminal/terminalLayout";
import { NativeTerminalView } from "../../terminal/NativeTerminalView";
import { Button } from "../../ui/components";
import { colors, radii, spacing } from "../../ui/theme";

export interface TerminalScreenProps {
  session: TerminalSession;
  frame: string;
  streamChunk?: {
    sessionId: string;
    data: string;
    seq?: number;
    streamId: string;
  };
  canInput?: boolean;
  canResize?: boolean;
  connectionStatus?: TerminalConnectionStatus;
  readOnlyReason?: string;
  statusLabel?: string;
  textSize: TerminalTextSize;
  onBack(): void;
  onOpenFiles?(): void;
  onChangeTextSize(textSize: TerminalTextSize): void;
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
const WEB_SAFE_AREA_BOTTOM_MARGIN =
  `calc(env(safe-area-inset-bottom, 0px) + ${BOTTOM_DOCK_BOTTOM_MARGIN}px)` as unknown as number;
const INITIAL_BOTTOM_DOCK_HEIGHT = 156;
const INITIAL_FLOATING_CONTROLS_HEIGHT = 100;
const FLOATING_CONTROLS_LONG_PRESS_MS = 220;
const ESTIMATED_FULL_QUICK_KEYS_WIDTH = 760;

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
  streamChunk,
  canInput = true,
  canResize = true,
  connectionStatus = "idle",
  readOnlyReason,
  statusLabel,
  textSize,
  onBack,
  onOpenFiles,
  onChangeTextSize,
  onRefreshSessions,
  onInput,
  onResize,
}: TerminalScreenProps): JSX.Element {
  const { t } = useTranslation();
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
  const [terminalInputEnabled, setTerminalInputEnabled] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [textSizeControlsVisible, setTextSizeControlsVisible] = useState(false);
  const [composerVisible, setComposerVisible] = useState(true);
  const [floatingControlsHeight, setFloatingControlsHeight] = useState(
    INITIAL_FLOATING_CONTROLS_HEIGHT,
  );
  const [floatingControlsLift, setFloatingControlsLift] = useState(0);
  const [floatingControlsDragging, setFloatingControlsDragging] =
    useState(false);
  const floatingControlsLiftRef = useRef(0);
  const floatingControlsDragReadyRef = useRef(false);
  const floatingControlsStartLiftRef = useRef(0);
  const floatingControlsLongPressTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const [terminalViewport, setTerminalViewport] = useState<TerminalViewport>({
    width: Dimensions.get("window").width,
    height: Math.max(260, Dimensions.get("window").height - 260),
  });
  const agentStatus = getAgentStatusPresentation(connectionStatus);
  const terminalProviderLabel = session.terminal_provider_label || session.terminal_provider_kind;
  const hasDraft = draft.trim().length > 0;
  const canHideKeyboard =
    (keyboardVisible || terminalInputEnabled) && !hasDraft;
  const readOnly = !canInput;
  // Android uses windowSoftInputMode="adjustResize", so the window is already
  // resized above the keyboard. Re-applying keyboardBottomInset on Android would
  // double-shift the dock and leave a gap above the keyboard.
  const effectiveKeyboardInset =
    Platform.OS === "android" ? 0 : keyboardBottomInset;
  const canShowAllQuickKeys = quickKeysWidth >= ESTIMATED_FULL_QUICK_KEYS_WIDTH;
  const quickKeys = canShowAllQuickKeys
    ? FULL_QUICK_KEYS
    : advancedKeysVisible
      ? [...ALWAYS_VISIBLE_QUICK_KEYS, ...OVERFLOW_QUICK_KEYS]
      : ALWAYS_VISIBLE_QUICK_KEYS;
  const terminalLayout = useMemo(
    () => computeTerminalLayout(terminalViewport, textSize),
    [textSize, terminalViewport],
  );
  const floatingControlsBottom =
    bottomDockHeight +
    effectiveKeyboardInset +
    BOTTOM_DOCK_BOTTOM_MARGIN +
    spacing.md +
    floatingControlsLift;
  const maxFloatingControlsLift = Math.max(
    0,
    terminalViewport.height - floatingControlsHeight - spacing.md,
  );
  const terminalAreaBottomSpace =
    Platform.OS === "web" && effectiveKeyboardInset <= 0
      ? (`calc(${bottomDockHeight + BOTTOM_DOCK_BOTTOM_MARGIN}px + env(safe-area-inset-bottom, 0px))` as unknown as number)
      : bottomDockHeight + effectiveKeyboardInset + BOTTOM_DOCK_BOTTOM_MARGIN;
  const bottomDockBottom =
    effectiveKeyboardInset > 0
      ? effectiveKeyboardInset
      : Platform.OS === "web"
        ? WEB_SAFE_AREA_BOTTOM_MARGIN
        : BOTTOM_DOCK_BOTTOM_MARGIN;

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
      setTerminalInputEnabled(false);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  useEffect(() => {
    floatingControlsLiftRef.current = floatingControlsLift;
  }, [floatingControlsLift]);

  useEffect(
    () => () => {
      clearFloatingControlsLongPressTimer();
    },
    [],
  );

  useEffect(() => {
    setFloatingControlsLift((currentLift) =>
      clampNumber(currentLift, 0, maxFloatingControlsLift),
    );
  }, [maxFloatingControlsLift]);

  const floatingControlsPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          floatingControlsStartLiftRef.current = floatingControlsLiftRef.current;
          floatingControlsDragReadyRef.current = false;
          setFloatingControlsDragging(false);
          clearFloatingControlsLongPressTimer();
          floatingControlsLongPressTimeoutRef.current = setTimeout(() => {
            floatingControlsStartLiftRef.current =
              floatingControlsLiftRef.current;
            floatingControlsDragReadyRef.current = true;
          }, FLOATING_CONTROLS_LONG_PRESS_MS);
        },
        onPanResponderMove: (_event, gestureState) => {
          if (!floatingControlsDragReadyRef.current) {
            if (
              Math.abs(gestureState.dx) > 6 ||
              Math.abs(gestureState.dy) > 6
            ) {
              clearFloatingControlsLongPressTimer();
            }
            return;
          }
          if (Math.abs(gestureState.dy) <= Math.abs(gestureState.dx)) {
            return;
          }
          const nextLift = clampNumber(
            floatingControlsStartLiftRef.current - gestureState.dy,
            0,
            maxFloatingControlsLift,
          );
          setFloatingControlsDragging(true);
          setFloatingControlsLift(nextLift);
        },
        onPanResponderRelease: () => {
          clearFloatingControlsLongPressTimer();
          floatingControlsDragReadyRef.current = false;
          setFloatingControlsDragging(false);
        },
        onPanResponderTerminate: () => {
          clearFloatingControlsLongPressTimer();
          floatingControlsDragReadyRef.current = false;
          setFloatingControlsDragging(false);
        },
      }),
    [maxFloatingControlsLift],
  );

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
      setTerminalInputEnabled(false);
      Keyboard.dismiss();
    }
  }

  function clearFloatingControlsLongPressTimer(): void {
    if (floatingControlsLongPressTimeoutRef.current) {
      clearTimeout(floatingControlsLongPressTimeoutRef.current);
      floatingControlsLongPressTimeoutRef.current = null;
    }
  }

  function toggleComposerVisible(): void {
    setComposerVisible((visible) => {
      const nextVisible = !visible;
      if (!nextVisible) {
        setTerminalInputEnabled(false);
        Keyboard.dismiss();
      }
      return nextVisible;
    });
  }

  function selectTextSize(nextTextSize: TerminalTextSize): void {
    onChangeTextSize(nextTextSize);
    setTextSizeControlsVisible(false);
  }

  function dismissTextSizeControls(): void {
    setTextSizeControlsVisible(false);
  }

  function enterTerminalInputMode(): void {
    if (readOnly) {
      return;
    }
    dismissTextSizeControls();
    setTerminalInputEnabled(true);
  }

  function disableTerminalInputMode(): void {
    setTerminalInputEnabled(false);
    dismissTextSizeControls();
  }

  function exitTerminalInputMode(): void {
    disableTerminalInputMode();
    Keyboard.dismiss();
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

  function handleFloatingControlsLayout(event: LayoutChangeEvent): void {
    const nextHeight = Math.ceil(event.nativeEvent.layout.height);
    setFloatingControlsHeight((currentHeight) =>
      Math.abs(currentHeight - nextHeight) > 1 ? nextHeight : currentHeight,
    );
  }

  return (
    <View
      style={[
        styles.screen,
        Platform.OS === "web" ? styles.webSafeAreaScreen : null,
      ]}
    >
      {!focusMode ? (
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
            onPress={() => {
              dismissTextSizeControls();
              Keyboard.dismiss();
            }}
          >
            <Text
              numberOfLines={1}
              style={[styles.sessionTitle, { color: agentStatus.color }]}
            >
              {session.title}
            </Text>
          </Pressable>
          <View style={styles.toolbarActions}>
            {onOpenFiles ? (
              <Button
                accessibilityLabel={t("workspaces.tabs.files")}
                icon="folder"
                iconOnly
                style={styles.topIconButton}
                onPress={() => {
                  dismissTextSizeControls();
                  Keyboard.dismiss();
                  onOpenFiles();
                }}
              >
                {t("workspaces.tabs.files")}
              </Button>
            ) : null}
            <Pressable
              accessibilityLabel="Change terminal text size"
              accessibilityRole="button"
              style={[
                styles.textSizeButton,
                textSizeControlsVisible && styles.textSizeButtonActive,
              ]}
              onPress={() => setTextSizeControlsVisible((visible) => !visible)}
            >
              <Text style={styles.textSizeButtonText}>Aa</Text>
            </Pressable>
            <Button
              accessibilityLabel={
                composerVisible
                  ? t("terminal.hideInput")
                  : t("terminal.showInput")
              }
              icon={composerVisible ? "eyeOff" : "keyboard"}
              iconOnly
              style={[
                styles.inputToggleButton,
                !composerVisible && styles.inputToggleButtonActive,
              ]}
              onPress={() => {
                dismissTextSizeControls();
                toggleComposerVisible();
              }}
            >
              {composerVisible
                ? t("terminal.hideInput")
                : t("terminal.showInput")}
            </Button>
          </View>
        </View>
      ) : null}

      {!focusMode && textSizeControlsVisible ? (
        <View style={styles.textSizePopover}>
          <Text style={styles.textSizePopoverTitle}>
            {t("terminal.textSize.title")}
          </Text>
          <View style={styles.textSizeOptionRow}>
            {TERMINAL_TEXT_SIZE_OPTIONS.map((item) => {
              const selected = textSize === item.key;
              const label = t(`settings.terminalFontSize.options.${item.key}`);
              return (
                <Pressable
                  accessibilityLabel={t(
                    "settings.terminalFontSize.accessibility",
                    { label },
                  )}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  key={item.key}
                  style={[
                    styles.textSizeOption,
                    selected && styles.textSizeOptionSelected,
                  ]}
                  onPress={() => selectTextSize(item.key)}
                >
                  <Text
                    style={[
                      styles.textSizeOptionText,
                      selected && styles.textSizeOptionTextSelected,
                    ]}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.textSizeMeta}>
            {terminalLayout.terminalSize.cols}x
            {terminalLayout.terminalSize.rows}
            {" · "}
            {Math.round(terminalLayout.fontSize * 10) / 10}
            {Platform.OS === "ios" ? "pt" : "sp"}
          </Text>
        </View>
      ) : null}

      <View
        style={[
          styles.terminalArea,
          {
            marginBottom: terminalAreaBottomSpace,
          },
        ]}
        onLayout={handleTerminalAreaLayout}
        onStartShouldSetResponderCapture={() => {
          dismissTextSizeControls();
          if (!terminalInputEnabled) {
            Keyboard.dismiss();
          }
          return false;
        }}
      >
        <NativeTerminalView
          frame={frame}
          streamChunk={streamChunk}
          layout={terminalLayout}
          terminalSize={terminalLayout.terminalSize}
          terminalInputEnabled={terminalInputEnabled && !readOnly}
          readOnly={readOnly}
          onInput={onInput}
          onResize={canResize ? onResize : undefined}
        />
      </View>

      <View
        style={[
          styles.bottomDock,
          {
            bottom: bottomDockBottom,
          },
        ]}
        onLayout={handleBottomDockLayout}
        onStartShouldSetResponderCapture={() => {
          dismissTextSizeControls();
          return false;
        }}
      >
        {!focusMode && readOnly && readOnlyReason ? (
          <View style={styles.readOnlyBanner}>
            <Text style={styles.readOnlyTitle}>
              {t("terminal.readOnlyTitle")}
            </Text>
            <Text style={styles.readOnlyText}>{readOnlyReason}</Text>
            <Button
              icon="refresh"
              style={styles.readOnlyAction}
              onPress={onRefreshSessions}
            >
              {t("terminal.refreshSessions")}
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
                accessibilityLabel={t("terminal.sendKey", { key: item.label })}
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
              {t("common.clear")}
            </Button>
            {!canShowAllQuickKeys ? (
              <Button
                icon={advancedKeysVisible ? "chevronUp" : "more"}
                iconOnly
                style={styles.keyButton}
                onPress={() => setAdvancedKeysVisible((visible) => !visible)}
              >
                {advancedKeysVisible ? t("common.less") : t("common.more")}
              </Button>
            ) : null}
          </ScrollView>
        ) : null}

        {!focusMode && composerVisible ? (
          <View style={styles.composer}>
            <View style={styles.inputRow}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                placeholder={t("terminal.composerPlaceholder", {
                  terminalProvider: terminalProviderLabel,
                })}
                placeholderTextColor="#66727c"
                editable={!readOnly}
                returnKeyType="default"
                scrollEnabled
                submitBehavior="newline"
                onFocus={disableTerminalInputMode}
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
                {canHideKeyboard ? t("terminal.hide") : t("terminal.send")}
              </Button>
            </View>
          </View>
        ) : null}
      </View>
      <View
        style={[
          styles.floatingControls,
          floatingControlsDragging && styles.floatingControlsDragging,
          {
            bottom: floatingControlsBottom,
          },
        ]}
        onLayout={handleFloatingControlsLayout}
        onStartShouldSetResponderCapture={() => {
          dismissTextSizeControls();
          return false;
        }}
      >
        <View
          {...floatingControlsPanResponder.panHandlers}
          accessibilityLabel={t("terminal.moveFloatingControls")}
          accessibilityRole="button"
          style={styles.floatingControlsDragHandle}
        >
          <View style={styles.floatingControlsDragIndicator} />
        </View>
        <Button
          accessibilityLabel={
            focusMode
              ? t("terminal.exitFocusMode")
              : t("terminal.enterFocusMode")
          }
          icon={focusMode ? "minimize" : "maximize"}
          iconOnly
          style={styles.floatingControlButton}
          onPress={() => {
            setFocusMode((current) => !current);
            setTextSizeControlsVisible(false);
          }}
        >
          {focusMode ? t("terminal.exitFocus") : t("terminal.focus")}
        </Button>
        {!focusMode ? (
          <Button
            accessibilityLabel={
              terminalInputEnabled
                ? t("terminal.exitTerminalInput")
                : t("terminal.enterTerminalInput")
            }
            disabled={readOnly}
            icon="keyboard"
            iconOnly
            style={[
              styles.floatingControlButton,
              terminalInputEnabled && styles.floatingControlButtonActive,
              readOnly && styles.disabled,
            ]}
            onPress={() => {
              if (terminalInputEnabled) {
                exitTerminalInputMode();
                return;
              }
              enterTerminalInputMode();
            }}
          >
            {terminalInputEnabled
              ? t("terminal.browse")
              : t("terminal.terminalInput")}
          </Button>
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
        accessibilityLabel: i18n.t("terminal.agentStatus.connected"),
        color: colors.success,
      };
    case "connecting":
    case "authenticating":
      return {
        accessibilityLabel: i18n.t("terminal.agentStatus.connecting"),
        color: colors.warning,
      };
    case "failed":
      return {
        accessibilityLabel: i18n.t("terminal.agentStatus.disconnected"),
        color: colors.danger,
      };
    case "idle":
    default:
      return {
        accessibilityLabel: i18n.t("terminal.agentStatus.idle"),
        color: colors.textDim,
      };
  }
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    gap: spacing.md,
  },
  webSafeAreaScreen: {
    paddingTop:
      `calc(env(safe-area-inset-top, 0px) + ${spacing.lg}px)` as unknown as number,
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
  toolbarActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  textSizeButton: {
    width: 38,
    minHeight: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    borderColor: colors.border,
    borderWidth: 1,
    backgroundColor: colors.surface,
  },
  textSizeButtonActive: {
    borderColor: colors.success,
    backgroundColor: colors.successSoft,
  },
  textSizeButtonText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: "900",
  },
  inputToggleButton: {
    width: 38,
    minHeight: 38,
    borderRadius: 19,
    paddingHorizontal: 0,
  },
  inputToggleButtonActive: {
    borderColor: colors.success,
    backgroundColor: colors.successSoft,
  },
  topIconButton: {
    width: 38,
    minHeight: 38,
    borderRadius: 19,
    paddingHorizontal: 0,
  },
  textSizePopover: {
    position: "absolute",
    top: 56,
    right: spacing.lg,
    zIndex: 5,
    gap: spacing.sm,
    borderColor: colors.borderSubtle,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    backgroundColor: "rgba(17, 24, 29, 0.96)",
  },
  textSizePopoverTitle: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: "800",
  },
  textSizeOptionRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  textSizeOption: {
    minHeight: 32,
    borderRadius: radii.sm,
    borderColor: colors.border,
    borderWidth: 1,
    justifyContent: "center",
    paddingHorizontal: 10,
    backgroundColor: colors.surface,
  },
  textSizeOptionSelected: {
    borderColor: colors.success,
    backgroundColor: "#1a3028",
  },
  textSizeOptionText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "800",
  },
  textSizeOptionTextSelected: {
    color: "#d7ffe9",
  },
  textSizeMeta: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: "700",
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
  floatingControlsDragging: {
    borderColor: colors.success,
    backgroundColor: "rgba(17, 24, 29, 0.97)",
  },
  floatingControlsDragHandle: {
    minHeight: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  floatingControlsDragIndicator: {
    width: 22,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.border,
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
