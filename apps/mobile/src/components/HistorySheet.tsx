import React, { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useTheme } from "../theme";
import { AppSymbol } from "./AppSymbol";

interface HistorySheetProps {
  visible: boolean;
  entries: string[];
  onSelect: (command: string) => void;
  onClose: () => void;
}

export function HistorySheet({
  visible,
  entries,
  onSelect,
  onClose,
}: HistorySheetProps) {
  const { theme } = useTheme();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!query) return entries;
    const q = query.toLowerCase();
    return entries.filter((e) => e.toLowerCase().includes(q));
  }, [entries, query]);

  const handleSelect = useCallback(
    (item: string) => {
      onSelect(item);
      onClose();
      setQuery("");
    },
    [onSelect, onClose],
  );

  const handleClose = useCallback(() => {
    onClose();
    setQuery("");
  }, [onClose]);

  const renderItem = useCallback(
    ({ item }: { item: string }) => (
      <Pressable
        style={[styles.item, { borderBottomColor: theme.separator }]}
        onPress={() => handleSelect(item)}
      >
        <Text style={[styles.itemText, { color: theme.text }]} numberOfLines={1}>
          {item}
        </Text>
      </Pressable>
    ),
    [theme, handleSelect],
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <View style={[styles.header, { borderBottomColor: theme.separator }]}>
          <Text style={[styles.title, { color: theme.text }]}>Shell History</Text>
          <Pressable onPress={handleClose} hitSlop={8}>
            <View style={{
              width: 30, height: 30, borderRadius: 15,
              backgroundColor: theme.mode === "dark" ? "#48484a" : "#e5e5ea",
              alignItems: "center", justifyContent: "center",
            }}>
              <AppSymbol name="xmark" size={11} color={theme.mode === "dark" ? "#e5e2e3" : "#3a3a3c"} />
            </View>
          </Pressable>
        </View>
        <View style={styles.searchRow}>
          <TextInput
            style={[
              styles.search,
              {
                backgroundColor: theme.bgInput,
                color: theme.text,
                borderColor: theme.border,
              },
            ]}
            placeholder="搜索命令..."
            placeholderTextColor={theme.textTertiary}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
          />
        </View>
        <FlatList
          data={filtered}
          keyExtractor={(item, index) => `${index}-${item}`}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Text style={[styles.empty, { color: theme.textTertiary }]}>
              {entries.length === 0 ? "暂无历史记录" : "无匹配结果"}
            </Text>
          }
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontSize: 17,
    fontWeight: "600",
  },
  close: {
    fontSize: 15,
    fontWeight: "600",
  },
  searchRow: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  search: {
    height: 36,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  item: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  itemText: {
    fontSize: 14,
    fontFamily: "Menlo",
  },
  empty: {
    textAlign: "center",
    marginTop: 40,
    fontSize: 14,
  },
});
