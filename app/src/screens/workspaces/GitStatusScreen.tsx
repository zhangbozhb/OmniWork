import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Clipboard,
  Dimensions,
  type GestureResponderEvent,
  PanResponder,
  RefreshControl,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";

import type {
  FilesReadPayload,
  GitDiffPayload,
  GitDiffScope,
  WorkspaceDefinition,
  WorkspaceGitStatus,
} from "@omniwork/protocol-ts";
import { isSupportedTextFilePath } from "@omniwork/protocol-ts";
import { Badge, Button, Card } from "../../ui/components";
import { colors, radii, spacing } from "../../ui/theme";
import { toGitDiffCacheKey } from "../../features/workspaces/workspaceKeys";

type FileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";
type GitViewMode = "overview" | "review";
type ChangedFile = WorkspaceGitStatus["files"][number];
type DiffLineType = "add" | "delete" | "hunk" | "meta" | "context";
type FileStatsScope = GitDiffScope;
type CopyNotice = {
  message: string;
  pageY?: number;
};

const STATUS_COLOR: Record<FileStatus, string> = {
  modified: colors.warning,
  added: colors.success,
  deleted: colors.danger,
  renamed: "#7eb8f7",
  untracked: colors.textMuted,
};

const SCOPE_ORDER: GitDiffScope[] = ["all", "unstaged", "staged", "untracked"];
const REVIEW_SWIPE_ACTIVATE_PX = 36;
const REVIEW_SWIPE_COMMIT_PX = 72;
const REVIEW_SWIPE_MAX_DRAG_PX = 180;
const REVIEW_SWIPE_EXIT_PX = 420;
const REVIEW_SWIPE_VERTICAL_RATIO = 1.6;
const COPY_NOTICE_HEIGHT = 80;
const COPY_NOTICE_GAP = 60;

export interface GitStatusScreenProps {
  workspace: WorkspaceDefinition;
  status?: WorkspaceGitStatus;
  diff?: GitDiffPayload;
  diffCache?: Record<string, GitDiffPayload>;
  fileContentCache?: Record<string, FilesReadPayload>;
  fileContentLoadingKeys?: Record<string, boolean>;
  loading?: boolean;
  embedded?: boolean;
  initialMode?: GitViewMode;
  initialPath?: string;
  initialScope?: GitDiffScope;
  onBack?(): void;
  onRefresh(): void;
  onOpenDiff(relativePath?: string, scope?: GitDiffScope): void;
  onOpenReview?(relativePath?: string, scope?: GitDiffScope): void;
  onEditFile?(relativePath: string): void;
  onPrefetchDiff?(relativePath?: string, scope?: GitDiffScope): void;
  onReadFileContent?(relativePath: string): void;
}

