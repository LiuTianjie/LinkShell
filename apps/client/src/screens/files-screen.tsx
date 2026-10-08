import { LegendList } from "@legendapp/list/react-native";
import type { DirectoryEntry } from "@linkshell/wire";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { memo, useEffect, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { useAppWindowDimensions as useWindowDimensions } from "@/lib/window-dimensions";
import { ScrollableState } from "@/components/scrollable-state";
import { BranchTag } from "@/components/branch-tag";
import { HeaderActions, useHeaderTitleWidth } from "@/components/header-actions";
import { Icon, type IconProps } from "@/components/icon";
import { PressableScale } from "@/components/pressable-scale";
import { positionOf, type RowPosition } from "@/components/session-row";
import { EmptyState, LoadingState, unreachable, WaitingForComputer } from "@/components/state-views";
import { useClient, useConnection } from "@/lib/client";
import { baseName, fileSize, shortPath } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { openFile } from "@/lib/links";
import { branchOf, useGitInfo } from "@/lib/worktree";
import { ContentPane, useContentWidth } from "@/lib/content-width";
import { FileContent } from "./file-screen";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

interface Listing {
  path: string;
  home: string;
  entries: DirectoryEntry[];
  truncated?: boolean;
}

type Glyph = Pick<IconProps, "sf" | "md">;

const IMAGE = /\.(png|jpe?g|gif|webp|svg|heic|bmp|ico|tiff?)$/i;
const MEDIA = /\.(mp4|mov|mkv|avi|webm|mp3|wav|m4a|flac|ogg)$/i;
const ARCHIVE = /\.(zip|tar|gz|tgz|bz2|xz|7z|rar|dmg|pkg|apk|ipa|jar)$/i;
const CODE =
  /\.(m?[jt]sx?|cjs|json|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|bash|sql|s?css|html?|xml|ya?ml|toml|vue|svelte|lua|dart|gradle)$/i;
const PROSE = /\.(md|mdx|markdown|txt|log|rst|csv|tsv|pdf)$/i;

/** A rough kind from the name alone; nothing is read to draw a row. */
function fileGlyph(name: string): Glyph {
  if (IMAGE.test(name)) return { sf: "photo", md: "image" };
  if (MEDIA.test(name)) return { sf: "play.rectangle", md: "movie" };
  if (ARCHIVE.test(name)) return { sf: "archivebox", md: "folder_zip" };
  if (CODE.test(name)) return { sf: "chevron.left.forwardslash.chevron.right", md: "code" };
  if (PROSE.test(name)) return { sf: "doc.text", md: "description" };
  return { sf: "doc", md: "draft" };
}

const Row = memo(function Row({ entry, position, onPress, selected }: { entry: DirectoryEntry; position: RowPosition; selected?: boolean; onPress: (entry: DirectoryEntry) => void }) {
  const top = position === "first" || position === "only";
  const bottom = position === "last" || position === "only";
  const glyph: Glyph = entry.file ? fileGlyph(entry.name) : { sf: "folder.fill", md: "folder" };
  return (
    <PressableScale
      onPress={() => onPress(entry)}
      pressedScale={0.985}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={entry.file ? `文件 ${entry.name}` : `文件夹 ${entry.name}`}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingLeft: 14,
          backgroundColor: selected ? colors.accentSoft : colors.card,
          borderTopLeftRadius: top ? 20 : 0,
          borderTopRightRadius: top ? 20 : 0,
          borderBottomLeftRadius: bottom ? 20 : 0,
          borderBottomRightRadius: bottom ? 20 : 0,
          borderCurve: "continuous",
        }}
      >
        <View style={{ width: 24, alignItems: "center" }}>
          <Icon {...glyph} size={entry.file ? 18 : 20} color={entry.file ? colors.secondaryLabel : colors.accent} />
        </View>
        <View
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            minHeight: 46,
            paddingVertical: 10,
            paddingRight: 14,
            borderBottomWidth: bottom ? 0 : StyleSheet.hairlineWidth,
            borderBottomColor: colors.separator,
          }}
        >
          <Text numberOfLines={1} ellipsizeMode="middle" style={[type.body, { flex: 1, fontSize: 16, color: colors.label }]}>
            {entry.name}
          </Text>
          {entry.file ? (
            entry.size !== undefined ? (
              <Text style={[type.footnote, { color: colors.tertiaryLabel, fontVariant: ["tabular-nums"] }]}>{fileSize(entry.size)}</Text>
            ) : null
          ) : (
            <Icon sf="chevron.right" md="chevron_right" size={11} color={colors.tertiaryLabel} weight="semibold" />
          )}
        </View>
      </View>
    </PressableScale>
  );
});

