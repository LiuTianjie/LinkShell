import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore, type LanguageRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { HighlightToken } from "./highlight";

// Each grammar is its own chunk, fetched the first time a block in that language appears.
const grammars: Record<string, () => Promise<{ default: LanguageRegistration[] }>> = {
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

/** For the test that keeps highlight.ts's list in step with this one. */
export const loadableGrammars = Object.keys(grammars);

// The colours are CSS variables (theme.ts), so light and dark switch without highlighting again.
const theme = createCssVariablesTheme({ name: "linkshell", variablePrefix: "--code-", fontStyle: false });
const plain = "var(--code-foreground)";

let highlighter: Promise<HighlighterCore> | undefined;
const loading = new Map<string, Promise<void>>();

async function ready(language: string): Promise<HighlighterCore> {
  // The JavaScript engine needs no wasm; `forgiving` skips the few patterns it can't translate
  // instead of failing the whole grammar.
  highlighter ??= createHighlighterCore({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
  const core = await highlighter;
  if (!core.getLoadedLanguages().includes(language)) {
    let load = loading.get(language);
    if (!load) {
      load = grammars[language]!().then((module) => core.loadLanguage(...module.default));
      loading.set(language, load);
      load.catch(() => loading.delete(language));
    }
    await load;
  }
  return core;
}

export async function tokenize(code: string, language: string): Promise<HighlightToken[][]> {
  const core = await ready(language);
  return core.codeToTokensBase(code, { lang: language, theme: "linkshell" }).map((line) =>
    line.map((token) => (token.color && token.color !== plain ? { content: token.content, color: token.color } : { content: token.content })),
  );
}
