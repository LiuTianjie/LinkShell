import { router } from "expo-router";
import type { PageAction } from "./page-header";

export const NEW_SESSION: PageAction = {
  key: "new",
  icon: { sf: "square.and.pencil", md: "edit_square" },
  label: "新建会话",
  onPress: () => router.push("/new"),
};
