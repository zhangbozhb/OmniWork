import { type JSX, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";

import type {
  GitDiffPayload,
  GitDiffScope,
  WorkspaceDefinition,
  WorkspaceGitStatus,
} from "../../../../packages/protocol-ts/src/index.ts";
import { Badge, Button, Card } from "../../ui/components";
import { colors, radii, spacing } from "../../ui/theme";

type FileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";
type GitViewMode = "overview" | "review";
type ChangedFile = WorkspaceGitStatus["files"][number];
type DiffLineType = "add" | "delete" | "hunk" | "meta" | "context";
type FileStatsScope = GitDiffScope;

const STATUS_COLOR: Record<FileStatus, string> = {
  modified: colors.warning,
  added: colors.success,
  deleted: colors.danger,
  renamed: "#7eb8f7",
  untracked: colors.textMuted,
};

const SCOPE_ORDER: GitDiffScope[] = ["all", "unstaged", "staged", "untracked"];

export interface GitStatusScreenProps {
  workspace: WorkspaceDefinition;
  status?: WorkspaceGitStatus;
  diff?: GitDiffPayload;
  loading?: boolean;
  embedded?: boolean;
  onBack?(): void;
  onRefresh(): void;
  onOpenDiff(relativePath?: string, scope?: GitDiffScope): void;
}

export function GitStatusScreen({
  workspace,
  status,
  diff,
  loading,
  embedded = false,
  onBack,
  onRefresh,
  onOpenDiff,
}: GitStatusScreenProps): JSX.Element {
  const { t } = useTranslation();
  const [mode, setMode] = useState<GitViewMode>("overview");
  const [scope, setScope] = useState<GitDiffScope>("all");
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const files = status?.files ?? [];
  const reviewFiles = useMemo(
    () => files.filter((file) => isFileInScope(file, scope)),
    [files, scope],
  );
  const selectedIndex = reviewFiles.findIndex((file) => file.path === selectedPath);
  const selectedFile = selectedIndex >= 0 ? reviewFiles[selectedIndex] : reviewFiles[0];
  const summary = getChangeSummary(files);

  useEffect(() => {
    if (mode !== "review") {
      return;
    }
    if (!selectedFile) {
      setSelectedPath(undefined);
      return;
    }
    if (selectedPath !== selectedFile.path) {
      setSelectedPath(selectedFile.path);
      onOpenDiff(selectedFile.path, scope);
    }
  }, [mode, onOpenDiff, scope, selectedFile, selectedPath]);

  function openReview(nextScope: GitDiffScope, path?: string): void {
    const nextFiles = files.filter((file) => isFileInScope(file, nextScope));
    const nextPath = path ?? nextFiles[0]?.path;
    setScope(nextScope);
    setSelectedPath(nextPath);
    setMode("review");
    onOpenDiff(nextPath, nextScope);
  }

  function selectScope(nextScope: GitDiffScope): void {
    const nextFile = files.find((file) => isFileInScope(file, nextScope));
    setScope(nextScope);
    setSelectedPath(nextFile?.path);
    if (mode === "review") {
      onOpenDiff(nextFile?.path, nextScope);
    }
  }

  function selectFile(file: ChangedFile): void {
    setSelectedPath(file.path);
    setMode("review");
    onOpenDiff(file.path, scope);
  }

  function moveSelection(offset: number): void {
    if (reviewFiles.length === 0) {
      return;
    }
    const currentIndex = Math.max(0, selectedIndex);
    const nextIndex = Math.min(reviewFiles.length - 1, Math.max(0, currentIndex + offset));
    const nextFile = reviewFiles[nextIndex];
    if (!nextFile) {
      return;
    }
    setSelectedPath(nextFile.path);
    onOpenDiff(nextFile.path, scope);
  }

  return (
    <View style={[styles.screen, embedded && styles.embeddedScreen]}>
      {!embedded ? (
        <View style={styles.toolbar}>
          <Button
            accessibilityLabel={t("git.backToSessions")}
            icon="arrowLeft"
            iconOnly
            style={styles.backButton}
            onPress={onBack ?? noop}
          >
            {t("common.back")}
          </Button>
          <View style={styles.titleArea}>
            <Text numberOfLines={1} style={styles.title}>
              {t("git.title", { workspace: getWorkspaceDisplayName(workspace) })}
            </Text>
            <Text numberOfLines={1} style={styles.subtitle}>
              {workspace.gitRoot ?? workspace.path}
            </Text>
          </View>
          <Button
            accessibilityLabel={t("git.refresh")}
            icon="refresh"
            iconOnly
            style={styles.iconButton}
            onPress={onRefresh}
          >
            {t("common.refresh")}
          </Button>
        </View>
      ) : null}

      {!workspace.isGitRepository ? (
        <Card style={styles.card}>
          <Text style={styles.cardTitle}>{t("git.noRepository")}</Text>
          <Text style={styles.meta}>{t("git.noRepositoryHint")}</Text>
        </Card>
      ) : mode === "review" ? (
        <GitReviewView
          diff={diff}
          file={selectedFile}
          files={reviewFiles}
          loading={loading}
          scope={scope}
          selectedIndex={Math.max(0, selectedIndex)}
          onBackToOverview={() => setMode("overview")}
          onMoveSelection={moveSelection}
          onSelectFile={selectFile}
          onSelectScope={selectScope}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Card style={styles.card}>
            <View style={styles.summaryHeader}>
              <View style={styles.summaryTitleArea}>
                <Text style={styles.cardTitle}>
                  {status?.branch ?? t("git.unknownBranch")}
                </Text>
                <Text style={styles.meta}>
                  {status?.headSha ? `HEAD ${status.headSha}` : t("git.headUnknown")}
                  {typeof status?.ahead === "number"
                    ? ` · ${t("git.ahead", { count: status.ahead })}`
                    : ""}
                  {typeof status?.behind === "number"
                    ? ` · ${t("git.behind", { count: status.behind })}`
                    : ""}
                </Text>
              </View>
              <Badge
                backgroundColor={status?.hasChanges ? colors.warningSoft : colors.successSoft}
                color={status?.hasChanges ? colors.warning : colors.success}
              >
                {status?.hasChanges ? t("git.changes") : t("git.clean")}
              </Badge>
            </View>

            <View style={styles.statsRow}>
              <StatPill label={t("git.summary.files")} value={String(files.length)} />
              <StatPill label={t("git.summary.additions")} tone="add" value={`+${summary.additions}`} />
              <StatPill label={t("git.summary.deletions")} tone="delete" value={`-${summary.deletions}`} />
            </View>

            <Button
              disabled={files.length === 0}
              icon="git"
              style={[styles.fullDiffButton, files.length === 0 && styles.disabled]}
              tone="primary"
              onPress={() => openReview("all")}
            >
              {t("git.reviewChanges")}
            </Button>
          </Card>

          {files.length > 0 ? (
            <View style={styles.fileStack}>
              <FileSection
                files={files.filter((file) => file.staged)}
                scope="staged"
                title={t("git.scope.staged")}
                onOpen={(file) => openReview("staged", file.path)}
              />
              <FileSection
                files={files.filter((file) => file.unstaged && file.status !== "untracked")}
                scope="unstaged"
                title={t("git.scope.unstaged")}
                onOpen={(file) => openReview("unstaged", file.path)}
              />
              <FileSection
                files={files.filter((file) => file.status === "untracked")}
                scope="untracked"
                title={t("git.scope.untracked")}
                onOpen={(file) => openReview("untracked", file.path)}
              />
            </View>
          ) : status ? (
            <Text style={styles.empty}>{t("git.noChangedFiles")}</Text>
          ) : loading ? (
            <Text style={styles.empty}>{t("git.loadingStatus")}</Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

function GitReviewView({
  diff,
  file,
  files,
  loading,
  scope,
  selectedIndex,
  onBackToOverview,
  onMoveSelection,
  onSelectFile,
  onSelectScope,
}: {
  diff?: GitDiffPayload;
  file?: ChangedFile;
  files: ChangedFile[];
  loading?: boolean;
  scope: GitDiffScope;
  selectedIndex: number;
  onBackToOverview(): void;
  onMoveSelection(offset: number): void;
  onSelectFile(file: ChangedFile): void;
  onSelectScope(scope: GitDiffScope): void;
}): JSX.Element {
  const { t } = useTranslation();
  const diffLines = parseDiffLines(diff?.diff ?? "");
  const diffMatchesSelection = Boolean(
    file && diff?.relativePath === file.path && (diff.scope ?? "unstaged") === scope,
  );
  const hasDiff = diffMatchesSelection && diffLines.length > 0;

  return (
    <View style={styles.reviewScreen}>
      <View style={styles.reviewHeader}>
        <Pressable
          accessibilityRole="button"
          style={styles.reviewBackButton}
          onPress={onBackToOverview}
        >
          <Text style={styles.reviewBackText}>‹ {t("git.overview")}</Text>
        </Pressable>
        <View style={styles.reviewTitleArea}>
          <Text numberOfLines={1} style={styles.reviewTitle}>
            {file ? basename(file.path) : t("git.review.title")}
          </Text>
          <Text style={styles.meta}>
            {files.length > 0
              ? t("git.review.progress", {
                  current: Math.min(selectedIndex + 1, files.length),
                  total: files.length,
                })
              : t("git.review.noFiles")}
          </Text>
        </View>
        <FileStatsBadge file={file} scope={scope} />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scopeScroller}
        contentContainerStyle={styles.scopeRow}
      >
        {SCOPE_ORDER.map((item) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: item === scope }}
            key={item}
            style={[styles.scopeChip, item === scope && styles.scopeChipActive]}
            onPress={() => onSelectScope(item)}
          >
            <Text style={[styles.scopeChipText, item === scope && styles.scopeChipTextActive]}>
              {t(`git.scope.${item}`)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {files.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.fileChipScroller}
          contentContainerStyle={styles.fileChipRow}
        >
          {files.map((item) => {
            const selected = item.path === file?.path;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={item.path}
                style={[styles.fileChip, selected && styles.fileChipActive]}
                onPress={() => onSelectFile(item)}
              >
                <Text numberOfLines={1} style={[styles.fileChipText, selected && styles.fileChipTextActive]}>
                  {basename(item.path)}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      <Card style={styles.reviewFileCard}>
        {file ? (
          <>
            <View style={styles.reviewFileHeader}>
              <View style={styles.reviewScopeBadge}>
                <Text style={styles.reviewScopeBadgeText}>
                  {getReviewScopeBadgeLabel(file, scope, t)}
                </Text>
              </View>
              <View style={styles.reviewFileTitleArea}>
                <Text numberOfLines={1} style={styles.reviewFileTitle}>{file.path}</Text>
              </View>
            </View>
            {loading || !diffMatchesSelection ? (
              <ReviewEmptyMessage message={t("git.loadingDiff")} />
            ) : hasDiff ? (
              <ScrollView contentContainerStyle={styles.diffList}>
                {diffLines.map((line, index) => (
                  <DiffRow index={index} key={`${index}:${line.content}`} line={line} />
                ))}
              </ScrollView>
            ) : (
              <ReviewEmptyMessage
                message={file.status === "untracked" ? t("git.untrackedNoDiff") : t("git.noDiff")}
              />
            )}
          </>
        ) : (
          <ReviewEmptyMessage message={t("git.review.noFiles")} />
        )}
      </Card>

      <View style={styles.reviewActions}>
        <Pressable
          accessibilityRole="button"
          disabled={selectedIndex <= 0}
          style={[styles.reviewNavButton, selectedIndex <= 0 && styles.disabled]}
          onPress={() => onMoveSelection(-1)}
        >
          <Text style={styles.reviewNavText}>{t("git.review.previous")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={selectedIndex >= files.length - 1}
          style={[styles.reviewNavButton, styles.reviewNavButtonPrimary, selectedIndex >= files.length - 1 && styles.disabled]}
          onPress={() => onMoveSelection(1)}
        >
          <Text style={styles.reviewNavTextPrimary}>{t("git.review.next")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function FileSection({
  files,
  scope,
  title,
  onOpen,
}: {
  files: ChangedFile[];
  scope: FileStatsScope;
  title: string;
  onOpen(file: ChangedFile): void;
}): JSX.Element | null {
  if (files.length === 0) {
    return null;
  }
  return (
    <View style={styles.fileGroup}>
      <View style={styles.groupHeader}>
        <Text style={styles.groupLabel}>{title}</Text>
        <Text style={styles.groupCount}>{files.length}</Text>
      </View>
      {files.map((file) => (
        <FileRow
          file={file}
          key={`${title}:${file.path}`}
          scope={scope}
          onPress={() => onOpen(file)}
        />
      ))}
    </View>
  );
}

function FileRow({
  file,
  scope,
  onPress,
}: {
  file: ChangedFile;
  scope: FileStatsScope;
  onPress(): void;
}): JSX.Element {
  const status = getScopedStatus(file, scope);
  const statusColor = STATUS_COLOR[status];
  return (
    <Pressable style={styles.fileRow} onPress={onPress}>
      <View style={[styles.fileIndicator, { backgroundColor: statusColor }]} />
      <View style={styles.fileInfo}>
        <Text numberOfLines={1} style={styles.filePath}>{file.path}</Text>
        <Text numberOfLines={1} style={styles.fileMeta}>{file.oldPath ?? dirname(file.path)}</Text>
      </View>
      <Badge backgroundColor={colors.neutralSoft} color={statusColor}>
        {statusCode(status)}
      </Badge>
      <FileStats file={file} scope={scope} />
    </Pressable>
  );
}

function StatPill({ label, tone, value }: { label: string; tone?: "add" | "delete"; value: string }): JSX.Element {
  return (
    <View style={styles.statPill}>
      <Text style={[styles.statValue, tone === "add" && styles.addText, tone === "delete" && styles.deleteText]}>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function FileStats({ file, scope }: { file: ChangedFile; scope: FileStatsScope }): JSX.Element {
  const stats = getScopedStats(file, scope);
  return (
    <View style={styles.fileStats}>
      <Text style={styles.addText}>+{stats.additions}</Text>
      <Text style={styles.deleteText}>-{stats.deletions}</Text>
    </View>
  );
}

function FileStatsBadge({
  file,
  scope,
}: {
  file?: ChangedFile;
  scope: FileStatsScope;
}): JSX.Element | null {
  if (!file) {
    return null;
  }
  const stats = getScopedStats(file, scope);
  return (
    <View style={styles.fileStatsBadge}>
      <Text style={styles.addText}>+{stats.additions}</Text>
      <Text style={styles.deleteText}>-{stats.deletions}</Text>
    </View>
  );
}

function ReviewEmptyMessage({ message }: { message: string }): JSX.Element {
  return (
    <View style={styles.reviewEmptyState}>
      <Text style={styles.reviewEmptyText}>{message}</Text>
    </View>
  );
}

function DiffRow({ index, line }: { index: number; line: DiffLine }): JSX.Element {
  return (
    <View style={[styles.diffRow, getDiffRowStyle(line.type)]}>
      <Text style={styles.diffLineNo}>{line.type === "hunk" || line.type === "meta" ? "" : index + 1}</Text>
      <Text selectable style={[styles.diffText, getDiffTextStyle(line.type)]}>{line.content || " "}</Text>
    </View>
  );
}

function noop(): void {}

function isFileInScope(file: ChangedFile, scope: GitDiffScope): boolean {
  if (scope === "all") {
    return true;
  }
  if (scope === "staged") {
    return Boolean(file.staged);
  }
  if (scope === "untracked") {
    return file.status === "untracked";
  }
  return Boolean(file.unstaged) && file.status !== "untracked";
}

function getChangeSummary(files: ChangedFile[]): { additions: number; deletions: number } {
  return files.reduce(
    (summary, file) => ({
      additions: summary.additions + (file.additions ?? 0),
      deletions: summary.deletions + (file.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  );
}

function getReviewScopeBadgeLabel(
  file: ChangedFile,
  scope: FileStatsScope,
  t: (key: string) => string,
): string {
  if (scope !== "all") {
    return t(`git.scope.${scope}`);
  }
  if (file.status === "untracked") {
    return t("git.scope.untracked");
  }
  if (file.staged && !file.unstaged) {
    return t("git.scope.staged");
  }
  if (file.unstaged && !file.staged) {
    return t("git.scope.unstaged");
  }
  return t("git.scope.all");
}

function getScopedStats(
  file: ChangedFile,
  scope: FileStatsScope,
): { additions: number; deletions: number } {
  if (scope === "staged") {
    return {
      additions: file.stagedAdditions ?? 0,
      deletions: file.stagedDeletions ?? 0,
    };
  }
  if (scope === "unstaged" || scope === "untracked") {
    return {
      additions: file.unstagedAdditions ?? 0,
      deletions: file.unstagedDeletions ?? 0,
    };
  }
  return {
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
  };
}

function getScopedStatus(file: ChangedFile, scope: FileStatsScope): FileStatus {
  if (file.status === "untracked") {
    return "untracked";
  }
  const code = scope === "staged" ? file.indexStatus : file.worktreeStatus;
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  return file.status;
}

function statusCode(status: FileStatus): string {
  if (status === "untracked") return "?";
  if (status === "renamed") return "R";
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  return "M";
}

function parseDiffLines(diff: string): DiffLine[] {
  return diff
    .split("\n")
    .filter((line) => line.length > 0)
    .map((content) => ({ content, type: getDiffLineType(content) }));
}

function getDiffLineType(content: string): DiffLineType {
  if (content.startsWith("@@")) return "hunk";
  if (content.startsWith("diff --git") || content.startsWith("index ") || content.startsWith("---") || content.startsWith("+++") || content.startsWith("## ")) return "meta";
  if (content.startsWith("+")) return "add";
  if (content.startsWith("-")) return "delete";
  return "context";
}

interface DiffLine {
  content: string;
  type: DiffLineType;
}

function getWorkspaceDisplayName(workspace: WorkspaceDefinition): string {
  const normalized = workspace.path.replace(/\/+$/g, "");
  const fallback = normalized.split("/").filter(Boolean).at(-1) ?? "Workspace";
  return workspace.name?.trim() || fallback;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function dirname(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
}

function getDiffRowStyle(type: DiffLineType) {
  if (type === "add") return styles.diffRowAdd;
  if (type === "delete") return styles.diffRowDelete;
  if (type === "hunk") return styles.diffRowHunk;
  if (type === "meta") return styles.diffRowMeta;
  return undefined;
}

function getDiffTextStyle(type: DiffLineType) {
  if (type === "add") return styles.diffTextAdd;
  if (type === "delete") return styles.diffTextDelete;
  if (type === "hunk") return styles.diffTextHunk;
  if (type === "meta") return styles.diffTextMeta;
  return undefined;
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
  card: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  summaryHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  summaryTitleArea: {
    flex: 1,
    minWidth: 0,
  },
  cardTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: "800",
  },
  meta: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
  statsRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  statPill: {
    flex: 1,
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    padding: spacing.sm,
    backgroundColor: colors.surfaceRaised,
  },
  statValue: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: "900",
  },
  statLabel: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: "700",
    marginTop: 2,
  },
  fullDiffButton: {
    minHeight: 40,
  },
  disabled: {
    opacity: 0.55,
  },
  fileStack: {
    gap: spacing.lg,
  },
  fileGroup: {
    gap: spacing.sm,
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  groupLabel: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  groupCount: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: "800",
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
  },
  fileIndicator: {
    width: 4,
    alignSelf: "stretch",
    borderRadius: 2,
  },
  fileInfo: {
    flex: 1,
    minWidth: 0,
  },
  filePath: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: "800",
  },
  fileMeta: {
    color: colors.textDim,
    fontSize: 11,
    marginTop: 2,
  },
  fileStats: {
    minWidth: 52,
    alignItems: "flex-end",
    gap: 2,
  },
  addText: {
    color: colors.success,
    fontSize: 12,
    fontWeight: "900",
  },
  deleteText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: "900",
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  reviewEmptyState: {
    flex: 1,
    minHeight: 160,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
    alignItems: "center",
    justifyContent: "center",
  },
  reviewEmptyText: {
    maxWidth: 280,
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  reviewScreen: {
    flex: 1,
    gap: spacing.sm,
  },
  reviewHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 36,
  },
  reviewBackButton: {
    minHeight: 32,
    paddingHorizontal: spacing.md,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  reviewBackText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "900",
  },
  reviewTitleArea: {
    flex: 1,
    minWidth: 0,
  },
  reviewTitle: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: "900",
  },
  scopeScroller: {
    flexGrow: 0,
    maxHeight: 34,
  },
  scopeRow: {
    alignItems: "center",
    gap: spacing.sm,
    paddingRight: spacing.xl,
  },
  scopeChip: {
    borderColor: colors.borderSubtle,
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.surface,
  },
  scopeChipActive: {
    borderColor: colors.success,
    backgroundColor: colors.successSoft,
  },
  scopeChipText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "800",
  },
  scopeChipTextActive: {
    color: colors.success,
  },
  fileChipScroller: {
    flexGrow: 0,
    maxHeight: 36,
  },
  fileChipRow: {
    alignItems: "center",
    gap: spacing.sm,
    paddingRight: spacing.xl,
  },
  fileChip: {
    maxWidth: 132,
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: colors.surfaceRaised,
  },
  fileChipActive: {
    borderColor: colors.success,
    backgroundColor: "#1a3028",
  },
  fileChipText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "800",
  },
  fileChipTextActive: {
    color: colors.textPrimary,
  },
  reviewFileCard: {
    flex: 1,
    minHeight: 280,
    padding: 0,
    overflow: "hidden",
  },
  reviewFileHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderBottomColor: colors.borderSubtle,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surfaceRaised,
  },
  reviewScopeBadge: {
    borderRadius: radii.sm,
    borderColor: "rgba(48, 196, 141, 0.38)",
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 7,
    paddingVertical: 3,
    backgroundColor: colors.successSoft,
  },
  reviewScopeBadgeText: {
    color: colors.success,
    fontSize: 11,
    fontWeight: "900",
  },
  reviewFileTitleArea: {
    flex: 1,
    minWidth: 0,
  },
  reviewFileTitle: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: "900",
  },
  diffList: {
    paddingVertical: 4,
  },
  diffRow: {
    flexDirection: "row",
    gap: 6,
    paddingVertical: 1,
    paddingHorizontal: 6,
  },
  diffRowAdd: {
    backgroundColor: "rgba(48, 196, 141, 0.12)",
  },
  diffRowDelete: {
    backgroundColor: "rgba(255, 107, 107, 0.12)",
  },
  diffRowHunk: {
    backgroundColor: "rgba(126, 184, 247, 0.14)",
  },
  diffRowMeta: {
    backgroundColor: "rgba(148, 163, 173, 0.08)",
  },
  diffLineNo: {
    width: 28,
    color: colors.textDim,
    fontSize: 10,
    fontVariant: ["tabular-nums"],
    textAlign: "right",
  },
  diffText: {
    flex: 1,
    color: colors.textSecondary,
    fontFamily: "Menlo",
    fontSize: 11,
    lineHeight: 15,
  },
  diffTextAdd: {
    color: "#d7ffe9",
  },
  diffTextDelete: {
    color: "#ffd7d7",
  },
  diffTextHunk: {
    color: "#b9d9ff",
    fontWeight: "800",
  },
  diffTextMeta: {
    color: colors.textMuted,
  },
  reviewActions: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  reviewNavButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: radii.sm,
    borderColor: colors.borderSubtle,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  reviewNavButtonPrimary: {
    borderColor: colors.success,
    backgroundColor: colors.success,
  },
  reviewNavText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: "900",
  },
  reviewNavTextPrimary: {
    color: colors.successText,
    fontSize: 14,
    fontWeight: "900",
  },
  fileStatsBadge: {
    minWidth: 58,
    borderRadius: radii.sm,
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    alignItems: "flex-end",
    backgroundColor: colors.surfaceRaised,
    gap: 1,
  },
});
