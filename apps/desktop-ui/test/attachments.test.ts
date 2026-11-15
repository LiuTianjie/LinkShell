import { describe, expect, it } from "vitest";
import { buildPromptContentBlocks, prepareComposerAttachment } from "../src/features/session/session-helpers";

const claude = { images: true, embeddedContext: true };

describe("composer attachments", () => {
  it("sends text inline by its bytes when the system gives it no text type", async () => {
    // How Windows can type a Markdown file and a TypeScript one.
    const markdown = await prepareComposerAttachment(new File(["# 说明\nhello"], "notes.md", { type: "" }));
    const typescript = await prepareComposerAttachment(new File(["export const a = 1;\n"], "a.ts", { type: "video/vnd.dlna.mpeg-tts" }));
    const blocks = await buildPromptContentBlocks({ text: "", pastedBlocks: [], attachments: [markdown, typescript], capabilities: claude });
    expect(blocks).toEqual([
      { type: "resource", resource: { uri: "attachment:notes.md", mimeType: "text/plain", text: "# 说明\nhello" } },
      { type: "resource", resource: { uri: "attachment:a.ts", mimeType: "text/plain", text: "export const a = 1;\n" } },
    ]);
  });

  it("uploads binary files instead of embedding a blob an agent may drop", async () => {
    const pdf = await prepareComposerAttachment(new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0xff, 0xfe])], "spec.pdf", { type: "application/pdf" }));
    expect(pdf.isText).toBe(false);
    const uploads: string[] = [];
    const blocks = await buildPromptContentBlocks({
      text: "看看", pastedBlocks: [], attachments: [pdf], capabilities: claude, uploadDir: "C:\\work",
      callUpload: async (dir, name) => { uploads.push(name); return { path: `${dir}\\${name}` }; },
    });
    expect(uploads).toEqual(["spec.pdf"]);
    expect(blocks).toEqual([{ type: "text", text: "看看" }, { type: "resource_link", uri: "C:\\work\\spec.pdf", name: "spec.pdf" }]);
  });
});
