import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { createContext, use } from "react";
import { Linking } from "react-native";
import { colors } from "@/theme/colors";

// Where links in agent messages go. Agents mostly link to files on the
// computer (absolute paths, sometimes with a line: `a.ts:42`, `a.ts#L42`);
// those open in the file viewer. Web links open in the in-app browser.

/** The directory relative links resolve against: the session's project. */
export const LinkBase = createContext<string | undefined>(undefined);

export function useLinkBase(): string | undefined {
  return use(LinkBase);
}

export interface FileTarget {
  path: string;
  line?: number;
}

/** A link that names a file on the computer, or undefined for anything else. */
export function fileTarget(url: string, base?: string): FileTarget | undefined {
  let target = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !target.startsWith("file://")) return undefined;
  if (/^(mailto|tel|sms):/i.test(target)) return undefined;
  target = target.replace(/^file:\/\//, "");
  try {
    target = decodeURI(target);
  } catch {
    // Keep it as written.
  }
  let line: number | undefined;
  const hash = /#L(\d+)(?:-L?\d+)?$/.exec(target);
  if (hash) {
    line = Number(hash[1]);
    target = target.slice(0, hash.index);
  } else {
    const suffix = /:(\d+)(?::\d+)?$/.exec(target);
    if (suffix) {
      line = Number(suffix[1]);
      target = target.slice(0, suffix.index);
    }
  }
  if (!target) return undefined;
  if (!target.startsWith("/") && !target.startsWith("~")) {
    if (!base) return undefined;
    target = `${base.replace(/\/$/, "")}/${target.replace(/^\.\//, "")}`;
  }
  return { path: target, line };
}

export function openFile(target: FileTarget): void {
  router.push({ pathname: "/file", params: { path: target.path, ...(target.line ? { line: String(target.line) } : {}) } });
}

export function openLink(url: string, base?: string): void {
  const file = fileTarget(url, base);
  if (file) {
    openFile(file);
    return;
  }
  if (/^https?:\/\//i.test(url)) {
    void WebBrowser.openBrowserAsync(url, {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      controlsColor: colors.accent as string,
      dismissButtonStyle: "close",
    }).catch(() => Linking.openURL(url).catch(() => {}));
    return;
  }
  void Linking.openURL(url).catch(() => {});
}
