import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  createCssVariablesTheme,
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/** A run of code in one CSS variable colour; undefined means the block's default text colour. */
export interface HighlightToken {
  content: string;
  color?: string;
}

const grammarLoaders: Record<string, () => Promise<{ default: LanguageRegistration[] }>> = {
  astro: () => import("shiki/langs/astro.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  bat: () => import("shiki/langs/bat.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  clojure: () => import("shiki/langs/clojure.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  haskell: () => import("shiki/langs/haskell.mjs"),
  hcl: () => import("shiki/langs/hcl.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  latex: () => import("shiki/langs/latex.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  makefile: () => import("shiki/langs/makefile.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  nginx: () => import("shiki/langs/nginx.mjs"),
  nix: () => import("shiki/langs/nix.mjs"),
  "objective-c": () => import("shiki/langs/objective-c.mjs"),
  perl: () => import("shiki/langs/perl.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  prisma: () => import("shiki/langs/prisma.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sass: () => import("shiki/langs/sass.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  terraform: () => import("shiki/langs/terraform.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  vim: () => import("shiki/langs/vim.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
};

export const loadableGrammars = Object.keys(grammarLoaders);
const grammarSet = new Set(loadableGrammars);

const languageAliases: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  shellscript: "bash",
  fish: "bash",
  ksh: "bash",
  py: "python",
  python3: "python",
  rb: "ruby",
  rs: "rust",
  golang: "go",
  yml: "yaml",
  md: "markdown",
  mdx: "markdown",
  kt: "kotlin",
  kts: "kotlin",
  objc: "objective-c",
  "objective-c": "objective-c",
  m: "objective-c",
  mm: "objective-c",
  cs: "csharp",
  "c#": "csharp",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  h: "c",
  docker: "dockerfile",
  containerfile: "dockerfile",
  tf: "terraform",
  tfvars: "terraform",
  ps1: "powershell",
  pwsh: "powershell",
  ps: "powershell",
  cmd: "bat",
  batch: "bat",
  htm: "html",
  xhtml: "html",
  svg: "xml",
  plist: "xml",
  xsd: "xml",
  patch: "diff",
  gql: "graphql",
  tex: "latex",
  mk: "makefile",
  make: "makefile",
  protobuf: "proto",
  conf: "ini",
  cfg: "ini",
  properties: "ini",
  env: "ini",
  json5: "jsonc",
  jsonl: "json",
  ndjson: "json",
  babelrc: "json",
  eslintrc: "jsonc",
  ex: "elixir",
  exs: "elixir",
  hs: "haskell",
  clj: "clojure",
  cljs: "clojure",
  pl: "perl",
  rmd: "r",
};

const knownFileNames: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
  brewfile: "ruby",
  "cmakelists.txt": "makefile",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".profile": "bash",
  ".env": "ini",
  ".gitconfig": "ini",
  ".editorconfig": "ini",
};

export function grammarFor(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const name = language.trim().toLowerCase();
  const resolved = languageAliases[name] ?? name;
  return grammarSet.has(resolved) ? resolved : undefined;
}

export function grammarForPath(path: string): string | undefined {
  const leaf = path.split(/[\\/]/).at(-1);
  if (!leaf) return undefined;
  const name = leaf.toLowerCase();
  if (knownFileNames[name]) return knownFileNames[name];
  if (name.startsWith("dockerfile.")) return "dockerfile";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? grammarFor(name.slice(dot + 1)) : undefined;
}

const MAX_HIGHLIGHT_CHARS = 60_000;
const MAX_HIGHLIGHT_LINES = 2_000;

export function worthHighlighting(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_CHARS) return false;
  let lines = 1;
  for (let at = code.indexOf("\n"); at !== -1; at = code.indexOf("\n", at + 1)) {
    if (++lines > MAX_HIGHLIGHT_LINES) return false;
  }
  return true;
}

/** Yields back to Chromium's main thread between heavy tokenization slices (`scheduler.yield()`). */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const shikiTheme = createCssVariablesTheme({
  name: "linkshell",
  variablePrefix: "--code-",
  fontStyle: false,
});
const plainColor = "var(--code-foreground)";

let highlighterPromise: Promise<HighlighterCore> | undefined;
const loadingGrammars = new Map<string, Promise<void>>();

async function ensureLanguageLoaded(language: string): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [shikiTheme],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  const core = await highlighterPromise;
  if (!core.getLoadedLanguages().includes(language)) {
    let pending = loadingGrammars.get(language);
    if (!pending) {
      const loader = grammarLoaders[language];
      if (!loader) throw new Error(`Unsupported Shiki grammar: ${language}`);
      pending = loader().then((mod) => core.loadLanguage(...mod.default));
      loadingGrammars.set(language, pending);
      pending.catch(() => loadingGrammars.delete(language));
    }
    await pending;
  }
  return core;
}

const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export async function tokenize(code: string, language: string): Promise<HighlightToken[][]> {
  const core = await ensureLanguageLoaded(language);
  const started = nowMs();
  const rawLines = core.codeToTokensBase(code, { lang: language, theme: "linkshell" });
  if (nowMs() - started > 45) {
    await yieldToMain();
  }
  const out: HighlightToken[][] = new Array(rawLines.length);
  let sliceStart = nowMs();
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!;
    out[i] = line.map((token) =>
      token.color && token.color !== plainColor
        ? { content: token.content, color: token.color }
        : { content: token.content },
    );
    if ((i & 255) === 255 && nowMs() - sliceStart > 45) {
      await yieldToMain();
      sliceStart = nowMs();
    }
  }
  return out;
}

const tokenCache = new Map<string, HighlightToken[][]>();
const TOKEN_CACHE_LIMIT = 200;

function rememberTokens(key: string, tokens: HighlightToken[][]): void {
  tokenCache.delete(key);
  tokenCache.set(key, tokens);
  if (tokenCache.size > TOKEN_CACHE_LIMIT) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) tokenCache.delete(oldest);
  }
}

