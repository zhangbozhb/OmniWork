import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";

import type {
  FilesReadPayload,
  WorkspaceDefinition,
  WorkspaceFileEntry,
} from "../../../../packages/protocol-ts/src/index.ts";
import { Badge, Button, Card } from "../../ui/components";
import { colors, radii, spacing } from "../../ui/theme";
import { Icon } from "../../ui/icons";

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
  const currentParts = relativePath.split("/").filter(Boolean);
  return (
    <View style={[styles.screen, embedded && styles.embeddedScreen]}>
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
  onPress,
}: {
  depth: number;
  expanded?: boolean;
  icon: "folder" | "file";
  label: string;
  meta: string;
  muted?: boolean;
  selected?: boolean;
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

function noop(): void {}

function getWorkspaceDisplayName(workspace: WorkspaceDefinition): string {
  const normalized = workspace.path.replace(/\/+$/g, "");
  const fallback = normalized.split("/").filter(Boolean).at(-1) ?? "Workspace";
  return workspace.name?.trim() || fallback;
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