function HeaderTitle({ name, path, maxWidth }: { name: string; path: string; maxWidth: number }) {
  return (
    <View style={{ alignItems: Platform.OS === "ios" ? "center" : "flex-start", maxWidth }}>
      <Text numberOfLines={1} style={[type.headline, { color: colors.label }]}>
        {name}
      </Text>
      {path ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text numberOfLines={1} ellipsizeMode="head" style={[type.caption, { flexShrink: 1, color: colors.secondaryLabel }]}>
            {path}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * A directory on the computer: its folders, then its files. Folders open
 * here, files in the viewer. Only names and sizes are listed; a file is read
 * when it is opened.
 */
export function FilesScreen() {
  const parentWidth = useContentWidth();
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const width = measuredWidth ?? parentWidth;
  const { fontScale } = useWindowDimensions();
  const wide = width >= Math.max(760, 720 * fontScale);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const headerTitleWidth = useHeaderTitleWidth(selected ? 2 : 1);
  const showList = !selected || (wide && !collapsed);
  const listWidth = wide ? Math.min(340, Math.round(width * 0.36)) : width;
  const params = useLocalSearchParams<{ path?: string; hidden?: string }>();
  const { link } = useConnection();
  const online = useClient((state) => state.status === "online");
  const offline = useClient((state) => unreachable(state.status));
  const [hidden, setHidden] = useState(params.hidden === "1");
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  // (Again) whenever the computer comes back, and on "刷新".
  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    setError(null);
    link
      .call("fs.list", { path: params.path || undefined, hidden, files: true })
      .then((result) => !cancelled && setListing(result))
      .catch((reason: unknown) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      cancelled = true;
    };
  }, [link, online, params.path, hidden, round]);

  const path = listing?.path ?? params.path ?? "";
  const branch = branchOf(useGitInfo(path || undefined));
  const entries = listing?.entries ?? [];

  const open = (entry: DirectoryEntry) => {
    haptics.selection();
    if (entry.file) {
      if (wide) setSelected(entry.path);
      else openFile({ path: entry.path });
    }
    else router.push({ pathname: "/files", params: { path: entry.path, ...(hidden ? { hidden: "1" } : {}) } });
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: path ? baseName(path) : "文件",
          headerTitle: () => <HeaderTitle name={path ? baseName(path) : "文件"} path={path ? shortPath(path) : ""} maxWidth={headerTitleWidth} />,
        }}
      />
      <HeaderActions
        actions={[
          ...(selected ? [{ kind: "button" as const, key: "files", icon: { sf: "sidebar.left" as const, md: "menu_open" as const }, label: showList ? "收起文件列表" : "显示文件列表", onPress: () => wide ? setCollapsed((value) => !value) : setSelected(null) }] : []),
          {
            kind: "menu",
            key: "more",
            icon: { sf: "ellipsis", md: "more_vert" },
            label: "更多",
            items: [
              {
                title: hidden ? "不显示隐藏文件" : "显示隐藏文件",
                icon: hidden ? { sf: "eye.slash", md: "visibility_off" } : { sf: "eye", md: "visibility" },
                onPress: () => setHidden((value) => !value),
              },
              { title: "刷新", icon: { sf: "arrow.clockwise", md: "refresh" }, onPress: () => setRound((value) => value + 1) },
            ],
          },
        ]}
      />
      <View onLayout={(event) => setMeasuredWidth(event.nativeEvent.layout.width)} style={{ flex: 1, flexDirection: "row", minHeight: 0 }}>
      <ContentPane style={{ width: wide ? listWidth : "100%", display: showList ? "flex" : "none", borderRightWidth: wide ? StyleSheet.hairlineWidth : 0, borderRightColor: colors.separator }}>
      <LegendList<DirectoryEntry>
        data={error ? [] : entries}
        keyExtractor={(entry) => entry.path}
        renderItem={({ item, index }) => <Row entry={item} position={positionOf(index, entries.length)} onPress={open} selected={selected === item.path} />}
        estimatedItemSize={46}
        ListHeaderComponent={branch ? <View style={{ paddingBottom: 12 }}><BranchTag branch={branch} max={28} /></View> : null}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16 }}
        style={{ flex: 1, backgroundColor: colors.background }}
        ListEmptyComponent={
          error ? (
            <EmptyState
              icon={{ sf: "exclamationmark.triangle", md: "warning" }}
              title="打不开这个文件夹"
              message={error}
              action={{ title: "重试", onPress: () => setRound((value) => value + 1) }}
            />
          ) : !listing ? (
            offline ? <WaitingForComputer what="这个文件夹里的文件" /> : <LoadingState label="正在读取…" />
          ) : (
            <EmptyState
              icon={{ sf: "folder", md: "folder_open" }}
              title="这个文件夹是空的"
              message={hidden ? undefined : "隐藏文件没有显示，可以在右上角打开。"}
            />
          )
        }
        ListFooterComponent={
          listing?.truncated && !error ? (
            <Text style={[type.footnote, { color: colors.tertiaryLabel, textAlign: "center", paddingTop: 14 }]}>只显示前 1000 项</Text>
          ) : null
        }
      />
      </ContentPane>
      <View style={{ flex: 1, minWidth: 0, display: wide || selected ? "flex" : "none", backgroundColor: colors.plain }}>
        {selected ? <FileContent key={selected} path={selected} embedded backLabel={wide && showList ? "收起文件列表" : "显示文件列表"} onBack={() => wide ? setCollapsed((value) => !value) : setSelected(null)} /> : (
          <ScrollableState><EmptyState icon={{ sf: "doc.text.magnifyingglass", md: "find_in_page" }} title="选择文件以预览" message="在左侧浏览目录，在这里查看代码、文档和图片。" /></ScrollableState>
        )}
      </View>
      </View>
    </>
  );
}
