import { beforeEach, describe, expect, it, vi } from "vitest";
import brandColors from "../src/theme/brand-colors.json";

const environment = vi.hoisted(() => ({ os: "android", scheme: "light" as string | null }));
vi.mock("react-native", () => ({
  Platform: { get OS() { return environment.os; } },
  Appearance: { getColorScheme: () => environment.scheme },
  DynamicColorIOS: (pair: unknown) => ({ dynamic: pair }),
  PlatformColor: (...paths: string[]) => ({ resource_paths: paths }),
}));
vi.mock("expo-router", () => ({ Color: { ios: new Proxy({}, { get: (_, name) => ({ semantic: [name] }) }) } }));

beforeEach(() => {
  vi.resetModules();
  environment.os = "android";
  environment.scheme = "light";
});

describe("Android appearance while the app remains loaded", () => {
  it("passes fresh literal colors after light → dark → light, including text, cards and sheets", async () => {
    const { colors } = await import("@/theme/colors");
    for (const scheme of ["light", "dark", "light"] as const) {
      environment.scheme = scheme;
      for (const [name, pair] of Object.entries(brandColors)) {
        const color = colors[name as keyof typeof colors];
        expect(color, `${scheme} ${name}`).toBe(pair[scheme === "dark" ? 1 : 0]);
        expect(typeof color).toBe("string");
      }
      expect(colors.onAccent).toBe("#ffffff");
    }
  });

  it("reads the current appearance after a background change without retaining the launch scheme", async () => {
    const { colors } = await import("@/theme/colors");
    const { largeTitleHeader } = await import("@/components/headers");
    expect(colors.label).toBe("#000000");
    expect(largeTitleHeader().headerTintColor).toBe("#000000");
    environment.scheme = "dark";
    expect(colors.label).toBe("#FFFFFF");
    expect(colors.sheet).toBe("#1C1C1E");
    expect(largeTitleHeader()).toMatchObject({ headerTintColor: "#FFFFFF", contentStyle: { backgroundColor: "#000000" } });
    environment.scheme = null;
    expect(colors.label).toBe("#000000");
  });

  it("preserves iOS native semantic and dynamic color objects", async () => {
    environment.os = "ios";
    const { colors } = await import("@/theme/colors");
    expect(colors.label).toEqual({ semantic: ["label"] });
    expect(colors.accent).toEqual({ dynamic: { light: brandColors.accent[0], dark: brandColors.accent[1] } });
  });
});
