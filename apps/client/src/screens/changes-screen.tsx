import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, View } from "react-native";
import type { Locale } from "@linkshell/client-core";
import type { GitDiffFileStatus } from "@linkshell/wire";
import { Button } from "@/components/button";
import { ConnectionBanner } from "@/components/connection-banner";
import { Text, TextInput } from "@/components/fixed-text";
import { Glass } from "@/components/glass";
import { Icon } from "@/components/icon";
import { EmptyState } from "@/components/state-views";
import { DiffView } from "@/components/timeline/tool-call";
import { useActions, useClient, useConnection, useConnectionStatus } from "@/lib/client";
import { gitDiffFileToChange } from "@/lib/coding-ux";
import { fileChanges, type FileChange } from "@/lib/describe";
import { baseName, shortPath } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useLocale, type I18nKey } from "@/lib/locale";
import { DiffStat } from "@/components/diff-stat";
import { colors } from "@/theme/colors";
import { mono, type, radius } from "@/theme/type";

export interface DiffReviewComment {
  key: string;
  filePath: string;
  editIndex: number;
  lineIndex: number;
  lineCode: string;
  comment: string;
}

export function formatDiffReviewPrompt(comments: DiffReviewComment[], cwd?: string, locale: Locale = "zh"): string {
  if (comments.length === 0) return "";
  const header =
    locale === "en"
      ? "Please update the code based on these inline review comments:"
      : locale === "ja"
        ? "以下の行単位コードレビューのコメントに従って修正してください:"
        : "请根据以下行级代码审查意见修改代码：";
  const lines: string[] = [header];
  for (const item of comments) {
    const rel = relativePath(item.filePath, cwd);
    const snippet = item.lineCode.slice(1).trim();
    lines.push(`\n- **\`${rel}\`**${snippet ? ` (\`${snippet.slice(0, 80)}\`)` : ""}：\n  ${item.comment.trim()}`);
  }
  return lines.join("\n");
}

type DiffSourceMode = "session" | "git";

interface FileEntry {
  path: string;
  added: number;
  removed: number;
  kind: FileChange["kind"];
  gitStatus?: GitDiffFileStatus;
  binary?: boolean;
  edits: FileChange[];
}

function collectSessionEdits(items: ReturnType<typeof useItems>): FileEntry[] {
  const byPath = new Map<string, FileEntry>();
  for (const item of items) {
    if (item.kind !== "tool" || item.status === "failed") continue;
    for (const change of fileChanges(item.content)) {
      const entry = byPath.get(change.path) ?? { path: change.path, added: 0, removed: 0, kind: change.kind, edits: [] };
      entry.added += change.added;
      entry.removed += change.removed;
      if (change.kind === "delete") entry.kind = "delete";
      entry.edits.push(change);
      byPath.set(change.path, entry);
    }
  }
  return [...byPath.values()];
}

function useItems(id: string) {
  return useClient((state) => state.views[id]?.items) ?? [];
}

function relativePath(path: string, cwd?: string): string {
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  return shortPath(path);
}

function gitStatusKey(status: GitDiffFileStatus | undefined, kind: FileChange["kind"]): I18nKey | null {
  if (status === "added") return "changes.statusAdded";
  if (status === "deleted") return "changes.statusDeleted";
  if (status === "renamed") return "changes.statusRenamed";
  if (status === "untracked") return "changes.statusUntracked";
  if (status === "modified") return "changes.statusModified";
  if (kind === "add") return "changes.statusAdded";
  if (kind === "delete") return "changes.statusDeleted";
  return null;
}

function FileRow({
  entry,
  first,
  cwd,
  canRevert,
  reverting,
  commentsByKey,
  onSelectLine,
  onRevert,
}: {
  entry: FileEntry;
  first: boolean;
  cwd?: string;
  canRevert: boolean;
  reverting: boolean;
  commentsByKey: Record<string, DiffReviewComment>;
  onSelectLine: (editIndex: number, lineIndex: number, lineText: string) => void;
  onRevert: () => void;
}) {
  const { t, pick } = useLocale();
  const [open, setOpen] = useState(first);
  const badgeKey = gitStatusKey(entry.gitStatus, entry.kind);
  const badgeLabel = badgeKey ? t(badgeKey) : null;
  const fileCommentCount = Object.values(commentsByKey).filter((c) => c.filePath === entry.path).length;
  return (
    <View style={{ borderTopWidth: first ? 0 : 0.5, borderTopColor: colors.separator }}>
      <Pressable
        onPress={() => {
          haptics.selection();
          setOpen((value) => !value);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, paddingHorizontal: 14 }}
      >
        <Icon sf="doc.text" md="description" size={18} color={colors.secondaryLabel} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text numberOfLines={1} style={[type.subhead, { color: colors.label, fontWeight: "600", flexShrink: 1 }]}>
              {baseName(entry.path)}
            </Text>
            {badgeLabel ? (
              <Text
                style={[
                  type.caption2,
                  {
                    color: entry.kind === "add" ? colors.ok : entry.kind === "delete" ? colors.danger : colors.secondaryLabel,
                    fontWeight: "700",
                  },
                ]}
              >
                {badgeLabel}
              </Text>
            ) : null}
            {fileCommentCount > 0 ? (
              <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.chip, backgroundColor: colors.accentSoft }}>
                <Text style={[type.caption2, { color: colors.accent, fontWeight: "700" }]}>
                  {t("changes.reviewCount", { count: fileCommentCount })}
                </Text>
              </View>
            ) : null}
          </View>
          <Text numberOfLines={1} style={[type.caption, { color: colors.tertiaryLabel }]}>
            {relativePath(entry.path, cwd)}
          </Text>
        </View>
        {canRevert ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("changes.revertFile")}
            disabled={reverting}
            hitSlop={6}
            onPress={(e) => {
              e.stopPropagation?.();
              onRevert();
            }}
            style={({ pressed }) => ({
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 999,
              backgroundColor: colors.fill,
              opacity: reverting ? 0.45 : pressed ? 0.65 : 1,
            })}
          >
            {reverting ? (
              <ActivityIndicator size="small" color={colors.danger} />
            ) : (
              <Text style={[type.caption2, { color: colors.danger, fontWeight: "600" }]}>{t("changes.revertFile")}</Text>
            )}
          </Pressable>
        ) : null}
        <Text style={[type.footnote, { fontVariant: ["tabular-nums"], fontWeight: "600" }]}>
          <DiffStat added={entry.added} removed={entry.removed} />
        </Text>
        <Icon sf={open ? "chevron.up" : "chevron.down"} md={open ? "expand_less" : "expand_more"} size={12} color={colors.tertiaryLabel} />
      </Pressable>
      {open ? (
        <View style={{ paddingHorizontal: 10, paddingBottom: 12, gap: 8 }}>
          {entry.binary ? (
            <Text style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 6, paddingVertical: 8 }]}>
              {t("changes.binaryFile")}
            </Text>
          ) : (
            entry.edits.map((edit, editIndex) => {
              const lineComments: Record<number, string> = {};
              for (const item of Object.values(commentsByKey)) {
                if (item.filePath === entry.path && item.editIndex === editIndex) {
                  lineComments[item.lineIndex] = item.comment;
                }
              }
              return (
                <View key={editIndex} style={{ gap: 4 }}>
                  {entry.edits.length > 1 ? (
                    <Text style={[type.caption, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>
                      {pick({
                        zh: `第 ${editIndex + 1} 次修改`,
                        en: `Edit #${editIndex + 1}`,
                        ja: `${editIndex + 1} 回目の変更`,
                      })}
                    </Text>
                  ) : null}
                  <DiffView
                    change={edit}
                    maxLines={400}
                    lineComments={lineComments}
                    onPressLine={(lineIndex, lineText) => onSelectLine(editIndex, lineIndex, lineText)}
                  />
                </View>
              );
            })
          )}
        </View>
      ) : null}
    </View>
  );
}

