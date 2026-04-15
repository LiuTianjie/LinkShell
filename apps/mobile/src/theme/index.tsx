import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Appearance } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type ThemeMode = "dark" | "light";

export interface Theme {
  mode: ThemeMode;
  // Backgrounds — custom dark tech theme
  bg: string;
  bgCard: string;
  bgInput: string;
  bgTerminal: string;
  bgElevated: string;
  bgGrouped: string;
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
  separator: string;
  // Accent
  accent: string;
  accentLight: string;
  accentSecondary: string; // The green (#4edea3)
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

// Custom Tech Theme Colors (Dark)
const darkTheme: Theme = {
  mode: "dark",
  bg: "#131314",
  bgCard: "rgba(53, 52, 54, 0.6)",
  bgInput: "#0e0e0f",
  bgTerminal: "#000000",
  bgElevated: "#2a2a2b",
  bgGrouped: "#131314",
  keyboardBarBg: "#2a2a2b",
  keyboardBarBorder: "#424754",
  text: "#e5e2e3", // on-bg
  textSecondary: "#c2c6d6", // on-surface-variant
  textTertiary: "#929091",
  textInverse: "#000000",
  border: "#424754",
  borderLight: "#353436",
  separator: "rgba(140, 144, 159, 0.4)",
  accent: "#adc6ff", // primary
  accentLight: "rgba(173, 198, 255, 0.15)",
  accentSecondary: "#4edea3",
  success: "#4edea3",
  warning: "#ffd60a",
  error: "#ffb4ab",
  errorLight: "rgba(255, 180, 171, 0.15)",
  tabBg: "#1c1b1c",
  tabBorder: "#424754",
  tabActive: "#adc6ff",
  tabInactive: "#929091",
};

// Light theme — clean, bright counterpart
const lightTheme: Theme = {
  mode: "light",
  bg: "#f2f2f7",
  bgCard: "#ffffff",
  bgInput: "#e8e8ed",
  bgTerminal: "#ffffff",
  bgElevated: "#ffffff",
  bgGrouped: "#f2f2f7",
  keyboardBarBg: "#e8e8ed",
  keyboardBarBorder: "#c6c6c8",
  text: "#1c1c1e",
  textSecondary: "#3a3a3c",
  textTertiary: "#8e8e93",
  textInverse: "#ffffff",
  border: "#c6c6c8",
  borderLight: "#e5e5ea",
  separator: "rgba(60, 60, 67, 0.18)",
  accent: "#3a5fc8",
  accentLight: "rgba(58, 95, 200, 0.10)",
  accentSecondary: "#1aab6e",
  success: "#1aab6e",
  warning: "#ff9500",
  error: "#ff3b30",
  errorLight: "rgba(255, 59, 48, 0.10)",
  tabBg: "#ffffff",
  tabBorder: "#e5e5ea",
  tabActive: "#3a5fc8",
  tabInactive: "#8e8e93",
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

  useEffect(() => {
    Appearance.setColorScheme(mode);
  }, [mode]);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setThemeMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
