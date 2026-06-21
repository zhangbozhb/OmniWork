import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Clipboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";

import type {
  FilesReadPayload,
  FilesWritePayload,
  WorkspaceDefinition,
} from "@omniwork/protocol-ts";
import { Button, Card } from "../../ui/components";
import { colors, radii, spacing } from "../../ui/theme";
import {
  canEditFileContent,
  getEditableFileBlockReason,
} from "../../features/workspaces/editableFiles";
import {
  CodeEditorView,
  type CodeEditorChange,
  type CodeEditorViewHandle,
} from "../../editor/CodeEditorView";

type DiffLine = {
  type: "add" | "delete" | "context";
  text: string;
};

const INSERT_TOKENS = ["  ", "{", "}", "(", ")", "[", "]", "\"", "'", "=", "/", ".", ";"];
const MAX_LCS_DIFF_CELLS = 250_000;
const RISKY_FILE_PATTERN = /(^|\/)(\.env|.*\.(env|json|jsonl|yaml|yml|toml|lock))$/i;

export interface FileEditorScreenProps {
  workspace: WorkspaceDefinition;
  relativePath: string;
  file?: FilesReadPayload;
  loading?: boolean;
  saving?: boolean;
  writeResult?: FilesWritePayload;
  onBack(): void;
  onContentChange?(): void;
  onReload(): void;
  onSave(content: string, baseHash: string): void;
}

