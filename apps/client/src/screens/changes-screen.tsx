import { useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { Icon } from "@/components/icon";
import { EmptyState } from "@/components/state-views";
import { DiffView } from "@/components/timeline/tool-call";
import { useClient } from "@/lib/client";
import { fileChanges, type FileChange } from "@/lib/describe";
import { baseName, shortPath } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

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

function FileRow({ entry, first, cwd }: { entry: FileEntry; first: boolean; cwd?: string }) {
  const [open, setOpen] = useState(false);
  const label = entry.kind === "add" ? "新建" : entry.kind === "delete" ? "删除" : null;
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
          {entry.edits.map((edit, index) => (
            <View key={index} style={{ gap: 4 }}>
              {entry.edits.length > 1 ? (
                <Text style={[type.caption, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>第 {index + 1} 次修改</Text>
              ) : null}
              <DiffView change={edit} maxLines={400} />
            </View>
          ))}
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
  const files = useMemo(() => collect(items), [items]);
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior={embedded ? "never" : "automatic"}
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
    >
      {files.length === 0 ? (
        <EmptyState icon={{ sf: "doc.text.magnifyingglass", md: "difference" }} title="还没有改动" message="Agent 修改文件后会出现在这里。" />
      ) : (
        <>
          <Text style={[type.subhead, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>
            {files.length} 个文件 · <Text style={{ color: colors.diffAddText, fontWeight: "600" }}>+{added}</Text>{" "}
            <Text style={{ color: colors.diffDelText, fontWeight: "600" }}>−{removed}</Text>
          </Text>
          <View style={{ backgroundColor: colors.card, borderRadius: 22, borderCurve: "continuous", overflow: "hidden" }}>
            {files.map((entry, index) => (
              <FileRow key={entry.path} entry={entry} first={index === 0} cwd={cwd} />
            ))}
          </View>
        </>
      )}
    </ScrollView>
  );
}
