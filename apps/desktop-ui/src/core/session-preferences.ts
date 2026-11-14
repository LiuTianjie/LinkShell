import { createSessionPreferences, resolveSessionPreferences } from "@linkshell/client-core";
import { readLocal, saveLocal } from "./storage";

export { resolveSessionPreferences };

export const sessionPreferences = createSessionPreferences({
  getItem: (key) => readLocal<string | null>(key, null),
  setItem: (key, value) => saveLocal(key, value),
});