export function ChangesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ChangesContent sessionId={id} />;
}

export function ChangesContent({ sessionId, embedded = false }: { sessionId: string; embedded?: boolean }) {
  const { locale, t, pick } = useLocale();
  const { link } = useConnection();
  const status = useConnectionStatus();
  const online = status === "online";
  const items = useItems(sessionId);
  const cwd = useClient((state) => state.sessions[sessionId]?.cwd);
  const base = useClient(
    (state) => (state.sessions[sessionId]?.worktree as { branch: string; source: string; base?: string } | undefined)?.base,
  );
  const actions = useActions();

  const [mode, setMode] = useState<DiffSourceMode>("git");
  const [gitFiles, setGitFiles] = useState<FileEntry[]>([]);
  const [gitBranch, setGitBranch] = useState<string | undefined>(undefined);
  const [gitTruncated, setGitTruncated] = useState(false);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitSupported, setGitSupported] = useState(true);
  const [revertingPath, setRevertingPath] = useState<string | null>(null);
  const [wrapUpBusy, setWrapUpBusy] = useState<"commit" | "tests" | null>(null);

  const sessionFiles = useMemo(() => collectSessionEdits(items), [items]);

  const loadGitDiff = useCallback(async () => {
    if (!cwd || !online) return;
    setGitLoading(true);
    try {
      const res = await link.call("git.diff", { cwd, ...(base ? { base } : {}), includeUntracked: true });
      const converted: FileEntry[] = res.files.map((file) => {
        const change = gitDiffFileToChange(file);
        return {
          path: file.path,
          added: file.additions,
          removed: file.deletions,
          kind: change.kind,
          gitStatus: file.status,
          binary: file.binary,
          edits: [change],
        };
      });
      setGitFiles(converted);
      setGitBranch(res.branch);
      setGitTruncated(res.truncated);
      setGitSupported(true);
    } catch {
      setGitSupported(false);
      setMode("session");
    } finally {
      setGitLoading(false);
    }
  }, [base, cwd, link, online]);

  useEffect(() => {
    if (mode === "git") void loadGitDiff();
  }, [loadGitDiff, mode]);

  const files = mode === "git" && gitSupported ? gitFiles : sessionFiles;
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);

  const [commentsByKey, setCommentsByKey] = useState<Record<string, DiffReviewComment>>({});
  const [editingTarget, setEditingTarget] = useState<{
    key: string;
    filePath: string;
    editIndex: number;
    lineIndex: number;
    lineCode: string;
  } | null>(null);
  const [draftComment, setDraftComment] = useState("");
  const [sendingReview, setSendingReview] = useState(false);

  const commentList = useMemo(() => Object.values(commentsByKey), [commentsByKey]);

  const openLineEditor = (filePath: string, editIndex: number, lineIndex: number, lineCode: string) => {
    const key = `${filePath}:${editIndex}:${lineIndex}`;
    const existing = commentsByKey[key]?.comment ?? "";
    setEditingTarget({ key, filePath, editIndex, lineIndex, lineCode });
    setDraftComment(existing);
  };

  const saveLineComment = () => {
    if (!editingTarget) return;
    const trimmed = draftComment.trim();
    setCommentsByKey((prev) => {
      const next = { ...prev };
      if (!trimmed) {
        delete next[editingTarget.key];
      } else {
        next[editingTarget.key] = {
          ...editingTarget,
          comment: trimmed,
        };
      }
      return next;
    });
    haptics.success();
    setEditingTarget(null);
    setDraftComment("");
  };

  const confirmRevertFile = (filePath: string) => {
    if (!cwd || !online || revertingPath) return;
    const displayPath = relativePath(filePath, cwd);
    Alert.alert(
      t("changes.revertConfirmTitle"),
      t("changes.revertConfirmBody", { path: displayPath }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("changes.revertFile"),
          style: "destructive",
          onPress: async () => {
            setRevertingPath(filePath);
            haptics.medium();
            try {
              await link.call("git.revertFile", { cwd, path: filePath });
              haptics.success();
              await loadGitDiff();
            } catch (error) {
              haptics.error();
              Alert.alert(
                pick({ zh: "还原失败", en: "Revert failed", ja: "復元に失敗しました" }),
                error instanceof Error ? error.message : String(error),
              );
            } finally {
              setRevertingPath(null);
            }
          },
        },
      ],
    );
  };

  const dispatchWrapUpAction = async (kind: "commit" | "tests") => {
    if (!online || wrapUpBusy) return;
    setWrapUpBusy(kind);
    haptics.medium();
    try {
      const promptText = kind === "commit" ? t("changes.askCommitPrPrompt") : t("changes.askRunTestsPrompt");
      const delivery = await actions.send(sessionId, [{ type: "text", text: promptText }]);
      if (delivery === "failed") {
        Alert.alert(
          pick({ zh: "发送失败", en: "Failed to send", ja: "送信に失敗しました" }),
          pick({ zh: "未能将指令发送给 Agent。", en: "Could not deliver prompt to Agent.", ja: "エージェントに送信できませんでした。" }),
        );
        return;
      }
      haptics.success();
      if (!embedded) router.back();
    } catch (error) {
      Alert.alert(
        pick({ zh: "发送失败", en: "Failed to send", ja: "送信に失敗しました" }),
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setWrapUpBusy(null);
    }
  };

  const submitAllComments = async () => {
    if (!commentList.length || sendingReview) return;
    setSendingReview(true);
    haptics.medium();
    try {
      const promptText = formatDiffReviewPrompt(commentList, cwd, locale);
      const delivery = await actions.send(sessionId, [{ type: "text", text: promptText }]);
      if (delivery === "failed") {
        Alert.alert(
          pick({ zh: "发送失败", en: "Failed to send", ja: "送信に失敗しました" }),
          pick({ zh: "未能将代码批注发送给 Agent。", en: "Could not deliver review comments to Agent.", ja: "コメントを送信できませんでした。" }),
        );
        return;
      }
      haptics.success();
      setCommentsByKey({});
      if (!embedded) router.back();
    } catch (error) {
      Alert.alert(
        pick({ zh: "发送失败", en: "Failed to send", ja: "送信に失敗しました" }),
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setSendingReview(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentInsetAdjustmentBehavior={embedded ? "never" : "automatic"}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: commentList.length > 0 ? 96 : 24, gap: 12 }}
      >
        <ConnectionBanner />
        {/* Mode Switcher: Real Git Diff vs Session Edits */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <View style={{ flexDirection: "row", backgroundColor: colors.fill, borderRadius: 999, padding: 3, gap: 2 }}>
            {([
              { key: "git" as const, label: t("changes.gitWorkingTree"), disabled: !gitSupported },
              { key: "session" as const, label: t("changes.sessionEdits"), disabled: false },
            ]).map((tab) => {
              const active = mode === tab.key;
              return (
                <Pressable
                  key={tab.key}
                  disabled={tab.disabled}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active, disabled: tab.disabled }}
                  onPress={() => {
                    haptics.selection();
                    setMode(tab.key);
                  }}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 999,
                    backgroundColor: active ? colors.card : "transparent",
                    opacity: tab.disabled ? 0.45 : 1,
                  }}
                >
                  <Text style={[type.footnote, { color: active ? colors.label : colors.secondaryLabel, fontWeight: active ? "600" : "500" }]}>
                    {tab.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {mode === "git" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("common.refresh")}
              onPress={() => void loadGitDiff()}
              style={({ pressed }) => ({
                width: 34,
                height: 34,
                borderRadius: 17,
                backgroundColor: colors.fill,
                alignItems: "center",
                justifyContent: "center",
                opacity: pressed ? 0.65 : 1,
              })}
            >
              {gitLoading ? (
                <ActivityIndicator size="small" color={colors.secondaryLabel} />
              ) : (
                <Icon sf="arrow.clockwise" md="refresh" size={15} color={colors.secondaryLabel} />
              )}
            </Pressable>
          ) : null}
        </View>

        {/* 1-Tap Wrap-Up Actions Bar */}
        {online && (files.length > 0 || sessionFiles.length > 0) ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button
              title={t("changes.askCommitPr")}
              variant="primary"
              size="small"
              icon={{ sf: "arrow.triangle.pull", md: "commit" }}
              busy={wrapUpBusy === "commit"}
              disabled={wrapUpBusy !== null}
              onPress={() => void dispatchWrapUpAction("commit")}
            />
            <Button
              title={t("changes.askRunTests")}
              variant="tonal"
              size="small"
              icon={{ sf: "checkmark.circle", md: "fact_check" }}
              busy={wrapUpBusy === "tests"}
              disabled={wrapUpBusy !== null}
              onPress={() => void dispatchWrapUpAction("tests")}
            />
          </View>
        ) : null}

        {gitLoading && files.length === 0 ? (
          <View style={{ paddingVertical: 40, alignItems: "center" }}>
            <ActivityIndicator color={colors.secondaryLabel} />
          </View>
        ) : files.length === 0 ? (
          <EmptyState
            icon={{ sf: "doc.text.magnifyingglass", md: "difference" }}
            title={t("changes.title")}
            message={t("changes.empty")}
          />
        ) : (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6, paddingHorizontal: 4 }}>
              <Text style={[type.subhead, { color: colors.secondaryLabel }]}>
                {mode === "git" && gitBranch ? `${gitBranch} · ` : ""}
                {pick({
                  zh: `${files.length} 个文件`,
                  en: `${files.length} file${files.length === 1 ? "" : "s"}`,
                  ja: `${files.length} ファイル`,
                })}
                {added || removed ? " · " : ""}
                <Text style={{ fontWeight: "600" }}>
                  <DiffStat added={added} removed={removed} />
                </Text>
              </Text>
              <Text style={[type.caption, { color: colors.tertiaryLabel }]}>{t("changes.addComment")}</Text>
            </View>
            {mode === "git" && gitTruncated ? (
              <Text style={[type.caption, { color: colors.waiting, paddingHorizontal: 4 }]}>{t("changes.truncated")}</Text>
            ) : null}
            <View style={{ backgroundColor: colors.card, borderRadius: radius.card, borderCurve: "continuous", overflow: "hidden" }}>
              {files.map((entry, index) => (
                <FileRow
                  key={`${mode}:${entry.path}`}
                  entry={entry}
                  first={index === 0}
                  cwd={cwd}
                  canRevert={mode === "git" && online && Boolean(cwd)}
                  reverting={revertingPath === entry.path}
                  commentsByKey={commentsByKey}
                  onSelectLine={(editIndex, lineIndex, lineText) =>
                    openLineEditor(entry.path, editIndex, lineIndex, lineText)
                  }
                  onRevert={() => confirmRevertFile(entry.path)}
                />
              ))}
            </View>
          </>
        )}
      </ScrollView>

      {commentList.length > 0 ? (
        <View style={{ position: "absolute", left: 16, right: 16, bottom: 20 }}>
          <Glass style={{ borderRadius: radius.panel, paddingHorizontal: 14, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Icon sf="text.bubble.fill" md="comment" size={16} color={colors.accent} />
            <Text style={[type.subhead, { flex: 1, color: colors.label, fontWeight: "600" }]}>
              {t("changes.reviewCount", { count: commentList.length })}
            </Text>
            <Button
              title={pick({ zh: "清空", en: "Clear", ja: "クリア" })}
              variant="tonal"
              size="small"
              onPress={() => {
                haptics.selection();
                setCommentsByKey({});
              }}
            />
            <Button
              title={t("changes.submitReview", { count: commentList.length })}
              variant="primary"
              size="small"
              busy={sendingReview}
              onPress={() => void submitAllComments()}
            />
          </Glass>
        </View>
      ) : null}

      <Modal visible={!!editingTarget} transparent animationType="fade" onRequestClose={() => setEditingTarget(null)}>
        <Pressable
          onPress={() => setEditingTarget(null)}
          style={{
            flex: 1,
            backgroundColor: "rgba(0,0,0,0.45)",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
        >
          <Pressable
            onPress={() => {}}
            style={{
              width: "100%",
              maxWidth: 380,
              backgroundColor: colors.card,
              borderRadius: radius.panel,
              padding: 18,
              gap: 12,
            }}
          >
            <Text style={[type.headline, { color: colors.label }]}>{t("changes.addComment")}</Text>
            {editingTarget ? (
              <View style={{ backgroundColor: colors.code, borderRadius: radius.control, padding: 8 }}>
                <Text numberOfLines={2} style={{ fontFamily: mono, fontSize: 12, color: colors.codeText }}>
                  {editingTarget.lineCode}
                </Text>
              </View>
            ) : null}
            <TextInput
              value={draftComment}
              onChangeText={setDraftComment}
              placeholder={t("changes.commentPlaceholder")}
              placeholderTextColor={colors.placeholder as string}
              multiline
              autoFocus
              style={{
                fontSize: 15,
                color: colors.label,
                backgroundColor: colors.fill,
                borderRadius: radius.control,
                paddingHorizontal: 12,
                paddingVertical: 10,
                minHeight: 72,
              }}
            />
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
              {editingTarget && commentsByKey[editingTarget.key] ? (
                <Button
                  title={pick({ zh: "删除批注", en: "Delete", ja: "削除" })}
                  variant="tonal"
                  size="small"
                  onPress={() => {
                    setDraftComment("");
                    saveLineComment();
                  }}
                />
              ) : null}
              <Button title={t("changes.cancelComment")} variant="tonal" size="small" onPress={() => setEditingTarget(null)} />
              <Button title={t("changes.saveComment")} variant="primary" size="small" onPress={saveLineComment} />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
