import Storage from "expo-sqlite/kv-store";
import { create } from "zustand";

const HIDDEN_KEY = "files.showHidden";

function loadHidden(): boolean {
  try { return Storage.getItemSync(HIDDEN_KEY) === "1"; }
  catch { return false; }
}

// Directory routes stay mounted underneath their children; share the choice so
// returning to a parent does not silently hide files again.
export const useFilePreferences = create<{
  hidden: boolean;
  setHidden: (value: boolean) => void;
}>((set) => ({
  hidden: loadHidden(),
  setHidden: (hidden) => {
    set({ hidden });
    try { Storage.setItemSync(HIDDEN_KEY, hidden ? "1" : "0"); }
    catch { /* Keep the choice for this app run. */ }
  },
}));
