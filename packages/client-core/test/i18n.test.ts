import { describe, expect, it } from "vitest";
import {
  createLocaleStore,
  dateLocaleTag,
  detectLocale,
  I18N_DICTIONARY,
  LOCALE_LABELS,
  resolveLocalePreference,
  SUPPORTED_LOCALES,
  t,
  type I18nKey,
} from "../src/i18n.js";

describe("i18n dictionary & locale detection", () => {
  it("detects zh, en, and ja across standard BCP-47 / POSIX tags and defaults other tags to en", () => {
    expect(detectLocale("zh-CN")).toBe("zh");
    expect(detectLocale("zh-Hant-TW")).toBe("zh");
    expect(detectLocale("zh_Hans")).toBe("zh");
    expect(detectLocale("ja-JP")).toBe("ja");
    expect(detectLocale("ja")).toBe("ja");
    expect(detectLocale("en-US")).toBe("en");
    expect(detectLocale("en-GB")).toBe("en");
    expect(detectLocale("de-DE")).toBe("en");
    expect(detectLocale("fr")).toBe("en");
    expect(SUPPORTED_LOCALES).toEqual(["zh", "en", "ja"]);
    expect(LOCALE_LABELS).toEqual({ zh: "简体中文", en: "English", ja: "日本語" });
    expect(dateLocaleTag("zh")).toBe("zh-CN");
    expect(dateLocaleTag("en")).toBe("en-US");
    expect(dateLocaleTag("ja")).toBe("ja-JP");
  });

  it("has non-empty translations for every key across zh, en, and ja", () => {
    const keys = Object.keys(I18N_DICTIONARY.zh) as I18nKey[];
    expect(keys.length).toBeGreaterThan(80);
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of keys) {
        expect(I18N_DICTIONARY[locale][key], `${locale}:${key}`).toBeTruthy();
      }
    }
  });

  it("interpolates variables accurately across locales", () => {
    expect(t("zh", "desktop.membership.trialBadge", { days: 5 })).toBe("7 天免费试用 · 剩余 5 天");
    expect(t("en", "desktop.membership.trialBadge", { days: 5 })).toBe("7-day free trial · 5d left");
    expect(t("ja", "desktop.membership.trialBadge", { days: 5 })).toBe("7日間無料トライアル · 残り 5 日");
    expect(t("en", "ports.readyPill", { port: 5173 })).toBe("localhost:5173 Ready");
    expect(t("zh", "changes.submitReview", { count: 3 })).toBe("汇总发送批注 (3)");
  });

  it("enforces strict App Store 3.1.1 safety on mobile.membership.* strings (no URLs, prices, or checkout CTAs)", () => {
    const mobileKeys = (Object.keys(I18N_DICTIONARY.zh) as I18nKey[]).filter((key) =>
      key.startsWith("mobile.membership."),
    );
    expect(mobileKeys.length).toBeGreaterThanOrEqual(8);
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of mobileKeys) {
        const value = I18N_DICTIONARY[locale][key];
        expect(value).not.toMatch(/itool\.tech\/pro|checkout=|https?:\/\/|[$¥￥]\s*\d/i);
      }
    }
  });

  it("persists and notifies preference changes via createLocaleStore", () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value); },
    };
    const store = createLocaleStore({ storage, systemLocale: "ja-JP" });
    expect(store.getPreference()).toBe("system");
    expect(store.getLocale()).toBe("ja");

    const seen: string[] = [];
    const unsubscribe = store.subscribe((locale, pref) => seen.push(`${pref}:${locale}`));
    store.setPreference("en");
    expect(store.getLocale()).toBe("en");
    expect(store.t("nav.sessions")).toBe("Sessions");
    store.setPreference("system", "zh-CN");
    expect(store.getLocale()).toBe("zh");
    unsubscribe();
    expect(seen).toEqual(["en:en", "system:zh"]);
    expect(resolveLocalePreference("system", "ja-JP")).toBe("ja");
  });
});
