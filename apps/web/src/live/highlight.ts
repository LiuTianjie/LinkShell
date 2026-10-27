import { useEffect, useState } from "react";

/** A run of code in one colour; no colour is the block's own text colour. */
export interface HighlightToken {
  content: string;
  color?: string;
}

// What a fence or a file name calls a language → the grammar that reads it.
const aliases: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", shellscript: "bash", fish: "bash", ksh: "bash",
  py: "python", python3: "python", rb: "ruby", rs: "rust", golang: "go",
  yml: "yaml", md: "markdown", mdx: "markdown", kt: "kotlin", kts: "kotlin",
  objc: "objective-c", "objective-c": "objective-c", m: "objective-c", mm: "objective-c",
  cs: "csharp", "c#": "csharp", "c++": "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", h: "c",
  docker: "dockerfile", containerfile: "dockerfile", tf: "terraform", tfvars: "terraform",
  ps1: "powershell", pwsh: "powershell", ps: "powershell", cmd: "bat", batch: "bat",
  htm: "html", xhtml: "html", svg: "xml", plist: "xml", xsd: "xml",
  patch: "diff", gql: "graphql", tex: "latex", mk: "makefile", make: "makefile",
  protobuf: "proto", conf: "ini", cfg: "ini", properties: "ini", env: "ini",
  json5: "jsonc", jsonl: "json", ndjson: "json", babelrc: "json", eslintrc: "jsonc",
  ex: "elixir", exs: "elixir", hs: "haskell", clj: "clojure", cljs: "clojure", pl: "perl", rmd: "r",
};

// Every grammar highlight-engine.ts can load; kept here so a block in an unknown language never
// pulls the highlighter in at all.
const grammars = new Set([
  "astro", "bash", "bat", "c", "clojure", "cpp", "csharp", "css", "dart", "diff", "dockerfile", "elixir", "go",
  "graphql", "haskell", "hcl", "html", "ini", "java", "javascript", "json", "jsonc", "jsx", "kotlin", "latex",
  "less", "lua", "makefile", "markdown", "nginx", "nix", "objective-c", "perl", "php", "powershell", "prisma",
  "proto", "python", "r", "ruby", "rust", "sass", "scala", "scss", "sql", "svelte", "swift", "terraform", "toml",
  "tsx", "typescript", "vim", "vue", "xml", "yaml", "zig",
]);

/** The grammar for a fence's language (```ts, ```shell …), or undefined for plain text. */
export function grammarFor(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const name = language.toLowerCase();
  const resolved = aliases[name] ?? name;
  return grammars.has(resolved) ? resolved : undefined;
}

const fileNames: Record<string, string> = {
  dockerfile: "dockerfile", containerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile",
  gemfile: "ruby", rakefile: "ruby", podfile: "ruby", brewfile: "ruby", "cmakelists.txt": "makefile",
  ".bashrc": "bash", ".zshrc": "bash", ".profile": "bash", ".env": "ini", ".gitconfig": "ini", ".editorconfig": "ini",
};

/** The grammar for a file, from its name or extension. */
export function grammarForPath(path: string): string | undefined {
  const name = path.split(/[\\/]/).at(-1)!.toLowerCase();
  if (fileNames[name]) return fileNames[name];
  if (name.startsWith("dockerfile.")) return "dockerfile";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? grammarFor(name.slice(dot + 1)) : undefined;
}

// Past this the JavaScript regex engine costs more than the colours are worth: the block stays plain.
const MAX_CHARS = 60_000;
const MAX_LINES = 2_000;

export function worthHighlighting(code: string): boolean {
  if (code.length > MAX_CHARS) return false;
  let lines = 1;
  for (let at = code.indexOf("\n"); at !== -1; at = code.indexOf("\n", at + 1)) if (++lines > MAX_LINES) return false;
  return true;
}

// Recent results, so a block that scrolls out of a list and back, or a message rendered again,
// keeps its colours without a frame of plain text.
const cache = new Map<string, HighlightToken[][]>();
const CACHE_SIZE = 200;

function remember(key: string, tokens: HighlightToken[][]) {
  cache.delete(key);
  cache.set(key, tokens);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
}

const idle = () =>
  new Promise<void>((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 300 });
    else setTimeout(resolve, 16);
  });

/**
 * The code's tokens once highlighted, undefined until then (and for plain text). Nothing runs
 * while `enabled` is false: a block still streaming is left plain, and coloured once complete.
 */
export function useHighlight(code: string, language: string | undefined, enabled = true): HighlightToken[][] | undefined {
  const grammar = grammarFor(language);
  const key = grammar && `${grammar}\0${code}`;
  const [result, setResult] = useState<{ key: string; tokens: HighlightToken[][] }>();
  useEffect(() => {
    if (!enabled || !key || !grammar || cache.has(key) || !worthHighlighting(code)) return;
    let alive = true;
    // Off the frame that rendered the block, and out of the way of input and scrolling.
    void idle()
      .then(() => (alive ? import("./highlight-engine").then((engine) => engine.tokenize(code, grammar)) : undefined))
      .then((tokens) => {
        if (!tokens) return;
        remember(key, tokens);
        if (alive) setResult({ key, tokens });
      })
      // A grammar that fails to load leaves the block as plain text, which it already is.
      .catch(() => undefined);
    return () => { alive = false; };
  }, [code, enabled, grammar, key]);
  if (!key) return undefined;
  return result?.key === key ? result.tokens : cache.get(key);
}
