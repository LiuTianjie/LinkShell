import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import brand from "../../client/src/theme/brand-colors.json";

// brand-colors.json is the one source of LinkShell's hues (docs/design/visual-system.md). Swift
// and the site's CSS can't import it, so they carry copies; this keeps the copies honest.

type Token = keyof typeof brand;

const read = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const hex = (value: string) => value.replace(/^#/, "").toLowerCase();
const light = (token: Token) => hex(brand[token][0]);
const dark = (token: Token) => hex(brand[token][1]);

/** The one line that declares `name`, so a value elsewhere in the file can't stand in for it. */
function declaration(source: string, pattern: RegExp, name: string) {
  const lines = source.split("\n").filter((line) => pattern.test(line));
  expect(lines, `one declaration of ${name}`).toHaveLength(1);
  return lines[0];
}

describe("apps/mac DesktopTheme.swift", () => {
  const source = read("apps/mac/Sources/LinkShell/DesktopTheme.swift");
  const tokens: Token[] = [
    "accent",
    "accentFill",
    "accentHover",
    "ok",
    "waiting",
    "danger",
  ];
  it.each(tokens)("%s is brand-colors.json's light and dark value", (token) => {
    // `static let accentColor = hue(rgb(0x4c5fd5), rgb(0x8d9bff))`: light first, then dark.
    const line = declaration(
      source,
      new RegExp(`static let ${token}Color\\s*=`),
      `${token}Color`,
    );
    const values = [...line.matchAll(/0x([0-9a-f]{6})\b/gi)].map((match) =>
      match[1].toLowerCase(),
    );
    expect(values).toEqual([light(token), dark(token)]);
  });
});

describe("apps/client WatchModels.swift", () => {
  const source = read("apps/client/plugins/watch/WatchModels.swift");
  // The watch is always dark: each colour is the dark value.
  const tokens: Token[] = [
    "accent",
    "accentFill",
    "waiting",
    "waitingFill",
    "ok",
    "danger",
  ];
  it.each(tokens)("%s is brand-colors.json's dark value", (token) => {
    // `Color(red: 0x8d / 255, green: 0x9b / 255, blue: 0xff / 255)`, a bare 1 or 0 for ff or 00.
    const line = declaration(
      source,
      new RegExp(`static let ${token}\\s*=`),
      token,
    );
    const channel = (name: string) => {
      const value = line.match(
        new RegExp(`${name}:\\s*(0x[0-9a-f]{2}|1|0)\\b`, "i"),
      )?.[1];
      if (value === "1") return "ff";
      if (value === "0") return "00";
      return value?.slice(2).toLowerCase();
    };
    expect(`${channel("red")}${channel("green")}${channel("blue")}`).toBe(
      dark(token),
    );
  });
});

describe("docs/site index.src.html", () => {
  const source = read("docs/site/index.src.html");
  // The palette blocks are the first of each: later `:root` rules hold other variables.
  const darkBlock = source.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
  const lightBlock =
    source.match(/:root\[data-theme="light"\]\s*\{([^}]*)\}/)?.[1] ?? "";
  const variables: [string, Token][] = [
    ["--accent", "accent"],
    ["--accent-fill", "accentFill"],
    ["--accent-hover", "accentHover"],
    ["--success", "ok"],
    ["--warning", "waiting"],
    ["--danger", "danger"],
  ];
  const value = (block: string, variable: string) =>
    block
      .match(new RegExp(`${variable}:\\s*#([0-9a-f]{6})\\s*;`, "i"))?.[1]
      .toLowerCase();
  it.each(variables)("%s is brand-colors.json's %s", (variable, token) => {
    expect(value(darkBlock, variable)).toBe(dark(token));
    expect(value(lightBlock, variable)).toBe(light(token));
  });
});

/** `rgba(76,95,213,0.10)` → `["4c5fd5", 0.1]`. */
function rgba(value: string): [string, number] {
  const [r, g, b, a] = value.match(/[\d.]+/g)!.map(Number);
  return [[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join(""), a];
}

describe("apps/mac DesktopTheme.swift soft grounds", () => {
  const source = read("apps/mac/Sources/LinkShell/DesktopTheme.swift");
  const tokens: Token[] = ["accentSoft", "waitingSoft", "dangerSoft"];
  it.each(tokens)("%s is brand-colors.json's light and dark value", (token) => {
    // `static let accentSoft = Color(nsColor: hue(rgb(0x4c5fd5, 0.10), rgb(0x8d9bff, 0.16)))`.
    const line = declaration(source, new RegExp(`static let ${token}\\s*=`), token);
    const values = [...line.matchAll(/rgb\(0x([0-9a-f]{6}),\s*([\d.]+)\)/gi)].map(
      (match): [string, number] => [match[1].toLowerCase(), Number(match[2])],
    );
    expect(values).toEqual([rgba(brand[token][0]), rgba(brand[token][1])]);
  });
});

describe("apps/client with-live-activity.js ActivityPalette", () => {
  const source = read("apps/client/plugins/with-live-activity.js");
  // A Live Activity sits on its own dark ground: each colour is the dark value.
  const tokens: [string, Token][] = [
    ["running", "running"],
    ["accentFill", "accentFill"],
    ["waiting", "waiting"],
    ["danger", "danger"],
  ];
  it.each(tokens)("%s is brand-colors.json's dark %s", (name, token) => {
    const line = declaration(source, new RegExp(`static let ${name}\\s*=\\s*Color\\(`), name);
    const channel = (part: string) => {
      const value = line.match(new RegExp(`${part}:\\s*(0x[0-9a-f]{2}|1|0)\\b`, "i"))?.[1];
      if (value === "1") return "ff";
      if (value === "0") return "00";
      return value?.slice(2).toLowerCase();
    };
    expect(`${channel("red")}${channel("green")}${channel("blue")}`).toBe(dark(token));
  });
});