export function GitStatusScreen({
  workspace,
  status,
  diff,
  diffCache = {},
  fileContentCache = {},
  fileContentLoadingKeys = {},
  loading,
  embedded = false,
  initialMode = "overview",
  initialPath,
  initialScope = "all",
  onBack,
  onRefresh,
  onOpenDiff,
  onOpenReview,
  onEditFile,
  onPrefetchDiff = onOpenDiff,
  onReadFileContent = noop,
}: GitStatusScreenProps): JSX.Element {
  const { t } = useTranslation();
  const screenRef = useRef<View>(null);
  const [mode, setMode] = useState<GitViewMode>(initialMode);
  const [scope, setScope] = useState<GitDiffScope>(initialScope);
  const [selectedPath, setSelectedPath] = useState<string | undefined>(
    initialPath,
  );
  const [copyNotice, setCopyNotice] = useState<CopyNotice | undefined>();
  const [screenHeight, setScreenHeight] = useState(
    Dimensions.get("window").height,
  );
  const [screenPageY, setScreenPageY] = useState(0);
  const copyNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const files = status?.files ?? [];
  const reviewFiles = useMemo(
    () => files.filter((file) => isFileInScope(file, scope)),
    [files, scope],
  );
  const selectedIndex = reviewFiles.findIndex((file) => file.path === selectedPath);
  const selectedFile = selectedIndex >= 0 ? reviewFiles[selectedIndex] : reviewFiles[0];
  const summary = getChangeSummary(files);
  const selectedDiff = getCachedDiff(diffCache, diff, selectedFile, scope);

  useEffect(() => {
    setMode(initialMode);
    setScope(initialScope);
    setSelectedPath(initialPath);
  }, [initialMode, initialPath, initialScope]);

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
      return;
    }
    if (!loading && !selectedDiff) {
      onOpenDiff(selectedFile.path, scope);
    }
  }, [loading, mode, onOpenDiff, scope, selectedDiff, selectedFile, selectedPath]);

  useEffect(
    () => () => {
      if (copyNoticeTimerRef.current) {
        clearTimeout(copyNoticeTimerRef.current);
      }
    },
    [],
  );

  function copyText(text: string, notice: string, pageY?: number): void {
    Clipboard.setString(text);
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

  function openReview(nextScope: GitDiffScope, path?: string): void {
    const nextFiles = files.filter((file) => isFileInScope(file, nextScope));
    const nextPath = path ?? nextFiles[0]?.path;
    if (onOpenReview) {
      onOpenReview(nextPath, nextScope);
      return;
    }
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

  const overviewContent = (
    <>
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
            onCopyText={copyText}
            onOpen={(file) => openReview("staged", file.path)}
          />
          <FileSection
            files={files.filter((file) => file.unstaged && file.status !== "untracked")}
            scope="unstaged"
            title={t("git.scope.unstaged")}
            onCopyText={copyText}
            onOpen={(file) => openReview("unstaged", file.path)}
          />
          <FileSection
            files={files.filter((file) => file.status === "untracked")}
            scope="untracked"
            title={t("git.scope.untracked")}
            onCopyText={copyText}
            onOpen={(file) => openReview("untracked", file.path)}
          />
        </View>
      ) : status ? (
        <Text style={styles.empty}>{t("git.noChangedFiles")}</Text>
      ) : loading ? (
        <Text style={styles.empty}>{t("git.loadingStatus")}</Text>
      ) : null}
    </>
  );

  return (
    <View
      ref={screenRef}
      style={[styles.screen, embedded && styles.embeddedScreen]}
      onLayout={handleScreenLayout}
    >
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
          diffCache={diffCache}
          fileContentCache={fileContentCache}
          fileContentLoadingKeys={fileContentLoadingKeys}
          file={selectedFile}
          files={reviewFiles}
          loading={loading}
          scope={scope}
          selectedIndex={Math.max(0, selectedIndex)}
          onCopyText={copyText}
          onMoveSelection={moveSelection}
          onPrefetchDiff={onPrefetchDiff}
          onReadFileContent={onReadFileContent}
          onEditFile={onEditFile}
          onSelectFile={selectFile}
          onSelectScope={selectScope}
        />
      ) : embedded ? (
        <View style={styles.content}>{overviewContent}</View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={Boolean(loading)}
              tintColor={colors.success}
              onRefresh={onRefresh}
            />
          }
        >
          {overviewContent}
        </ScrollView>
      )}
      {copyNotice ? (
        <CopyNoticeToast
          notice={copyNotice}
          screenHeight={screenHeight}
          screenPageY={screenPageY}
        />
      ) : null}
    </View>
  );
}