export function FileEditorScreen({
  workspace,
  relativePath,
  file,
  loading,
  saving,
  writeResult,
  onBack,
  onContentChange,
  onReload,
  onSave,
}: FileEditorScreenProps): JSX.Element {
  const { t } = useTranslation();
  const editorRef = useRef<CodeEditorViewHandle | null>(null);
  const [content, setContent] = useState(file?.content ?? "");
  const [dirty, setDirty] = useState(false);
  const [changedLineNumbers, setChangedLineNumbers] = useState<number[]>([]);
  const [showDiff, setShowDiff] = useState(false);
  const [showRemoteContent, setShowRemoteContent] = useState(false);
  const [diffContent, setDiffContent] = useState(file?.content ?? "");
  const originalContent = file?.content ?? "";
  const editable = canEditFileContent(relativePath, file);
  const hasBaseHash = Boolean(file?.contentHash);
  const canSave = editable && hasBaseHash;
  const blockReason = getEditableFileBlockReason(relativePath, file);
  const diffLines = useMemo(
    () => (showDiff ? createLineDiff(originalContent, diffContent) : []),
    [diffContent, originalContent, showDiff],
  );
  const additions = diffLines.filter((line) => line.type === "add").length;
  const deletions = diffLines.filter((line) => line.type === "delete").length;
  const conflict = writeResult?.relativePath === relativePath && writeResult.status === "conflict"
    ? writeResult
    : undefined;
  const saveFailure =
    writeResult?.relativePath === relativePath &&
    writeResult.status === "unsupported"
      ? writeResult
      : undefined;

  useEffect(() => {
    const nextContent = file?.content ?? "";
    setContent(nextContent);
    setDiffContent(nextContent);
    setDirty(false);
    setChangedLineNumbers([]);
    setShowDiff(false);
    setShowRemoteContent(false);
  }, [file?.content, file?.relativePath]);

  function confirmBack(): void {
    if (!dirty) {
      onBack();
      return;
    }
    Alert.alert(t("files.editor.unsavedTitle"), t("files.editor.unsavedMessage"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("files.editor.discard"), style: "destructive", onPress: onBack },
    ]);
  }

  function insertToken(token: string): void {
    editorRef.current?.insertText(token);
  }

  async function getCurrentEditorContent(): Promise<string | undefined> {
    const currentContent = await editorRef.current?.requestContent();
    if (currentContent === undefined) {
      Alert.alert(
        t("files.editor.contentUnavailableTitle"),
        t("files.editor.contentUnavailableMessage"),
      );
      return undefined;
    }
    setContent(currentContent);
    return currentContent;
  }

  async function saveCurrentContent(): Promise<void> {
    if (!canSave || !dirty || !file?.contentHash || saving) {
      return;
    }
    const baseHash = file.contentHash;
    const currentContent = await getCurrentEditorContent();
    if (currentContent === undefined) {
      return;
    }
    if (currentContent === originalContent) {
      setDirty(false);
      setChangedLineNumbers([]);
      return;
    }
    if (isHighRiskSave(relativePath, originalContent, currentContent)) {
      Alert.alert(
        t("files.editor.riskSaveTitle"),
        t("files.editor.riskSaveMessage"),
        [
          { text: t("common.cancel"), style: "cancel" },
          {
            text: t("files.editor.viewDiff"),
            onPress: () => {
              setDiffContent(currentContent);
              setShowDiff(true);
            },
          },
          {
            text: t("files.editor.saveAnyway"),
            style: "destructive",
              onPress: () => onSave(currentContent, baseHash),
          },
        ],
      );
      return;
    }
    onSave(currentContent, baseHash);
  }

  function handleContentChange(change: CodeEditorChange): void {
    setDirty(change.dirty);
    setChangedLineNumbers(change.changedLines);
    if (change.value !== undefined) {
      setContent(change.value);
    }
    onContentChange?.();
  }

  async function copyLocalChanges(): Promise<void> {
    const currentContent = await getCurrentEditorContent();
    if (currentContent === undefined) {
      return;
    }
    Clipboard.setString(currentContent);
    Alert.alert(
      t("files.editor.localCopiedTitle"),
      t("files.editor.localCopiedMessage"),
    );
  }

  async function openDiff(): Promise<void> {
    if (!dirty) {
      return;
    }
    const currentContent = await getCurrentEditorContent();
    if (currentContent === undefined) {
      return;
    }
    setDiffContent(currentContent);
    setShowDiff(true);
  }

  function confirmReloadRemote(): void {
    if (!dirty) {
      onReload();
      return;
    }
    Alert.alert(
      t("files.editor.reloadConfirmTitle"),
      t("files.editor.reloadConfirmMessage"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("files.editor.reloadRemote"),
          style: "destructive",
          onPress: onReload,
        },
      ],
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.screen}
    >
      <View style={styles.header}>
        <Button variant="ghost" onPress={confirmBack}>
          {t("common.cancel")}
        </Button>
        <View style={styles.titleBlock}>
          <Text numberOfLines={1} style={styles.title}>
            {basename(relativePath)}
          </Text>
          <Text numberOfLines={1} style={styles.subtitle}>
            {dirty ? t("files.editor.modified") : workspace.name ?? workspace.path}
          </Text>
        </View>
        <Button
          disabled={!canSave || !dirty || saving}
          tone="primary"
          variant="solid"
          onPress={saveCurrentContent}
        >
          {saving ? t("files.editor.saving") : t("common.save")}
        </Button>
      </View>

      <View style={styles.statusBar}>
        <Text style={styles.statusText}>
          {loading
            ? t("common.loading")
            : dirty
              ? showDiff
                ? t("files.editor.changeSummary", { additions, deletions })
                : t("files.editor.modified")
              : t("files.editor.noChanges")}
        </Text>
        <Pressable
          disabled={!dirty}
          onPress={() => {
            if (showDiff) {
              setShowDiff(false);
              return;
            }
            void openDiff();
          }}
        >
          <Text style={[styles.diffToggle, !dirty && styles.disabledText]}>
            {showDiff ? t("files.editor.hideDiff") : t("files.editor.viewDiff")}
          </Text>
        </Pressable>
      </View>

      {conflict ? (
        <Card style={styles.warningCard}>
          <Text style={styles.warningTitle}>{t("files.editor.conflictTitle")}</Text>
          <Text style={styles.warningText}>{t("files.editor.conflictMessage")}</Text>
          <View style={styles.warningActions}>
            <Button variant="ghost" onPress={copyLocalChanges}>
              {t("files.editor.copyLocal")}
            </Button>
            {conflict.content !== undefined ? (
              <Button
                variant="ghost"
                onPress={() => setShowRemoteContent((current) => !current)}
              >
                {showRemoteContent
                  ? t("files.editor.hideRemote")
                  : t("files.editor.viewRemote")}
              </Button>
            ) : null}
            <Button variant="ghost" onPress={confirmReloadRemote}>
              {t("files.editor.reloadRemote")}
            </Button>
          </View>
          {showRemoteContent && conflict.content !== undefined ? (
            <ScrollView style={styles.remotePreview}>
              <Text style={styles.remoteText}>{conflict.content}</Text>
            </ScrollView>
          ) : null}
        </Card>
      ) : null}

      {saveFailure ? (
        <Card style={styles.warningCard}>
          <Text style={styles.warningTitle}>{t("files.editor.saveFailedTitle")}</Text>
          <Text style={styles.warningText}>
            {saveFailure.message ?? t("files.editor.saveFailedMessage")}
          </Text>
        </Card>
      ) : null}

      {!editable && !loading ? (
        <Card style={styles.warningCard}>
          <Text style={styles.warningTitle}>{t("files.editor.readOnlyTitle")}</Text>
          <Text style={styles.warningText}>
            {t(`files.editor.blockReason.${blockReason ?? "missing"}`)}
          </Text>
        </Card>
      ) : null}

      {editable && !hasBaseHash && !loading ? (
        <Card style={styles.warningCard}>
          <Text style={styles.warningTitle}>{t("files.editor.reloadRequiredTitle")}</Text>
          <Text style={styles.warningText}>{t("files.editor.reloadRequiredMessage")}</Text>
          <View style={styles.warningActions}>
            <Button variant="ghost" onPress={confirmReloadRemote}>
              {t("files.editor.reloadRemote")}
            </Button>
          </View>
        </Card>
      ) : null}

      <View style={styles.body}>
        <View style={styles.editorContainer}>
          <CodeEditorView
            ref={editorRef}
            editable={editable && !loading}
            path={relativePath}
            value={content}
            onChange={handleContentChange}
          />
        </View>
        {showDiff ? (
          <View style={styles.diffOverlay}>
            <View style={styles.diffOverlayHeader}>
              <Text style={styles.diffOverlayTitle}>
                {t("files.editor.changeSummary", { additions, deletions })}
              </Text>
              <Button variant="ghost" onPress={() => setShowDiff(false)}>
                {t("files.editor.hideDiff")}
              </Button>
            </View>
            <ScrollView style={styles.diffOverlayBody} contentContainerStyle={styles.diffList}>
              {diffLines.length === 0 ? (
                <Text style={styles.emptyText}>{t("files.editor.noChanges")}</Text>
              ) : (
                diffLines.map((line, index) => (
                  <Text
                    key={`${index}:${line.type}:${line.text}`}
                    style={[
                      styles.diffLine,
                      line.type === "add" && styles.diffAdd,
                      line.type === "delete" && styles.diffDelete,
                    ]}
                  >
                    {line.type === "add" ? "+ " : line.type === "delete" ? "- " : "  "}
                    {line.text}
                  </Text>
                ))
              )}
            </ScrollView>
          </View>
        ) : null}
      </View>

      <ScrollView
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
        style={styles.toolbar}
        contentContainerStyle={styles.toolbarContent}
      >
        <View style={styles.toolbarGroup}>
          <ToolbarButton
            disabled={!editable || showDiff}
            label={t("files.editor.undo")}
            onPress={() => editorRef.current?.undo()}
          />
          <ToolbarButton
            disabled={!editable || showDiff}
            label={t("files.editor.redo")}
            onPress={() => editorRef.current?.redo()}
          />
          <ToolbarButton
            disabled={showDiff}
            label={t("files.editor.search")}
            onPress={() => editorRef.current?.openSearch()}
          />
        </View>
        <View style={styles.toolbarGroup}>
          <ToolbarButton
            disabled={changedLineNumbers.length === 0 || showDiff}
            label={t("files.editor.previousChange")}
            onPress={() => editorRef.current?.goToChange("previous")}
          />
          <ToolbarButton
            disabled={changedLineNumbers.length === 0 || showDiff}
            label={t("files.editor.nextChange")}
            onPress={() => editorRef.current?.goToChange("next")}
          />
        </View>
        <View style={styles.toolbarGroup}>
          <ToolbarButton
            disabled={!editable || showDiff}
            label={t("files.editor.outdent")}
            onPress={() => editorRef.current?.indentLess()}
          />
          <ToolbarButton
            disabled={!editable || showDiff}
            label={t("files.editor.indent")}
            onPress={() => editorRef.current?.indentMore()}
          />
        </View>
        <View style={styles.toolbarGroup}>
          {INSERT_TOKENS.map((token) => (
            <ToolbarButton
              disabled={!editable || showDiff}
              key={token}
              label={token === "  " ? "Tab" : token}
              onPress={() => insertToken(token)}
            />
          ))}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ToolbarButton({
  disabled,
  label,
  onPress,
}: {
  disabled?: boolean;
  label: string;
  onPress(): void;
}): JSX.Element {
  return (
    <Pressable
      disabled={disabled}
      style={[styles.tokenButton, disabled && styles.disabled]}
      onPress={onPress}
    >
      <Text style={styles.tokenText}>{label}</Text>
    </Pressable>
  );
}

