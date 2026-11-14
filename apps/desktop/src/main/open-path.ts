import { pathToFileURL } from "node:url";

/** The editors `desktop.openPath` names in @linkshell/wire, plus Xcode, which only a Mac has. */
export const OPEN_PATH_APPS = ["default", "reveal", "cursor", "vscode", "zed", "terminal", "xcode"] as const;
export type OpenPathApp = (typeof OPEN_PATH_APPS)[number];

export type OpenPathPlan =
  | { kind: "default" }
  | { kind: "reveal" }
  | { kind: "spawn"; file: string; args: string[] }
  | { kind: "url"; url: string };

const MAC_APPS: Partial<Record<OpenPathApp, string>> = {
  cursor: "Cursor",
  vscode: "Visual Studio Code",
  zed: "Zed",
  terminal: "Terminal",
  xcode: "Xcode",
};

const URL_SCHEMES: Partial<Record<OpenPathApp, string>> = { cursor: "cursor", vscode: "vscode", zed: "zed" };

export function isOpenPathApp(value: unknown): value is OpenPathApp {
  return typeof value === "string" && (OPEN_PATH_APPS as readonly string[]).includes(value);
}

/**
 * How to open `path` in `app`, never through a shell: the path is always one argv entry or a
 * URL-encoded file URL, so nothing in it can be read as a command.
 */
export function openPathPlan(platform: NodeJS.Platform, app: OpenPathApp, path: string): OpenPathPlan {
  if (app === "default") return { kind: "default" };
  if (app === "reveal") return { kind: "reveal" };
  if (platform === "darwin") return { kind: "spawn", file: "/usr/bin/open", args: ["-a", MAC_APPS[app]!, "--", path] };
  if (app === "xcode") throw new Error("Xcode 只在 macOS 上可用");
  const scheme = URL_SCHEMES[app];
  // Editors register a URL handler on Windows and Linux; their command-line launchers are .cmd
  // scripts on Windows, which Node can only run through a shell.
  if (scheme) return { kind: "url", url: `${scheme}://file${pathToFileURL(path).pathname}` };
  if (platform === "win32") return { kind: "spawn", file: "wt.exe", args: ["-d", path] };
  return { kind: "spawn", file: "x-terminal-emulator", args: [`--working-directory=${path}`] };
}
