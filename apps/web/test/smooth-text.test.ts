import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SmoothRelease, markdownBlocks } from "../src/live/smooth-text";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, text));
const joined = (text: string) => markdownBlocks(text).map(html).join("");
const strip = (value: string) => value.replace(/\n/g, "");

describe("markdownBlocks", () => {
  const samples: Record<string, string> = {
    paragraphs: "First paragraph.\n\nSecond **bold**.\n\nThird.",
    heading: "# Title\n\nBody text here.\n\n## Next\n\nMore.",
    fence: "Before\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter",
    tildeFence: "~~~\nx\n\ny\n~~~\n\nend",
    looseList: "- one\n\n- two\n\n- three\n\nAfter the list.",
    orderedList: "1. first\n\n   continued\n2. second\n\nDone.",
    quote: "> quoted\n>\n> more\n\nplain",
    table: "| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter table.",
    references: "See [the docs][d].\n\nMore text.\n\n[d]: https://example.com",
    footnote: "A claim.[^1]\n\nMore.\n\n[^1]: The source.",
    unclosedFence: "Intro\n\n```js\nlet x = 1;\n\nlet y",
    trailingBlank: "One.\n\nTwo.\n\n",
  };
  for (const [name, text] of Object.entries(samples)) {
    it(`renders ${name} the same split or whole`, () => {
      expect(strip(joined(text))).toBe(strip(html(text)));
    });
    it(`keeps every character of ${name}`, () => {
      expect(markdownBlocks(text).join("")).toBe(text.endsWith("\n") ? text : text);
    });
  }
  it("splits independent paragraphs so finished ones stay put", () => {
    expect(markdownBlocks("a\n\nb\n\nc")).toHaveLength(3);
  });
  it("keeps a fence with blank lines whole", () => {
    expect(markdownBlocks("```\n1\n\n2\n```")).toHaveLength(1);
  });
});

describe("SmoothRelease", () => {
  /** Every 50 ms for `seconds`, as the hook runs it; the visible length after each. */
  const drain = (release: SmoothRelease, from: number, seconds: number) => {
    const shown: number[] = [];
    for (let tick = 0; tick <= Math.round(seconds * 20); tick++) shown.push(release.drain(from + tick * 0.05));
    return shown;
  };
  it("spreads a burst over the following frames instead of showing it at once", () => {
    const release = new SmoothRelease(0);
    release.arrive(400, 0);
    const shown = drain(release, 0, 2);
    expect(shown[1]).toBeGreaterThan(0);
    expect(shown[1]).toBeLessThan(400);
    // Most of it within a second, then easing to the end (the tail lands softly, as in Codex).
    expect(shown[20]).toBeGreaterThan(300);
    expect(shown.at(-1)).toBeLessThanOrEqual(400);
    for (let i = 1; i < shown.length; i++) expect(shown[i]).toBeGreaterThanOrEqual(shown[i - 1]!);
  });
  it("keeps up with a steady stream without falling behind", () => {
    const release = new SmoothRelease(0);
    let length = 0;
    let shown = 0;
    // 40 characters every 100 ms for 5 s (400 characters a second).
    for (let at = 0; at < 5; at += 0.05) {
      if (Math.round(at * 20) % 2 === 0) { length += 40; release.arrive(length, at); }
      shown = release.drain(at);
    }
    expect(length - shown).toBeLessThan(400);
  });
  it("never runs ahead of the text", () => {
    const release = new SmoothRelease(0);
    release.arrive(5, 0);
    expect(Math.max(...drain(release, 0, 2))).toBe(5);
  });
  it("starts with what was already there", () => {
    const release = new SmoothRelease(120);
    expect(release.length).toBe(120);
    release.arrive(130, 0);
    expect(release.drain(0.05)).toBeLessThanOrEqual(130);
  });
  it("flushes at once and restarts on a replaced text", () => {
    const release = new SmoothRelease(0);
    release.arrive(1000, 0);
    expect(release.flush()).toBe(1000);
    release.arrive(20, 1);
    expect(release.length).toBe(20);
  });
});
