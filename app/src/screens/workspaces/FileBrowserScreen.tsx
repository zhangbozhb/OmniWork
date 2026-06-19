import { type JSX, useEffect, useRef, useState } from "react";
import {
  Clipboard,
  Dimensions,
  type GestureResponderEvent,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";

import type {
  FilesReadPayload,
  WorkspaceDefinition,
  WorkspaceFileEntry,
} from "@omniwork/protocol-ts";
import { Badge, Button, Card } from "../../ui/components";
import { colors, radii, spacing } from "../../ui/theme";
import { Icon } from "../../ui/icons";

type CopyTarget = {
  name: string;
  relativePath: string;
  absolutePath: string;
};

type CopyNotice = {
  message: string;
  pageY?: number;
};

const COPY_NOTICE_HEIGHT = 80;
const COPY_NOTICE_GAP = 60;

export interface FileBrowserScreenProps {
  workspace: WorkspaceDefinition;
  relativePath: string;
  entries: WorkspaceFileEntry[];
  file?: FilesReadPayload;
  loading?: boolean;
  embedded?: boolean;
  onBack?(): void;
  onRefresh(): void;
  onOpenDirectory(relativePath: string): void;
  onReadFile(relativePath: string): void;
}

export function FileBrowserScreen({
  workspace,
  relativePath,
  entries,
  file,
  loading,
  embedded = false,
  onBack,
  onRefresh,
  onOpenDirectory,
  onReadFile,
}: FileBrowserScreenProps): JSX.Element {
  const { t } = useTranslation();
  const screenRef = useRef<View>(null);
  const [copyTarget, setCopyTarget] = useState<CopyTarget | undefined>();
  const [copyNotice, setCopyNotice] = useState<CopyNotice | undefined>();
  const [screenHeight, setScreenHeight] = useState(
    Dimensions.get("window").height,
  );
  const [screenPageY, setScreenPageY] = useState(0);
  const copyNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const currentParts = relativePath.split("/").filter(Boolean);

  useEffect(
    () => () => {
      if (copyNoticeTimerRef.current) {
        clearTimeout(copyNoticeTimerRef.current);
      }
    },
    [],
  );

  function openCopySheet(target: CopyTarget): void {
    setCopyTarget(target);
  }

  function copyText(text: string, notice: string, pageY?: number): void {
    Clipboard.setString(text);
    setCopyTarget(undefined);
    setCopyNotice({ message: notice, pageY });
    if (copyNoticeTimerRef.current) {
      clearTimeout(copyNoticeTimerRef.current);
    }
    copyNoticeTimerRef.current = setTimeout(() => {
      setCopyNotice(undefined);
      copyNoticeTimerRef.current = undefined;
    }, 1800);
  }

  function handleScreenLayout(): void {
    screenRef.current?.measure((_x, _y, _width, height, _pageX, pageY) => {
      setScreenHeight(height);
      setScreenPageY(pageY);
    });
  }

  return (
    <View
      ref={screenRef}
      style={[styles.screen, embedded && styles.embeddedScreen]}
      onLayout={handleScreenLayout}
    >
      {!embedded ? (
      <View style={styles.toolbar}>
        <Button
          accessibilityLabel={t("files.backToSessions")}
          icon="arrowLeft"
          iconOnly
          style={styles.backButton}
          onPress={onBack ?? noop}
        >
          {t("common.back")}
        </Button>
        <View style={styles.titleArea}>
          <Text numberOfLines={1} style={styles.title}>
            {t("files.title", { workspace: getWorkspaceDisplayName(workspace) })}
          </Text>
          <Text numberOfLines={1} style={styles.subtitle}>
            {relativePath || "."}
          </Text>
        </View>
        <Button
          accessibilityLabel={t("files.refresh")}
          icon="refresh"
          iconOnly
          style={styles.iconButton}
          onPress={onRefresh}
        >
          {t("common.refresh")}
        </Button>
      </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.tree}>
          <TreeRow
            depth={0}
            expanded
            icon="folder"
            label={getWorkspaceDisplayName(workspace)}
            meta={t("files.workspaceRoot")}
            onLongPress={() =>
              openCopySheet(toCopyTarget(workspace, "", getWorkspaceDisplayName(workspace)))
            }
            onPress={() => onOpenDirectory("")}
          />

          {currentParts.map((part, index) => {
            const path = currentParts.slice(0, index + 1).join("/");
            return (
              <TreeRow
                depth={index + 1}
                expanded
                icon="folder"
                key={path}
                label={part}
                meta={
                  index === currentParts.length - 1
                    ? t("files.currentDirectory")
                    : t("files.directory")
                }
                onLongPress={() =>
                  openCopySheet(toCopyTarget(workspace, path, part))
                }
                onPress={() => onOpenDirectory(path)}
              />
            );
          })}

          {entries.map((entry) => (
            <TreeRow
              depth={currentParts.length + 1}
              icon={entry.type === "directory" ? "folder" : "file"}
              key={entry.relativePath}
              label={entry.name}
              meta={formatEntryMeta(entry, t)}
              selected={file?.relativePath === entry.relativePath}
              onLongPress={() =>
                openCopySheet(
                  toCopyTarget(workspace, entry.relativePath, entry.name),
                )
              }
              onPress={() =>
                entry.type === "directory"
                  ? onOpenDirectory(entry.relativePath)
                  : onReadFile(entry.relativePath)
              }
            />
          ))}
        </View>

        {entries.length === 0 ? (
          <Text style={styles.empty}>
            {loading ? t("common.loading") : t("files.empty")}
          </Text>
        ) : null}

        {file ? (
          <Card style={styles.previewCard}>
            <View style={styles.previewHeader}>
              <Text numberOfLines={1} style={styles.previewTitle}>
                {file.relativePath}
              </Text>
              <Badge>{file.encoding}</Badge>
            </View>
            {file.encoding === "utf8" ? (
              <Text selectable style={styles.fileContent}>
                {file.content}
              </Text>
            ) : (
              <Text style={styles.hint}>
                {file.encoding === "too_large"
                  ? t("files.tooLarge", { size: formatBytes(file.size) })
                  : t("files.binaryDisabled")}
              </Text>
            )}
          </Card>
        ) : null}
      </ScrollView>
      {copyNotice ? (
        <CopyNoticeToast
          notice={copyNotice}
          screenHeight={screenHeight}
          screenPageY={screenPageY}
        />
      ) : null}
      <CopyPathModal
        target={copyTarget}
        onClose={() => setCopyTarget(undefined)}
        onCopy={(text, notice, pageY) => copyText(text, notice, pageY)}
      />
    </View>
  );
}

function CopyNoticeToast({
  notice,
  screenHeight,
  screenPageY,
}: {
  notice: CopyNotice;
  screenHeight: number;
  screenPageY: number;
}): JSX.Element {
  return (
    <View
      pointerEvents="none"
      style={[
        styles.copyNoticeToast,
        getCopyNoticeToastPosition(notice.pageY, screenHeight, screenPageY),
      ]}
    >
      <Text accessibilityLiveRegion="polite" style={styles.copyNoticeText}>
        {notice.message}
      </Text>
    </View>
  );
}

function TreeRow({
  depth,
  expanded = false,
  icon,
  label,
  meta,
  muted = false,
  selected = false,
  onLongPress,
  onPress,
}: {
  depth: number;
  expanded?: boolean;
  icon: "folder" | "file";
  label: string;
  meta: string;
  muted?: boolean;
  selected?: boolean;
  onLongPress?(event: GestureResponderEvent): void;
  onPress(): void;
}): JSX.Element {
  const isFolder = icon === "folder";
  return (
    <Pressable
      style={[
        styles.treeRow,
        selected && styles.treeRowSelected,
        { paddingLeft: spacing.sm + depth * 18 },
      ]}
      onLongPress={onLongPress}
      onPress={onPress}
    >
      <View style={styles.treeGuide} />
      <Icon
        name={isFolder ? (expanded ? "chevronDown" : "chevronUp") : "file"}
        color={muted ? colors.textMuted : colors.textSecondary}
        size={14}
      />
      {isFolder ? (
        <Icon name="folder" color={colors.success} size={17} />
      ) : null}
      <View style={styles.entryInfo}>
        <Text
          numberOfLines={1}
          style={[
            styles.entryName,
            muted && styles.entryNameMuted,
            selected && styles.entryNameSelected,
          ]}
        >
          {label}
        </Text>
        <Text numberOfLines={1} style={styles.entryMeta}>
          {meta}
        </Text>
      </View>
    </Pressable>
  );
}

function CopyPathModal({
  target,
  onClose,
  onCopy,
}: {
  target?: CopyTarget;
  onClose(): void;
  onCopy(text: string, notice: string, pageY?: number): void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <Modal
      animationType="fade"
      transparent
      visible={Boolean(target)}
      onRequestClose={onClose}
    >
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.copySheet} onPress={noop}>
          <Text style={styles.copySheetTitle}>{t("files.copy.title")}</Text>
          <Text numberOfLines={2} style={styles.copySheetPath}>
            {target?.relativePath || "."}
          </Text>
          <CopyPathOption
            label={t("files.copy.fileName")}
            value={target?.name ?? ""}
            onPress={(event) =>
              target
                ? onCopy(
                    target.name,
                    t("files.copy.copied", { value: target.name }),
                    event.nativeEvent.pageY,
                  )
                : undefined
            }
          />
          <CopyPathOption
            label={t("files.copy.relativePath")}
            value={target?.relativePath || "."}
            onPress={(event) =>
              target
                ? onCopy(
                    target.relativePath || ".",
                    t("files.copy.copied", {
                      value: target.relativePath || ".",
                    }),
                    event.nativeEvent.pageY,
                  )
                : undefined
            }
          />
          <CopyPathOption
            label={t("files.copy.absolutePath")}
            value={target?.absolutePath ?? ""}
            onPress={(event) =>
              target
                ? onCopy(
                    target.absolutePath,
                    t("files.copy.copied", { value: target.absolutePath }),
                    event.nativeEvent.pageY,
                  )
                : undefined
            }
          />
          <Pressable style={styles.copyCancelButton} onPress={onClose}>
            <Text style={styles.copyCancelText}>{t("common.cancel")}</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function CopyPathOption({
  label,
  value,
  onPress,
}: {
  label: string;
  value: string;
  onPress(event: GestureResponderEvent): void;
}): JSX.Element {
  return (
    <Pressable style={styles.copyOption} onPress={onPress}>
      <Text style={styles.copyOptionLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.copyOptionValue}>
        {value}
      </Text>
    </Pressable>
  );
}

function noop(): void {}

function getCopyNoticeToastPosition(
  pageY: number | undefined,
  screenHeight: number,
  screenPageY: number,
): { top: number } | { bottom: number } {
  if (typeof pageY !== "number") {
    return { bottom: spacing.xl };
  }

  const localY = pageY - screenPageY;
  const topCandidate = localY - COPY_NOTICE_GAP - COPY_NOTICE_HEIGHT;
  if (topCandidate >= spacing.sm) {
    return { top: topCandidate };
  }

  return {
    top: Math.max(
      spacing.sm,
      Math.min(
        screenHeight - COPY_NOTICE_HEIGHT - spacing.sm,
        localY + COPY_NOTICE_GAP,
      ),
    ),
  };
}

function getWorkspaceDisplayName(workspace: WorkspaceDefinition): string {
  const normalized = workspace.path.replace(/\/+$/g, "");
  const fallback = normalized.split("/").filter(Boolean).at(-1) ?? "Workspace";
  return workspace.name?.trim() || fallback;
}

function toCopyTarget(
  workspace: WorkspaceDefinition,
  relativePath: string,
  name: string,
): CopyTarget {
  return {
    name,
    relativePath,
    absolutePath: joinWorkspacePath(workspace.path, relativePath),
  };
}

function joinWorkspacePath(workspacePath: string, relativePath: string): string {
  const root = workspacePath.replace(/\/+$/g, "");
  const child = relativePath.replace(/^\/+/g, "");
  return child ? `${root}/${child}` : root;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${Math.round(value / 1024 / 1024)} MB`;
}

function formatEntryMeta(
  entry: WorkspaceFileEntry,
  t: (key: string) => string,
): string {
  const size = typeof entry.size === "number" ? ` · ${formatBytes(entry.size)}` : "";
  return `${entry.type === "directory" ? t("files.directory") : entry.type}${size}`;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    padding: spacing.xl,
  },
  embeddedScreen: {
    padding: 0,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.xl,
  },
  backButton: {
    width: 40,
    minHeight: 40,
    paddingHorizontal: 0,
    borderRadius: 20,
  },
  iconButton: {
    width: 42,
    minHeight: 40,
    paddingHorizontal: 0,
  },
  titleArea: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 20,
    fontWeight: "800",
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  content: {
    gap: spacing.md,
    paddingBottom: spacing.xxl,
  },
  tree: {
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    overflow: "hidden",
    backgroundColor: colors.surface,
  },
  pathCard: {
    padding: spacing.lg,
    gap: spacing.xs,
  },
  pathText: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  hint: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
  entryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    borderColor: colors.borderSubtle,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.lg,
    backgroundColor: colors.surface,
  },
  treeRow: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 44,
    paddingRight: spacing.md,
    paddingVertical: 7,
    borderBottomColor: colors.borderSubtle,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  treeRowSelected: {
    backgroundColor: colors.successSoft,
  },
  treeGuide: {
    width: 1,
    alignSelf: "stretch",
    backgroundColor: colors.borderSubtle,
    opacity: 0.65,
  },
  entryInfo: {
    flex: 1,
    minWidth: 0,
  },
  entryName: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: "700",
  },
  entryNameMuted: {
    color: colors.textMuted,
  },
  entryNameSelected: {
    color: colors.success,
  },
  entryMeta: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  empty: {
    color: colors.textMuted,
    padding: spacing.lg,
  },
  copyNoticeToast: {
    position: "absolute",
    left: spacing.xl,
    right: spacing.xl,
    minHeight: COPY_NOTICE_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
  },
  copyNoticeText: {
    maxWidth: "100%",
    overflow: "hidden",
    borderColor: "rgba(48, 196, 141, 0.42)",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.success,
    fontSize: 12,
    fontWeight: "900",
    lineHeight: 17,
    backgroundColor: "rgba(17, 24, 29, 0.96)",
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0, 0, 0, 0.48)",
  },
  copySheet: {
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.sm,
    backgroundColor: colors.surfaceRaised,
  },
  copySheetTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: "900",
  },
  copySheetPath: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginBottom: spacing.xs,
  },
  copyOption: {
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
  },
  copyOptionLabel: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: "900",
  },
  copyOptionValue: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  copyCancelButton: {
    minHeight: 40,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  copyCancelText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: "900",
  },
  previewCard: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  previewHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  previewTitle: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: 15,
    fontWeight: "800",
  },
  fileContent: {
    color: colors.textSecondary,
    fontFamily: "Menlo",
    fontSize: 12,
    lineHeight: 17,
  },
});