function createLineDiff(before: string, after: string): DiffLine[] {
  return collapseUnchangedContext(createFullLineDiff(before, after));
}

function createFullLineDiff(before: string, after: string): DiffLine[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  if (beforeLines.length * afterLines.length > MAX_LCS_DIFF_CELLS) {
    return createPrefixSuffixLineDiff(beforeLines, afterLines);
  }
  const table = Array.from({ length: beforeLines.length + 1 }, () =>
    Array<number>(afterLines.length + 1).fill(0),
  );
  for (let row = beforeLines.length - 1; row >= 0; row -= 1) {
    for (let column = afterLines.length - 1; column >= 0; column -= 1) {
      table[row][column] =
        beforeLines[row] === afterLines[column]
          ? table[row + 1][column + 1] + 1
          : Math.max(table[row + 1][column], table[row][column + 1]);
    }
  }
  const result: DiffLine[] = [];
  let row = 0;
  let column = 0;
  while (row < beforeLines.length && column < afterLines.length) {
    if (beforeLines[row] === afterLines[column]) {
      result.push({ type: "context", text: beforeLines[row] });
      row += 1;
      column += 1;
    } else if (table[row + 1][column] >= table[row][column + 1]) {
      result.push({ type: "delete", text: beforeLines[row] });
      row += 1;
    } else {
      result.push({ type: "add", text: afterLines[column] });
      column += 1;
    }
  }
  while (row < beforeLines.length) {
    result.push({ type: "delete", text: beforeLines[row] });
    row += 1;
  }
  while (column < afterLines.length) {
    result.push({ type: "add", text: afterLines[column] });
    column += 1;
  }
  return result;
}

