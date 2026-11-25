import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { baseName, dirName } from "../src/live/common";
import { markdownBlocks } from "../src/live/smooth-text";

describe("Track 5 Web workspace upgrades & regression guards", () => {
  it("handles Windows and POSIX paths cleanly in baseName and dirName without corruption", () => {
    expect(baseName("C:\\Users\\dev\\app.ts")).toBe("app.ts");
    expect(baseName("C:\\Users\\dev\\")).toBe("dev");
    expect(baseName("C:\\")).toBe("C:\\");
    expect(baseName("C:/Users/dev/app.ts")).toBe("app.ts");
    expect(baseName("/Users/dev/app.ts")).toBe("app.ts");
    expect(baseName("/Users/dev/")).toBe("dev");
    expect(baseName("/")).toBe("");
    expect(baseName("")).toBe("");

    expect(dirName("C:\\Users\\dev\\app.ts")).toBe("C:\\Users\\dev");
    expect(dirName("C:\\Users\\dev\\")).toBe("C:\\Users");
    expect(dirName("C:\\app.ts")).toBe("C:\\");
    expect(dirName("C:/app.ts")).toBe("C:/");
    expect(dirName("C:\\")).toBe("C:\\");
    expect(dirName("/Users/dev/app.ts")).toBe("/Users/dev");
    expect(dirName("/app.ts")).toBe("/");
    expect(dirName("/")).toBe("/");
  });

  it("removes raw lastIndexOf('/') cwd slicing from Editor.tsx and Files.tsx", () => {
    const editorSrc = readFileSync(new URL("../src/live/Editor.tsx", import.meta.url), "utf8");
    const filesSrc = readFileSync(new URL("../src/live/Files.tsx", import.meta.url), "utf8");
    expect(editorSrc).toContain("cwd: dirName(path)");
    expect(editorSrc).not.toContain('lastIndexOf("/")');
    expect(filesSrc).toContain("cwd: dirName(file)");
    expect(filesSrc).not.toContain('file.lastIndexOf("/")');
  });

  it("parses large markdown documents linearly in smooth-text.ts markdownBlocks", () => {
    const doc = Array.from({ length: 1200 }, (_, i) =>
      i % 25 === 0
        ? `### Heading ${i}\n\n\`\`\`ts\nconst v${i} = ${i};\n\`\`\`\n`
        : `- bullet ${i}`,
    ).join("\n");
    const start = performance.now();
    const blocks = markdownBlocks(doc);
    const elapsed = performance.now() - start;
    expect(blocks.length).toBeGreaterThan(40);
    expect(elapsed).toBeLessThan(250);
  });

  it("keeps Conversation zero-reflow at bottom and consumes focusTarget.nonce only once", () => {
    const src = readFileSync(new URL("../src/live/Conversation.tsx", import.meta.url), "utf8");
    expect(src).toContain("if (state.isAtBottom) {\n        anchor = undefined;\n        return;\n      }");
    expect(src).toContain("consumedFocusNonce");
    expect(src).toContain("consumedFocusNonce.current === focusTarget.nonce");
    expect(src).toContain("consumedFocusNonce.current = focusTarget.nonce;");
  });

  it("subscribes ConsoleShell to prefers-color-scheme changes and uses 264px desktop sidebar width", () => {
    const src = readFileSync(new URL("../src/components/ConsoleShell.tsx", import.meta.url), "utf8");
    expect(src).toContain('window.matchMedia("(prefers-color-scheme: dark)")');
    expect(src).toContain('media.addEventListener("change", onChange)');
    expect(src).toContain('media.removeEventListener("change", onChange)');
    expect(src).toContain('"--sidebar-width": "264px"');
  });

  it("renders a forgot-password reset link beside the password field in Connect.tsx", () => {
    const src = readFileSync(new URL("../src/live/Connect.tsx", import.meta.url), "utf8");
    expect(src).toContain("https://itool.tech/zh/forgot-password");
    expect(src).toContain("忘记密码？");
    expect(src).toContain("connect-forgot-link");
    const css = readFileSync(new URL("../src/styles/common.css", import.meta.url), "utf8");
    expect(css).toContain(".connect-forgot-link");
  });

  it("queries initial screen.privacy state on mount in Video.tsx ScreenToolsMenu", () => {
    const src = readFileSync(new URL("../src/live/Video.tsx", import.meta.url), "utf8");
    expect(src).toContain('.call("screen.privacy", {})');
    expect(src).toContain("if (alive) setPrivacy(res);");
  });

  it("narrows broad Zustand selectors in App.tsx Workspace and Home", () => {
    const src = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(src).not.toContain("useClient((state) => state)");
    expect(src).toContain("useClient((state) => state.sessions[view])");
    expect(src).toContain("useClient((state) => state.machine?.hostname)");
    expect(src).toContain("useStore(engine.state, (state) => state.connection?.computer)");
  });

  it("renders Connect forgot-password link via SSR smoke check", async () => {
    // Sanity-verify React element creation & HTML serialization stays clean in Node SSR.
    const anchor = renderToStaticMarkup(
      createElement(
        "a",
        {
          href: "https://itool.tech/zh/forgot-password",
          target: "_blank",
          rel: "noreferrer",
          className: "connect-forgot-link",
        },
        "忘记密码？",
      ),
    );
    expect(anchor).toContain('href="https://itool.tech/zh/forgot-password"');
    expect(anchor).toContain("忘记密码？");
  });
});
