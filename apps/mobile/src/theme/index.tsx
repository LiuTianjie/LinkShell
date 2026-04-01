import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type ThemeMode = "dark" | "light";

export interface Theme {
  mode: ThemeMode;
  // Backgrounds
  bg: string;
  bgCard: string;
  bgInput: string;
  bgTerminal: string;
  bgElevated: string;
  keyboardBarBg: string;
  keyboardBarBorder: string;
  // Text
  text: string;
  textSecondary: string;
  textTertiary: string;
  textInverse: string;
  // Borders
  border: string;
  borderLight: string;
  // Accent
  accent: string;
  accentLight: string;
  // Status
  success: string;
  warning: string;
  error: string;
  errorLight: string;
  // Tab bar
  tabBg: string;
  tabBorder: string;
  tabActive: string;
  tabInactive: string;
}

const darkTheme: Theme = {
  mode: "dark",
  bg: "#0a0a0f",
  bgCard: "#141420",
  bgInput: "#1a1a2e",
  bgTerminal: "#020617",
  bgElevated: "#1e1e32",
  keyboardBarBg: "#232336",
  keyboardBarBorder: "#2a2a40",
  text: "#f0f0f5",
  textSecondary: "#8b8ba0",
  textTertiary: "#55556a",
  textInverse: "#0a0a0f",
  border: "#2a2a40",
  borderLight: "#1e1e32",
  accent: "#3b82f6",
  accentLight: "rgba(59,130,246,0.15)",
  success: "#4ade80",
  warning: "#fbbf24",
  error: "#ef4444",
  errorLight: "rgba(239,68,68,0.15)",
  tabBg: "#0f0f18",
  tabBorder: "#1e1e32",
  tabActive: "#3b82f6",
  tabInactive: "#55556a",
};

const lightTheme: Theme = {
  mode: "light",
  bg: "#f2f4f7",
  bgCard: "#ffffff",
  bgInput: "#f0f2f5",
  bgTerminal: "#f8fafc",
  bgElevated: "#ffffff",
  keyboardBarBg: "#f2f2f7",
  keyboardBarBorder: "#d8d8de",
  text: "#111827",
  textSecondary: "#6b7280",
  textTertiary: "#9ca3af",
  textInverse: "#ffffff",
  border: "#e5e7eb",
  borderLight: "#f0f0f5",
  accent: "#2563eb",
  accentLight: "rgba(37,99,235,0.1)",
  success: "#22c55e",
  warning: "#f59e0b",
  error: "#dc2626",
  errorLight: "rgba(220,38,38,0.1)",
  tabBg: "#ffffff",
  tabBorder: "#e5e7eb",
  tabActive: "#2563eb",
  tabInactive: "#9ca3af",
};

const STORAGE_KEY = "@linkshell/theme";

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
  setThemeMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: darkTheme,
  toggleTheme: () => {},
  setThemeMode: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>("dark");

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((saved) => {
      if (saved === "light" || saved === "dark") setMode(saved);
    });
  }, []);

  const setThemeMode = useCallback((m: ThemeMode) => {
    setMode(m);
    AsyncStorage.setItem(STORAGE_KEY, m);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeMode(mode === "dark" ? "light" : "dark");
  }, [mode, setThemeMode]);

  const theme = mode === "dark" ? darkTheme : lightTheme;

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setThemeMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