export function clearHighlightCacheForTests(): void {
  tokenCache.clear();
}

const waitForIdle = () =>
  new Promise<void>((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve(), { timeout: 300 });
    } else {
      setTimeout(resolve, 16);
    }
  });

export function useHighlight(
  code: string,
  language: string | undefined,
  enabled = true,
): HighlightToken[][] | undefined {
  const grammar = grammarFor(language);
  const key = grammar && `${grammar}\0${code}`;
  const [result, setResult] = useState<{ key: string; tokens: HighlightToken[][] }>();

  useEffect(() => {
    if (!enabled || !key || !grammar || tokenCache.has(key) || !worthHighlighting(code)) return;
    let alive = true;
    void waitForIdle()
      .then(() => (alive ? tokenize(code, grammar) : undefined))
      .then((tokens) => {
        if (!tokens) return;
        rememberTokens(key, tokens);
        if (alive) setResult({ key, tokens });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [code, enabled, grammar, key]);

  if (!key) return undefined;
  return result?.key === key ? result.tokens : tokenCache.get(key);
}

export function renderHighlightedTokens(lines: HighlightToken[][]): ReactNode {
  return lines.map((line, lineIndex) => (
    <span key={lineIndex}>
      {line.map((token, tokenIndex) =>
        token.color ? (
          <span key={tokenIndex} style={{ color: token.color }}>
            {token.content}
          </span>
        ) : (
          token.content
        ),
      )}
      {lineIndex < lines.length - 1 ? "\n" : null}
    </span>
  ));
}

export interface HighlightedCodeBlockProps {
  code: string;
  language?: string;
  streaming?: boolean;
  className?: string;
}

export function HighlightedCodeBlock({
  code,
  language,
  streaming = false,
  className,
}: HighlightedCodeBlockProps) {
  const tokens = useHighlight(code, language, !streaming);
  return (
    <pre className={className} tabIndex={0}>
      <code>{tokens ? renderHighlightedTokens(tokens) : code}</code>
    </pre>
  );
}

/**
 * Smooth backlog-following text release buffer (matching Codex desktop streaming dynamics).
 * Times are measured in seconds.
 */
export class SmoothRelease {
  private rate = 1;
  private shown: number;
  private target: number;
  private lastArrival?: number;
  private lastDrain?: number;
  private carry = 0;

  constructor(length: number, private readonly floor = 10) {
    this.shown = length;
    this.target = length;
  }

  get length(): number {
    return this.shown;
  }

  get pending(): boolean {
    return this.shown < this.target;
  }

  arrive(length: number, now: number): void {
    if (length < this.target) {
      this.reset(length);
      return;
    }
    const added = length - this.target;
    this.target = length;
    if (added <= 0) return;
    this.rate =
      this.lastArrival === undefined
        ? added
        : Math.max(
            1,
            0.1 * (added / Math.max(now - this.lastArrival, this.floor)) + 0.9 * this.rate,
          );
    this.lastArrival = now;
  }

  drain(now: number): number {
    const elapsed = this.lastDrain === undefined ? 0 : now - this.lastDrain;
    this.lastDrain = now;
    const backlog = this.target - this.shown;
    for (let step = 0; step < (elapsed + this.carry) / 0.05; step++) {
      if (backlog && backlog < this.rate * 1.5) this.rate = (backlog + this.rate * 1.5) / 2;
      if (backlog > this.rate / 1.2) this.rate = (backlog + this.rate / 1.2) / 2;
    }
    this.rate = Math.max(1, this.rate);
    const amount = elapsed * this.rate + this.carry;
    const whole = Math.floor(amount);
    this.carry = amount - whole;
    if (whole >= 1) this.shown = Math.min(this.shown + whole, this.target);
    if (this.shown === this.target) {
      this.lastDrain = undefined;
      this.carry = 0;
    }
    return this.shown;
  }

  flush(): number {
    this.shown = this.target;
    this.lastDrain = undefined;
    this.carry = 0;
    return this.shown;
  }

  private reset(length: number): void {
    this.rate = 1;
    this.carry = 0;
    this.lastArrival = undefined;
    this.lastDrain = undefined;
    this.target = length;
    this.shown = length;
  }
}

function safeUtf16SliceEnd(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return Math.max(0, Math.min(end, text.length));
  const code = text.charCodeAt(end);
  return code >= 0xdc00 && code <= 0xdfff ? end + 1 : end;
}

const nowSeconds = () => nowMs() / 1000;
const isDocHidden = () => typeof document !== "undefined" && document.hidden;

export function useSmoothText(text: string, streaming: boolean): string {
  const release = useRef<SmoothRelease | null>(null);
  release.current ??= new SmoothRelease(text.length);
  const [, publish] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frame = useRef(0);
  const wasStreaming = useRef(streaming);

  useLayoutEffect(() => {
    const buffer = release.current!;
    const resuming = streaming && !wasStreaming.current;
    wasStreaming.current = streaming;
    buffer.arrive(text.length, nowSeconds());
    if (!streaming || isDocHidden() || resuming) {
      const before = buffer.length;
      buffer.flush();
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = undefined;
      if (frame.current && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(frame.current);
      }
      frame.current = 0;
      if (streaming && buffer.length !== before) publish((value) => value + 1);
      return;
    }
    const tick = () => {
      timer.current = undefined;
      const before = buffer.length;
      const after = isDocHidden() ? buffer.flush() : buffer.drain(nowSeconds());
      if (after !== before && !frame.current) {
        if (typeof requestAnimationFrame === "function") {
          frame.current = requestAnimationFrame(() => {
            frame.current = 0;
            publish((value) => value + 1);
          });
        } else {
          publish((value) => value + 1);
        }
      }
      if (buffer.pending) timer.current = setTimeout(tick, 50);
    };
    if (timer.current === undefined) tick();
  }, [text, streaming]);

  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
      if (frame.current && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(frame.current);
      }
    },
    [],
  );

  if (!streaming) return text;
  return text.slice(0, safeUtf16SliceEnd(text, release.current.length));
}

/**
 * Splits Markdown at top-level blank-line boundaries outside fences/lists/quotes/tables so
 * completed blocks keep stable React subtree memoization while only the tail block reparses.
 */
export function markdownBlocks(text: string): string[] {
  if (/^ {0,3}\[[^\]]+\]:/m.test(text)) return [text];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: { char: string; length: number } | undefined;
  const joined = (line: string | undefined) =>
    Boolean(
      line &&
        /^(\s{2,}|\t|\s{0,3}([-*+]|\d{1,9}[.)])(\s|$)|\s{0,3}>|\s*\|)/.test(line),
    );
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = { char: marker[0]!, length: marker.length };
      else if (
        marker[0] === fence.char &&
        marker.length >= fence.length &&
        /^ {0,3}[`~]+\s*$/.test(line)
      ) {
        fence = undefined;
      }
    }
    current.push(line);
    if (fence || line.trim() !== "" || index === lines.length - 1) continue;
    const before = [...current].reverse().find((one) => one.trim() !== "");
    const after = lines.slice(index + 1).find((one) => one.trim() !== "");
    if (!before || !after || joined(before) || joined(after)) continue;
    blocks.push(`${current.join("\n")}\n`);
    current = [];
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks.filter((block) => block !== "");
}