function GitReviewView({
  diff,
  diffCache,
  fileContentCache,
  fileContentLoadingKeys,
  file,
  files,
  loading,
  scope,
  selectedIndex,
  onCopyText,
  onMoveSelection,
  onPrefetchDiff,
  onReadFileContent,
  onEditFile,
  onSelectFile,
  onSelectScope,
}: {
  diff?: GitDiffPayload;
  diffCache: Record<string, GitDiffPayload>;
  fileContentCache: Record<string, FilesReadPayload>;
  fileContentLoadingKeys: Record<string, boolean>;
  file?: ChangedFile;
  files: ChangedFile[];
  loading?: boolean;
  scope: GitDiffScope;
  selectedIndex: number;
  onCopyText(text: string, notice: string, pageY?: number): void;
  onMoveSelection(offset: number): void;
  onPrefetchDiff(relativePath?: string, scope?: GitDiffScope): void;
  onReadFileContent(relativePath: string): void;
  onEditFile?(relativePath: string): void;
  onSelectFile(file: ChangedFile): void;
  onSelectScope(scope: GitDiffScope): void;
}): JSX.Element {
  const { t } = useTranslation();
  const [cardWidth, setCardWidth] = useState(0);
  const previousFile =
    selectedIndex > 0 ? files[selectedIndex - 1] : undefined;
  const nextFile =
    selectedIndex >= 0 && selectedIndex < files.length - 1
      ? files[selectedIndex + 1]
      : undefined;
  const currentDiff = getCachedDiff(diffCache, diff, file, scope);
  const previousDiff = getCachedDiff(diffCache, undefined, previousFile, scope);
  const nextDiff = getCachedDiff(diffCache, undefined, nextFile, scope);
  const currentFileContent = file ? fileContentCache[file.path] : undefined;
  const currentFileContentLoading = Boolean(
    file && fileContentLoadingKeys[file.path],
  );
  const currentDiffMatchesSelection = Boolean(
    file &&
      currentDiff?.relativePath === file.path &&
      (currentDiff.scope ?? "unstaged") === scope,
  );
  const swipeTranslateX = useRef(new Animated.Value(0)).current;
  const canMovePrevious = files.length > 1 && selectedIndex > 0;
  const canMoveNext =
    files.length > 1 && selectedIndex >= 0 && selectedIndex < files.length - 1;
  const carouselStyle = {
    transform: [
      {
        translateX: swipeTranslateX.interpolate({
          inputRange: [-REVIEW_SWIPE_MAX_DRAG_PX, 0, REVIEW_SWIPE_MAX_DRAG_PX],
          outputRange: [
            -cardWidth - REVIEW_SWIPE_MAX_DRAG_PX,
            -cardWidth,
            -cardWidth + REVIEW_SWIPE_MAX_DRAG_PX,
          ],
          extrapolate: "clamp" as const,
        }),
      },
    ],
  };

  useEffect(() => {
    swipeTranslateX.setValue(0);
  }, [file?.path, scope, swipeTranslateX]);

  useEffect(() => {
    for (const adjacentFile of [previousFile, nextFile]) {
      if (
        adjacentFile &&
        !getCachedDiff(diffCache, undefined, adjacentFile, scope)
      ) {
        onPrefetchDiff(adjacentFile.path, scope);
      }
    }
  }, [diffCache, nextFile, onPrefetchDiff, previousFile, scope]);

  useEffect(() => {
    if (
      file &&
      shouldUseUntrackedFileContentFallback(file, currentDiff, scope) &&
      canReadUntrackedFileContent(file) &&
      !currentFileContent &&
      !currentFileContentLoading
    ) {
      onReadFileContent(file.path);
    }
  }, [
    currentDiff,
    currentFileContent,
    currentFileContentLoading,
    file,
    onReadFileContent,
    scope,
  ]);

  function resetSwipeCard(): void {
    Animated.spring(swipeTranslateX, {
      toValue: 0,
      damping: 18,
      stiffness: 180,
      mass: 0.8,
      useNativeDriver: true,
    }).start();
  }

  function commitSwipeCard(offset: -1 | 1): void {
    Animated.timing(swipeTranslateX, {
      toValue:
        offset > 0
          ? -(cardWidth || REVIEW_SWIPE_EXIT_PX)
          : cardWidth || REVIEW_SWIPE_EXIT_PX,
      duration: 180,
      useNativeDriver: true,
    }).start(({ finished }) => {
      swipeTranslateX.setValue(0);
      if (finished) {
        onMoveSelection(offset);
      }
    });
  }

  const swipeResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          files.length > 1 && shouldActivateReviewSwipe(gesture.dx, gesture.dy),
        onPanResponderGrant: () => {
          swipeTranslateX.stopAnimation();
        },
        onPanResponderMove: (_event, gesture) => {
          const minDx = canMoveNext ? -REVIEW_SWIPE_MAX_DRAG_PX : 0;
          const maxDx = canMovePrevious ? REVIEW_SWIPE_MAX_DRAG_PX : 0;
          swipeTranslateX.setValue(
            clamp(gesture.dx, minDx, maxDx),
          );
        },
        onPanResponderRelease: (_event, gesture) => {
          if (!shouldCommitReviewSwipe(gesture.dx, gesture.dy)) {
            resetSwipeCard();
            return;
          }
          if (gesture.dx < 0 && canMoveNext) {
            commitSwipeCard(1);
          } else if (gesture.dx > 0 && canMovePrevious) {
            commitSwipeCard(-1);
          } else {
            resetSwipeCard();
          }
        },
        onPanResponderTerminate: resetSwipeCard,
        onPanResponderTerminationRequest: () => true,
      }),
    [
      canMoveNext,
      canMovePrevious,
      files.length,
      onMoveSelection,
      swipeTranslateX,
    ],
  );

  return (
    <View style={styles.reviewScreen}>
      <View style={styles.reviewHeader}>
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

      <View
        style={styles.reviewCarouselViewport}
        onLayout={(event) => setCardWidth(event.nativeEvent.layout.width)}
        {...swipeResponder.panHandlers}
      >
        {file && cardWidth > 0 ? (
          <Animated.View
            style={[
              styles.reviewCarouselTrack,
              { width: cardWidth * 3 },
              carouselStyle,
            ]}
          >
            <ReviewDiffCard
              active={false}
              cardWidth={cardWidth}
              diff={previousDiff}
              file={previousFile}
              fileContent={undefined}
              fileContentLoading={false}
              loading={Boolean(previousFile && !previousDiff)}
              scope={scope}
              onCopyText={onCopyText}
            />
            <ReviewDiffCard
              active
              cardWidth={cardWidth}
              diff={currentDiff}
              file={file}
              fileContent={currentFileContent}
              fileContentLoading={currentFileContentLoading}
              loading={loading || !currentDiffMatchesSelection}
              scope={scope}
              onCopyText={onCopyText}
              onEditFile={onEditFile}
            />
            <ReviewDiffCard
              active={false}
              cardWidth={cardWidth}
              diff={nextDiff}
              file={nextFile}
              fileContent={undefined}
              fileContentLoading={false}
              loading={Boolean(nextFile && !nextDiff)}
              scope={scope}
              onCopyText={onCopyText}
            />
          </Animated.View>
        ) : (
          <Card style={styles.reviewFileCard}>
            <ReviewEmptyMessage message={t("git.review.noFiles")} />
          </Card>
        )}
      </View>
    </View>
  );
}

