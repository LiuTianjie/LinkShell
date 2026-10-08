import type { DirectoryEntry } from "@linkshell/wire";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { Text, TextInput } from "@/components/fixed-text";
import { KeyboardAwareScrollView, type KeyboardAwareScrollViewRef } from "react-native-keyboard-controller";
import { usePageInsets } from "@/components/adaptive-page";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { useConnection } from "@/lib/client";
import { pickDirectory } from "@/lib/directory-pick";
import { shortPath } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { SheetHeader } from "@/components/sheet-header";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

/** Path segments from the home directory down, for the tappable path bar. */
function crumbs(path: string, home: string): { name: string; path: string }[] {
  const inHome = path === home || path.startsWith(`${home}/`);
  const root = inHome ? home : "/";
  const rest = path.slice(root.length).split("/").filter(Boolean);
  const out = [{ name: inHome ? "~" : "/", path: root }];
  let current = root;
  for (const part of rest) {
    current = current === "/" ? `/${part}` : `${current}/${part}`;
    out.push({ name: part, path: current });
  }
  return out;
}

function Row({ entry, detail, onPress, last }: { entry: DirectoryEntry; detail?: string; onPress: () => void; last: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingLeft: 14,
        backgroundColor: pressed ? colors.fill : undefined,
      })}
    >
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          borderCurve: "continuous",
          backgroundColor: entry.project ? colors.accentSoft : colors.fill,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon
          sf={entry.project ? "chevron.left.forwardslash.chevron.right" : "folder"}
          md={entry.project ? "code" : "folder"}
          size={14}
          color={entry.project ? colors.accent : colors.secondaryLabel}
          weight="medium"
        />
      </View>
      <View
        style={{
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 11,
          paddingRight: 14,
          borderBottomWidth: last ? 0 : 0.5,
          borderBottomColor: colors.separator,
        }}
      >
        <View style={{ flex: 1, gap: 1 }}>
          <Text numberOfLines={1} style={[type.body, { fontSize: 16, color: colors.label }]}>
            {entry.name}
          </Text>
          {detail ? (
            <Text numberOfLines={1} style={[type.caption, { color: colors.tertiaryLabel }]}>
              {detail}
            </Text>
          ) : null}
        </View>
        <Icon sf="chevron.right" md="chevron_right" size={11} color={colors.tertiaryLabel} weight="semibold" />
      </View>
    </Pressable>
  );
}

