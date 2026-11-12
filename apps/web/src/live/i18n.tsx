import { useCallback, useSyncExternalStore } from "react";
import { Languages } from "lucide-react";
import {
  LOCALE_LABELS,
  LOCALE_STORAGE_KEY,
  dateLocaleTag,
  defaultLocaleStore,
  getLocale,
  getLocalePreference,
  isLocalePreference,
  setLocalePreference,
  subscribeLocale,
  t as translate,
  type I18nKey,
  type I18nVars,
  type Locale,
  type LocalePreference,
} from "@linkshell/client-core";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isDesktop, readDesktopStorage, saveDesktopStorage } from "./desktop";

if (typeof window === "undefined") {
  // Server/Node rendering defaults to zh unless explicitly switched via setLocalePreference.
  defaultLocaleStore.setSystemLocale("zh");
} else {
  if (isDesktop) {
    try {
      const saved = readDesktopStorage<string | undefined>(LOCALE_STORAGE_KEY, undefined);
      if (saved && isLocalePreference(saved)) {
        defaultLocaleStore.setPreference(saved);
      }
    } catch {
      // Desktop bootstrap may not be ready yet; browser storage fallback still applies.
    }
  }
  const syncDocument = (locale: Locale) => {
    try {
      document.documentElement.lang = dateLocaleTag(locale);
    } catch {
      // Ignore non-DOM test environments.
    }
    try {
      localStorage.setItem("linkshell.screen.lang", locale);
    } catch {
      // Ignore storage restrictions.
    }
  };
  syncDocument(defaultLocaleStore.getLocale());
  subscribeLocale((locale) => syncDocument(locale));
}

export function setWebLocalePreference(preference: LocalePreference): Locale {
  const resolved = setLocalePreference(preference);
  if (isDesktop) {
    try {
      void saveDesktopStorage(LOCALE_STORAGE_KEY, preference);
    } catch {
      // Keep in-memory locale active even if persistence fails.
    }
  }
  return resolved;
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

export function useLocalePreference(): LocalePreference {
  return useSyncExternalStore(subscribeLocale, getLocalePreference, getLocalePreference);
}

export function useT(): (key: I18nKey, vars?: I18nVars) => string {
  const locale = useLocale();
  return useCallback((key: I18nKey, vars?: I18nVars) => translate(locale, key, vars), [locale]);
}

export function LanguageDropdown({ size = "icon" }: { size?: "icon" | "sm" }) {
  const preference = useLocalePreference();
  const locale = useLocale();
  const t = useT();
  const label = t("locale.label");
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size={size} aria-label={label}>
              <Languages />
              {size === "sm" && <span>{LOCALE_LABELS[locale]}</span>}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" sideOffset={6}>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(value) => {
            if (isLocalePreference(value)) setWebLocalePreference(value);
          }}
        >
          <DropdownMenuRadioItem value="system">{t("locale.system")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="zh">{LOCALE_LABELS.zh}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="en">{LOCALE_LABELS.en}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="ja">{LOCALE_LABELS.ja}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function LanguageTabs() {
  const preference = useLocalePreference();
  const t = useT();
  return (
    <Tabs
      value={preference}
      onValueChange={(value) => {
        if (isLocalePreference(value)) setWebLocalePreference(value);
      }}
    >
      <TabsList variant="line" aria-label={t("locale.label")}>
        <TabsTrigger value="system">{t("locale.system")}</TabsTrigger>
        <TabsTrigger value="zh">{LOCALE_LABELS.zh}</TabsTrigger>
        <TabsTrigger value="en">{LOCALE_LABELS.en}</TabsTrigger>
        <TabsTrigger value="ja">{LOCALE_LABELS.ja}</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