function ReviewDiffCard({
  active,
  cardWidth,
  diff,
  file,
  fileContent,
  fileContentLoading,
  loading,
  scope,
  onCopyText,
  onEditFile,
}: {
  active: boolean;
  cardWidth: number;
  diff?: GitDiffPayload;
  file?: ChangedFile;
  fileContent?: FilesReadPayload;
  fileContentLoading?: boolean;
  loading?: boolean;
  scope: GitDiffScope;
  onCopyText(text: string, notice: string, pageY?: number): void;
  onEditFile?(relativePath: string): void;
}): JSX.Element {
  const { t } = useTranslation();
  const diffMatchesSelection = Boolean(
    file && diff?.relativePath === file.path && (diff.scope ?? "unstaged") === scope,
  );
  const diffLines = parseDiffLines(diff?.diff ?? "");
  const hasDiff = diffMatchesSelection && diffLines.length > 0;
  const useUntrackedFileContentFallback = shouldUseUntrackedFileContentFallback(
    file,
    diff,
    scope,
  );
  const canReadFileContent = canReadUntrackedFileContent(file);
  const waitingForFileContent =
    useUntrackedFileContentFallback &&
    canReadFileContent &&
    (fileContentLoading || !fileContent);

  return (
    <View
      pointerEvents={active ? "auto" : "none"}
      style={[styles.reviewCardSlot, { width: cardWidth }]}
    >
      <Card style={styles.reviewFileCard}>
        {file ? (
          <>
            <View style={styles.reviewFileHeader}>
              <View style={styles.reviewScopeBadge}>
                <Text style={styles.reviewScopeBadgeText}>
                  {getReviewScopeBadgeLabel(file, scope, t)}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                disabled={!active}
                style={styles.reviewFileTitleArea}
                onLongPress={(event) =>
                  onCopyText(
                    file.path,
                    t("git.copy.pathCopied", { path: file.path }),
                    event.nativeEvent.pageY,
                  )
                }
              >
                <Text numberOfLines={1} style={styles.reviewFileTitle}>
                  {file.path}
                </Text>
              </Pressable>
              {onEditFile &&
              file.status !== "deleted" &&
              isSupportedTextFilePath(file.path) ? (
                <Button
                  accessibilityLabel={t("common.edit")}
                  icon="edit"
                  iconOnly
                  variant="ghost"
                  style={styles.reviewHeaderIconButton}
                  onPress={() => onEditFile(file.path)}
                >
                  {t("common.edit")}
                </Button>
              ) : null}
            </View>
            <View style={styles.reviewSwipeArea}>
              {loading || !diffMatchesSelection ? (
                <ReviewEmptyMessage message={t("git.loadingDiff")} />
              ) : hasDiff ? (
                <ScrollView style={styles.diffScroller} contentContainerStyle={styles.diffList}>
                  {diffLines.map((line, index) => (
                    <DiffRow
                      index={index}
                      key={`${index}:${line.content}`}
                      line={line}
                      onCopyLine={(event) =>
                        onCopyText(
                          line.content,
                          t("git.copy.lineCopied", { line: index + 1 }),
                          event.nativeEvent.pageY,
                        )
                      }
                    />
                  ))}
                </ScrollView>
              ) : useUntrackedFileContentFallback && canReadFileContent && fileContent ? (
                <ReviewFileContent file={fileContent} />
              ) : waitingForFileContent ? (
                <ReviewEmptyMessage message={t("git.loadingFileContent")} />
              ) : useUntrackedFileContentFallback ? (
                <ReviewEmptyMessage message={t("git.fileContent.unsupported")} />
              ) : (
                <ReviewEmptyMessage
                  message={file.status === "untracked" ? t("git.untrackedNoDiff") : t("git.noDiff")}
                />
              )}
            </View>
          </>
        ) : (
          <ReviewEmptyMessage message={t("git.review.noFiles")} />
        )}
      </Card>
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

function FileSection({
  files,
  scope,
  title,
  onCopyText,
  onOpen,
}: {
  files: ChangedFile[];
  scope: FileStatsScope;
  title: string;
  onCopyText(text: string, notice: string, pageY?: number): void;
  onOpen(file: ChangedFile): void;
}): JSX.Element | null {
  const { t } = useTranslation();
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
          onLongPress={(event) =>
            onCopyText(
              file.path,
              t("git.copy.pathCopied", { path: file.path }),
              event.nativeEvent.pageY,
            )
          }
          onPress={() => onOpen(file)}
        />
      ))}
    </View>
  );
}