/** Browse or search directories, then confirm the current folder in the system toolbar. */
export function BrowseScreen() {
  const { link } = useConnection();
  const insets = usePageInsets();
  const [path, setPath] = useState<string | undefined>(undefined);
  const [listing, setListing] = useState<{ path: string; parent?: string; home: string; entries: DirectoryEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; entries: DirectoryEntry[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const scroll = useRef<KeyboardAwareScrollViewRef>(null);
  const crumbBar = useRef<ScrollView>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    link
      .call("fs.list", { path })
      .then((result) => {
        if (cancelled) return;
        setListing(result);
        scroll.current?.scrollTo({ y: 0, animated: false });
      })
      .catch((reason: unknown) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      cancelled = true;
    };
  }, [link, path]);

  // Search as you type, after a short pause.
  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      link
        .call("fs.search", { query: text }, 10_000)
        .then((result) => !cancelled && setResults({ query: text, entries: result.entries }))
        .catch(() => !cancelled && setResults({ query: text, entries: [] }))
        .finally(() => !cancelled && setSearching(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [link, query]);

  const trail = useMemo(() => (listing ? crumbs(listing.path, listing.home) : []), [listing]);
  const open = (target: string) => {
    haptics.selection();
    setQuery("");
    setPath(target);
  };
  // New folder: a name field at the top of the list, then straight into it.
  const [naming, setNaming] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const makeFolder = async () => {
    const name = naming?.trim();
    if (!name || !listing || making) return;
    setMaking(true);
    try {
      const result = await link.call("fs.mkdir", { parent: listing.path, name });
      setNaming(null);
      haptics.success();
      open(result.path);
    } catch (reason) {
      haptics.error();
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMaking(false);
    }
  };
  const choose = (target: string) => {
    haptics.success();
    pickDirectory(target);
    router.back();
  };

  const searchMode = query.trim().length > 0;
  const rows = searchMode ? (results?.entries ?? []) : (listing?.entries ?? []);

  return (
    <View style={{ flex: 1, backgroundColor: colors.sheet }}>
      <SheetHeader title="选择目录" actions={listing && !searchMode ? [{ key: "folder", label: "新建文件夹", icon: { sf: "folder.badge.plus", md: "create_new_folder" }, onPress: () => { haptics.selection(); setNaming((value) => value === null ? "" : null); } }, { key: "choose", label: "使用当前目录", icon: { sf: "checkmark", md: "check" }, onPress: () => choose(listing.path), disabled: making, prominent: true }] : []} />

      <View style={{ flex: 1, overflow: "hidden" }}>
      <KeyboardAwareScrollView
        ref={scroll}
        bottomOffset={24}
        contentInsetAdjustmentBehavior="never"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: 12, paddingBottom: insets.bottom + 16 }}
      >
      <View style={{ paddingHorizontal: 16, gap: 10 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            minHeight: 44,
            paddingHorizontal: 12,
            borderRadius: 12,
            borderCurve: "continuous",
            backgroundColor: colors.fill,
          }}
        >
          <Icon sf="magnifyingglass" md="search" size={15} color={colors.secondaryLabel} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="搜索电脑上的目录"
            placeholderTextColor={colors.placeholder as string}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            style={[type.body, { flex: 1, minHeight: 44, fontSize: 16, color: colors.label, paddingVertical: 10 }]}
          />
          {searching ? <ActivityIndicator size="small" color={colors.secondaryLabel} /> : null}
        </View>

        {!searchMode && trail.length ? (
          <View style={{ minHeight: 44 }}>
            <ScrollView
              ref={crumbBar}
              horizontal
              style={{ flexGrow: 0 }}
              showsHorizontalScrollIndicator={false}
              onContentSizeChange={() => crumbBar.current?.scrollToEnd({ animated: false })}
              contentContainerStyle={{ alignItems: "center", minHeight: 44, gap: 2, paddingRight: 8 }}
            >
              {trail.map((crumb, index) => {
                const current = index === trail.length - 1;
                return (
                  <View key={crumb.path} style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                    {index > 0 ? (
                      <Icon sf="chevron.right" md="chevron_right" size={9} color={colors.tertiaryLabel} weight="semibold" />
                    ) : null}
                    <Pressable
                      disabled={current}
                      onPress={() => open(crumb.path)}
                      style={({ pressed }) => ({
                        minWidth: 44,
                        minHeight: 44,
                        alignItems: "center",
                        justifyContent: "center",
                        paddingHorizontal: 8,
                        paddingVertical: 10,
                        borderRadius: 8,
                        backgroundColor: current ? colors.accentSoft : pressed ? colors.fill : undefined,
                      })}
                    >
                      <Text
                        style={[
                          type.footnote,
                          { color: current ? colors.accent : colors.secondaryLabel, fontWeight: current ? "600" : "500" },
                        ]}
                      >
                        {crumb.name}
                      </Text>
                    </Pressable>
                  </View>
                );
              })}
            </ScrollView>
          </View>
        ) : null}
      </View>

      <View style={{ padding: 16 }}>
          {naming !== null && !searchMode ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                marginBottom: 12,
                paddingLeft: 14,
                paddingRight: 6,
                minHeight: 52,
                paddingVertical: 4,
                borderRadius: 18,
                borderCurve: "continuous",
                backgroundColor: colors.sheetCard,
              }}
            >
              <Icon sf="folder.badge.plus" md="create_new_folder" size={18} color={colors.accent} />
              <TextInput
                value={naming}
                onChangeText={setNaming}
                autoFocus
                placeholder="新文件夹的名字"
                placeholderTextColor={colors.placeholder as string}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={() => void makeFolder()}
                style={[type.body, { flex: 1, minHeight: 44, fontSize: 16, color: colors.label, paddingVertical: 10 }]}
              />
              <Button title="创建" variant="primary" size="small" disabled={!naming.trim() || making} onPress={() => void makeFolder()} />
            </View>
          ) : null}
          {error && !searchMode ? (
            <Text style={[type.subhead, { color: colors.danger, padding: 8 }]}>{error}</Text>
          ) : !listing && !searchMode ? (
            <ActivityIndicator style={{ marginTop: 24 }} color={colors.secondaryLabel} />
          ) : rows.length === 0 ? (
            <Text style={[type.subhead, { color: colors.tertiaryLabel, textAlign: "center", marginTop: 28 }]}>
              {searchMode ? (searching ? "正在搜索…" : `没有找到「${query.trim()}」`) : "这里没有子目录"}
            </Text>
          ) : (
            <View style={{ backgroundColor: colors.sheetCard, borderRadius: 18, borderCurve: "continuous", overflow: "hidden" }}>
              {rows.map((entry, index) => (
                <Row
                  key={entry.path}
                  entry={entry}
                  detail={searchMode ? shortPath(entry.path) : undefined}
                  last={index === rows.length - 1}
                  onPress={() => open(entry.path)}
                />
              ))}
            </View>
          )}
      </View>


      </KeyboardAwareScrollView>
      </View>
    </View>
  );
}
