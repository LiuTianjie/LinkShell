import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, View } from "react-native";
import { Button } from "@/components/button";
import { Text, TextInput } from "@/components/fixed-text";
import { Glass } from "@/components/glass";
import { Icon } from "@/components/icon";
import { EmptyState } from "@/components/state-views";
import { DiffView } from "@/components/timeline/tool-call";
import { useActions, useClient } from "@/lib/client";
import { fileChanges, type FileChange } from "@/lib/describe";
import { baseName, shortPath } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";

export interface DiffReviewComment {
  key: string;
  filePath: string;
  editIndex: number;
  lineIndex: number;
  lineCode: string;
  comment: string;
}

export function formatDiffReviewPrompt(comments: DiffReviewComment[], cwd?: string): string {
  if (comments.length === 0) return "";
  const lines: string[] = ["请根据以下行级代码审查意见修改代码："];
  for (const item of comments) {
    const rel = relativePath(item.filePath, cwd);
    const snippet = item.lineCode.slice(1).trim();
    lines.push(`\n- **\`${rel}\`**${snippet ? ` (\`${snippet.slice(0, 80)}\`)` : ""}：\n  ${item.comment.trim()}`);
  }
  return lines.join("\n");
}

interface FileEntry {
  path: string;
  added: number;
  removed: number;
  kind: FileChange["kind"];
  edits: FileChange[];
}

function collect(items: ReturnType<typeof useItems>): FileEntry[] {
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

/** Inside the project: relative to it ("src/app.ts"); elsewhere: from the home directory. */
function relativePath(path: string, cwd?: string): string {
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  return shortPath(path);
}

function FileRow({
  entry,
  first,
  cwd,
  commentsByKey,
  onSelectLine,
}: {
  entry: FileEntry;
  first: boolean;
  cwd?: string;
  commentsByKey: Record<string, DiffReviewComment>;
  onSelectLine: (editIndex: number, lineIndex: number, lineText: string) => void;
}) {
  const [open, setOpen] = useState(first);
  const label = entry.kind === "add" ? "新建" : entry.kind === "delete" ? "删除" : null;
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
        style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14 }}
      >
        <Icon sf="doc.text" md="description" size={18} color={colors.secondaryLabel} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text numberOfLines={1} style={[type.subhead, { color: colors.label, fontWeight: "600", flexShrink: 1 }]}>
              {baseName(entry.path)}
            </Text>
            {label ? (
              <Text style={[type.caption2, { color: entry.kind === "add" ? colors.ok : colors.danger, fontWeight: "700" }]}>{label}</Text>
            ) : null}
            {fileCommentCount > 0 ? (
              <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8, backgroundColor: colors.accentSoft }}>
                <Text style={[type.caption2, { color: colors.accent, fontWeight: "700" }]}>{fileCommentCount} 条批注</Text>
              </View>
            ) : null}
          </View>
          <Text numberOfLines={1} style={[type.caption, { color: colors.tertiaryLabel }]}>
            {relativePath(entry.path, cwd)}
          </Text>
        </View>
        <Text style={[type.footnote, { fontVariant: ["tabular-nums"], fontWeight: "600" }]}>
          <Text style={{ color: colors.diffAddText }}>+{entry.added}</Text> <Text style={{ color: colors.diffDelText }}>−{entry.removed}</Text>
        </Text>
        <Icon sf={open ? "chevron.up" : "chevron.down"} md={open ? "expand_less" : "expand_more"} size={12} color={colors.tertiaryLabel} />
      </Pressable>
      {open ? (
        <View style={{ paddingHorizontal: 10, paddingBottom: 12, gap: 8 }}>
          {entry.edits.map((edit, editIndex) => {
            const lineComments: Record<number, string> = {};
            for (const item of Object.values(commentsByKey)) {
              if (item.filePath === entry.path && item.editIndex === editIndex) {
                lineComments[item.lineIndex] = item.comment;
              }
            }
            return (
              <View key={editIndex} style={{ gap: 4 }}>
                {entry.edits.length > 1 ? (
                  <Text style={[type.caption, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>第 {editIndex + 1} 次修改</Text>
                ) : null}
                <DiffView
                  change={edit}
                  maxLines={400}
                  lineComments={lineComments}
                  onPressLine={(lineIndex, lineText) => onSelectLine(editIndex, lineIndex, lineText)}
                />
              </View>
            );
          })}
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
  const items = useItems(sessionId);
  const cwd = useClient((state) => state.sessions[sessionId]?.cwd);
  const actions = useActions();
  const files = useMemo(() => collect(items), [items]);
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

  const submitAllComments = async () => {
    if (!commentList.length || sendingReview) return;
    setSendingReview(true);
    haptics.medium();
    try {
      const promptText = formatDiffReviewPrompt(commentList, cwd);
      const delivery = await actions.send(sessionId, [{ type: "text", text: promptText }]);
      if (delivery === "failed") {
        Alert.alert("发送失败", "未能将代码批注发送给 Agent。");
        return;
      }
      haptics.success();
      setCommentsByKey({});
      if (!embedded) router.back();
    } catch (error) {
      Alert.alert("发送失败", error instanceof Error ? error.message : String(error));
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
        {files.length === 0 ? (
          <EmptyState icon={{ sf: "doc.text.magnifyingglass", md: "difference" }} title="还没有改动" message="Agent 修改文件后会出现在这里。" />
        ) : (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4 }}>
              <Text style={[type.subhead, { color: colors.secondaryLabel }]}>
                {files.length} 个文件 · <Text style={{ color: colors.diffAddText, fontWeight: "600" }}>+{added}</Text>{" "}
                <Text style={{ color: colors.diffDelText, fontWeight: "600" }}>−{removed}</Text>
              </Text>
              <Text style={[type.caption, { color: colors.tertiaryLabel }]}>点击任意代码行添加修改批注</Text>
            </View>
            <View style={{ backgroundColor: colors.card, borderRadius: 22, borderCurve: "continuous", overflow: "hidden" }}>
              {files.map((entry, index) => (
                <FileRow
                  key={entry.path}
                  entry={entry}
                  first={index === 0}
                  cwd={cwd}
                  commentsByKey={commentsByKey}
                  onSelectLine={(editIndex, lineIndex, lineText) =>
                    openLineEditor(entry.path, editIndex, lineIndex, lineText)
                  }
                />
              ))}
            </View>
          </>
        )}
      </ScrollView>

      {commentList.length > 0 ? (
        <View style={{ position: "absolute", left: 16, right: 16, bottom: 20 }}>
          <Glass style={{ borderRadius: 22, paddingHorizontal: 14, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Icon sf="text.bubble.fill" md="comment" size={16} color={colors.accent} />
            <Text style={[type.subhead, { flex: 1, color: colors.label, fontWeight: "600" }]}>
              已添加 {commentList.length} 条批注
            </Text>
            <Button
              title="清空"
              variant="tonal"
              size="small"
              onPress={() => {
                haptics.selection();
                setCommentsByKey({});
              }}
            />
            <Button
              title="发给 Agent 修改"
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
              borderRadius: 22,
              padding: 18,
              gap: 12,
            }}
          >
            <Text style={[type.headline, { color: colors.label }]}>添加代码行批注</Text>
            {editingTarget ? (
              <View style={{ backgroundColor: colors.code, borderRadius: 10, padding: 8 }}>
                <Text numberOfLines={2} style={{ fontFamily: mono, fontSize: 12, color: colors.codeText }}>
                  {editingTarget.lineCode}
                </Text>
              </View>
            ) : null}
            <TextInput
              value={draftComment}
              onChangeText={setDraftComment}
              placeholder="告诉 Agent 这一行应该怎么改…"
              placeholderTextColor={colors.placeholder as string}
              multiline
              autoFocus
              style={{
                fontSize: 15,
                color: colors.label,
                backgroundColor: colors.fill,
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingVertical: 10,
                minHeight: 72,
              }}
            />
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
              {editingTarget && commentsByKey[editingTarget.key] ? (
                <Button
                  title="删除批注"
                  variant="tonal"
                  size="small"
                  onPress={() => {
                    setDraftComment("");
                    saveLineComment();
                  }}
                />
              ) : null}
              <Button title="取消" variant="tonal" size="small" onPress={() => setEditingTarget(null)} />
              <Button title="保存批注" variant="primary" size="small" onPress={saveLineComment} />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