function FileRow({
  file,
  scope,
  onLongPress,
  onPress,
}: {
  file: ChangedFile;
  scope: FileStatsScope;
  onLongPress(event: GestureResponderEvent): void;
  onPress(): void;
}): JSX.Element {
  const status = getScopedStatus(file, scope);
  const statusColor = STATUS_COLOR[status];
  return (
    <Pressable
      style={styles.fileRow}
      onLongPress={onLongPress}
      onPress={onPress}
    >
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

function ReviewFileContent({ file }: { file: FilesReadPayload }): JSX.Element {
  const { t } = useTranslation();
  if (file.encoding === "binary") {
    return <ReviewEmptyMessage message={t("git.fileContent.binary")} />;
  }
  if (file.encoding === "too_large") {
    return (
      <ReviewEmptyMessage
        message={t("git.fileContent.tooLarge", { size: formatBytes(file.size) })}
      />
    );
  }
  if (!file.content) {
    return <ReviewEmptyMessage message={t("git.fileContent.empty")} />;
  }
  return (
    <ScrollView style={styles.diffScroller} contentContainerStyle={styles.fileContentList}>
      <Text selectable style={styles.fileContentText}>
        {file.content}
      </Text>
    </ScrollView>
  );
}

function DiffRow({
  index,
  line,
  onCopyLine,
}: {
  index: number;
  line: DiffLine;
  onCopyLine(event: GestureResponderEvent): void;
}): JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      style={[styles.diffRow, getDiffRowStyle(line.type)]}
      onLongPress={onCopyLine}
    >
      <Text style={styles.diffLineNo}>{line.type === "hunk" || line.type === "meta" ? "" : index + 1}</Text>
      <Text selectable style={[styles.diffText, getDiffTextStyle(line.type)]}>{line.content || " "}</Text>
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

function getCachedDiff(
  cache: Record<string, GitDiffPayload>,
  fallback: GitDiffPayload | undefined,
  file: ChangedFile | undefined,
  scope: GitDiffScope,
): GitDiffPayload | undefined {
  if (!file) {
    return undefined;
  }
  const cached = cache[toGitDiffCacheKey(file.path, scope)];
  if (cached) {
    return cached;
  }
  if (
    fallback?.relativePath === file.path &&
    (fallback.scope ?? "unstaged") === scope
  ) {
    return fallback;
  }
  return undefined;
}

function shouldUseUntrackedFileContentFallback(
  file: ChangedFile | undefined,
  diff: GitDiffPayload | undefined,
  scope: GitDiffScope,
): boolean {
  return Boolean(
    file &&
      scope === "untracked" &&
      file.status === "untracked" &&
      diff?.relativePath === file.path &&
      (diff.scope ?? "unstaged") === scope &&
      parseDiffLines(diff.diff).length === 0,
  );
}

function canReadUntrackedFileContent(file: ChangedFile | undefined): boolean {
  return Boolean(file && isSupportedTextFilePath(file.path));
}

function shouldActivateReviewSwipe(dx: number, dy: number): boolean {
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  return (
    absDx >= REVIEW_SWIPE_ACTIVATE_PX &&
    absDx >= absDy * REVIEW_SWIPE_VERTICAL_RATIO
  );
}

function shouldCommitReviewSwipe(dx: number, dy: number): boolean {
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  return (
    absDx >= REVIEW_SWIPE_COMMIT_PX &&
    absDx >= absDy * REVIEW_SWIPE_VERTICAL_RATIO
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
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
  reviewCarouselViewport: {
    flex: 1,
    minHeight: 280,
    overflow: "hidden",
  },
  reviewCarouselTrack: {
    flex: 1,
    flexDirection: "row",
  },
  reviewCardSlot: {
    flex: 1,
    paddingHorizontal: 2,
  },
  reviewFileCard: {
    flex: 1,
    minHeight: 280,
    padding: 0,
    overflow: "hidden",
  },
  reviewSwipeArea: {
    flex: 1,
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
  reviewHeaderIconButton: {
    borderWidth: 0,
    minHeight: 30,
    width: 30,
  },
  diffList: {
    paddingVertical: 4,
  },
  diffScroller: {
    flex: 1,
  },
  fileContentList: {
    padding: spacing.md,
  },
  fileContentText: {
    color: colors.textSecondary,
    fontFamily: "Menlo",
    fontSize: 11,
    lineHeight: 16,
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
