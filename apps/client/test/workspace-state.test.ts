import { describe, expect, it, vi } from "vitest";
import { createSessionSubscriptions } from "../src/lib/session-subscriptions";
import { composerDraftKey, createComposerDrafts } from "../src/lib/composer-drafts";
import { workspaceLayout } from "../src/lib/workspace-layout";

describe("workspace continuity", () => {
  it("keeps a session subscribed when its detail route closes over the home pane", () => {
    const open = vi.fn();
    const close = vi.fn();
    const subscribe = createSessionSubscriptions(open, close);
    const home = subscribe("one");
    const detail = subscribe("one");
    const other = subscribe("two");
    detail();
    detail();
    expect(open.mock.calls).toEqual([["one"], ["two"]]);
    expect(close).not.toHaveBeenCalled();
    home();
    expect(close.mock.calls).toEqual([["one"]]);
    other();
    expect(close.mock.calls).toEqual([["one"], ["two"]]);
  });

  it("shares an unsent draft across panes without mixing computers", () => {
    const drafts = createComposerDrafts();
    const a = composerDraftKey("computer-a", "session");
    const b = composerDraftKey("computer-b", "session");
    const photo = { uri: "file:///photo.jpg", mimeType: "image/jpeg", data: "test-image" };
    drafts.getState().update(a, () => ({ text: "继续检查", attachments: [photo] }));
    drafts.getState().update(b, () => ({ text: "另一个项目", attachments: [] }));
    drafts.getState().update(a, (draft) => ({ ...draft, text: draft.text + "预览" }));
    expect(drafts.getState().entries[a]).toEqual({ text: "继续检查预览", attachments: [photo] });
    expect(drafts.getState().entries[b]?.text).toBe("另一个项目");
    drafts.getState().update(a, () => ({ text: "", attachments: [] }));
    expect(drafts.getState().entries[a]).toBeUndefined();
    expect(drafts.getState().entries[b]?.text).toBe("另一个项目");
  });

  it("keeps the words of a draft for the next launch, and forgets them once sent", () => {
    let disk: Record<string, string> = {};
    const storage = { load: () => disk, save: (texts: Record<string, string>) => void (disk = texts) };
    const key = composerDraftKey("computer-a", "session");
    const drafts = createComposerDrafts(storage, 0);
    vi.useFakeTimers();
    try {
      const photo = { uri: "file:///photo.jpg", mimeType: "image/jpeg", data: "test-image" };
      drafts.getState().update(key, () => ({ text: "写到一半", attachments: [photo] }));
      vi.runAllTimers();
      expect(disk).toEqual({ [key]: "写到一半" });
      // The app was closed in the background: the words are back, the photo was memory only.
      expect(createComposerDrafts(storage).getState().entries[key]).toEqual({ text: "写到一半", attachments: [] });
      drafts.getState().update(key, () => ({ text: "", attachments: [] }));
      vi.runAllTimers();
      expect(disk).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts empty when the kept drafts cannot be read", () => {
    const drafts = createComposerDrafts({ load: () => { throw new Error("corrupt"); }, save: () => {} });
    expect(drafts.getState().entries).toEqual({});
  });

  it("uses the available space and text size instead of a phone/tablet label", () => {
    expect(workspaceLayout(420).split).toBe(false);
    expect(workspaceLayout(900).split).toBe(true);
    expect(workspaceLayout(900, 1.8).split).toBe(false);
    const wide = workspaceLayout(900);
    expect(wide.paneWidth * 2 + wide.gap).toBe(900);
  });
});