function isHighRiskSave(path: string, before: string, after: string): boolean {
  if (RISKY_FILE_PATTERN.test(path)) {
    return true;
  }
  const diffLines = createFullLineDiff(before, after);
  const deletions = diffLines.filter((line) => line.type === "delete").length;
  const additions = diffLines.filter((line) => line.type === "add").length;
  return deletions >= 10 || deletions > additions * 2;
}

function createPrefixSuffixLineDiff(
  beforeLines: string[],
  afterLines: string[],
): DiffLine[] {
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let beforeSuffix = beforeLines.length - 1;
  let afterSuffix = afterLines.length - 1;
  while (
    beforeSuffix >= prefix &&
    afterSuffix >= prefix &&
    beforeLines[beforeSuffix] === afterLines[afterSuffix]
  ) {
    beforeSuffix -= 1;
    afterSuffix -= 1;
  }
  const result: DiffLine[] = [];
  for (let index = prefix; index <= beforeSuffix; index += 1) {
    result.push({ type: "delete", text: beforeLines[index] });
  }
  for (let index = prefix; index <= afterSuffix; index += 1) {
    result.push({ type: "add", text: afterLines[index] });
  }
  return result;
}

function collapseUnchangedContext(lines: DiffLine[]): DiffLine[] {
  const firstChangedIndex = lines.findIndex((line) => line.type !== "context");
  if (firstChangedIndex < 0) {
    return [];
  }
  let lastChangedIndex = lines.length - 1;
  while (lastChangedIndex >= 0 && lines[lastChangedIndex]?.type === "context") {
    lastChangedIndex -= 1;
  }
  const start = Math.max(0, firstChangedIndex - 2);
  const end = Math.min(lines.length, lastChangedIndex + 3);
  return lines.slice(start, end);
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
  },
  titleBlock: {
    flex: 1,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: "700",
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  statusBar: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  statusText: {
    color: colors.textMuted,
    fontSize: 12,
  },
  diffToggle: {
    color: colors.success,
    fontSize: 13,
    fontWeight: "700",
  },
  disabledText: {
    color: colors.textMuted,
  },
  warningCard: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  warningTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: "700",
  },
  warningText: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: spacing.xs,
  },
  warningActions: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  remotePreview: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.sm,
    maxHeight: 180,
    padding: spacing.sm,
  },
  remoteText: {
    color: colors.textSecondary,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 12,
    lineHeight: 18,
  },
  body: {
    flex: 1,
  },
  editorContainer: {
    backgroundColor: colors.surface,
    flex: 1,
    marginHorizontal: spacing.md,
    borderRadius: radii.lg,
    overflow: "hidden",
  },
  diffOverlay: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    left: spacing.md,
    overflow: "hidden",
    position: "absolute",
    right: spacing.md,
    top: 0,
  },
  diffOverlayHeader: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  diffOverlayTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: "700",
  },
  diffOverlayBody: {
    flex: 1,
  },
  diffList: {
    padding: spacing.md,
  },
  diffLine: {
    color: colors.textSecondary,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  diffAdd: {
    backgroundColor: "rgba(74, 222, 128, 0.12)",
    color: colors.success,
  },
  diffDelete: {
    backgroundColor: "rgba(248, 113, 113, 0.12)",
    color: colors.danger,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 13,
  },
  toolbar: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    maxHeight: 58,
  },
  toolbarContent: {
    gap: spacing.sm,
    padding: spacing.sm,
  },
  toolbarGroup: {
    borderRightColor: colors.border,
    borderRightWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.sm,
    paddingRight: spacing.sm,
  },
  tokenButton: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    minWidth: 42,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  tokenText: {
    color: colors.textPrimary,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 13,
  },
  disabled: {
    opacity: 0.5,
  },
});
