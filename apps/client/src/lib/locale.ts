import {
  createLocaleStore,
  dateLocaleTag,
  detectLocale,
  LOCALE_LABELS,
  resolveLocalePreference,
  t as translateKey,
  type I18nKey,
  type I18nVars,
  type Locale,
  type LocalePreference,
  type LocaleStorage,
} from "@linkshell/client-core";
import Storage from "expo-sqlite/kv-store";
import { useCallback, useSyncExternalStore } from "react";

export {
  dateLocaleTag,
  detectLocale,
  LOCALE_LABELS,
  resolveLocalePreference,
  translateKey,
  type I18nKey,
  type I18nVars,
  type Locale,
  type LocalePreference,
};

export interface LocalizedTriplet {
  zh: string;
  en: string;
  ja: string;
}

export function pickLocaleText(locale: Locale, copy: LocalizedTriplet): string {
  return copy[locale] ?? copy.en;
}

function detectDeviceSystemLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

const kvStorage: LocaleStorage = {
  getItem(key: string): string | null {
    try {
      return Storage.getItemSync(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      Storage.setItemSync(key, value);
    } catch {
      // Ignore storage write errors in restricted test sandboxes.
    }
  },
};

export const mobileLocaleStore = createLocaleStore({
  storage: kvStorage,
  systemLocale: detectDeviceSystemLocale(),
});

export function getMobileLocale(): Locale {
  return mobileLocaleStore.getLocale();
}

export function getMobileLocalePreference(): LocalePreference {
  return mobileLocaleStore.getPreference();
}

export function setMobileLocalePreference(preference: LocalePreference): Locale {
  return mobileLocaleStore.setPreference(preference, detectDeviceSystemLocale());
}

export function mt(key: I18nKey, vars?: I18nVars): string {
  return mobileLocaleStore.t(key, vars);
}

export const MOBILE_LOCALE_OPTIONS: ReadonlyArray<{
  value: LocalePreference;
  label: (locale: Locale) => string;
}> = [
  { value: "system", label: (locale) => translateKey(locale, "locale.system") },
  { value: "zh", label: () => LOCALE_LABELS.zh },
  { value: "en", label: () => LOCALE_LABELS.en },
  { value: "ja", label: () => LOCALE_LABELS.ja },
];

function subscribeSnapshot(onStoreChange: () => void): () => void {
  return mobileLocaleStore.subscribe(() => onStoreChange());
}

function getSnapshot(): string {
  return `${mobileLocaleStore.getPreference()}:${mobileLocaleStore.getLocale()}`;
}

export function useLocale() {
  useSyncExternalStore(subscribeSnapshot, getSnapshot, getSnapshot);
  const locale = mobileLocaleStore.getLocale();
  const preference = mobileLocaleStore.getPreference();

  const t = useCallback(
    (key: I18nKey, vars?: I18nVars) => translateKey(locale, key, vars),
    [locale],
  );

  const pick = useCallback(
    (copy: LocalizedTriplet) => pickLocaleText(locale, copy),
    [locale],
  );

  const setPreference = useCallback((next: LocalePreference) => {
    setMobileLocalePreference(next);
  }, []);

  return {
    locale,
    preference,
    setPreference,
    t,
    pick,
    speechLocale: dateLocaleTag(locale),
  };
}
