import { createSessionPreferences } from "@linkshell/client-core";
import Storage from "expo-sqlite/kv-store";

export const sessionPreferences = createSessionPreferences({
  getItem: (key) => Storage.getItemSync(key),
  setItem: (key, value) => Storage.setItemSync(key, value),
});
