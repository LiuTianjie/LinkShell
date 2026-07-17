import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeSdkClient } from "../src/runtime/acp/claude-sdk-client.js";

function makeClient() {
  const cwd = mkdtempSync(join(tmpdir(), "linkshell-claude-cache-"));
  const client = new ClaudeSdkClient({
    command: "claude",
    protocol: "claude-agent-sdk",
    framing: "newline",
    cwd,
    onNotification: () => {},
    onRequest: () => undefined,
    onExit: () => {},
  }) as any;
  return { client, cwd };
}

function transcriptLine(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    uuid: `turn-${text}`,
    timestamp: "2026-07-17T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
    ...extra,
  }) + "\n";
}

function writeTranscript(dir: string, name: string, lines: string): string {
  const filePath = join(dir, `${name}.jsonl`);
  writeFileSync(filePath, lines);
  return filePath;
}

describe("ClaudeSdkClient parsed-transcript cache", () => {
  it("parses fresh, then reuses the cached parse while mtime/size are unchanged", () => {
    const { client, cwd } = makeClient();
    const filePath = writeTranscript(cwd, "s1", transcriptLine("hello"));

    const first = client.parsedTranscript(filePath, "s1");
    const second = client.parsedTranscript(filePath, "s1");
    // Same object identity ⇒ no re-read/re-parse happened.
    expect(second).toBe(first);
    expect((first.thread as any).turns).toHaveLength(1);
  });

  it("invalidates when the file is appended to (mtime/size change)", () => {
    const { client, cwd } = makeClient();
    const filePath = writeTranscript(cwd, "s2", transcriptLine("one"));

    const first = client.parsedTranscript(filePath, "s2");
    expect((first.thread as any).turns).toHaveLength(1);

    appendFileSync(filePath, transcriptLine("two"));
    const second = client.parsedTranscript(filePath, "s2");
    expect(second).not.toBe(first);
    expect((second.thread as any).turns).toHaveLength(2);
  });

  it("captures the last-seen permissionMode in the cached parse", () => {
    const { client, cwd } = makeClient();
    const filePath = writeTranscript(
      cwd,
      "s3",
      transcriptLine("a", { permissionMode: "default" }) +
        transcriptLine("b", { permissionMode: "acceptEdits" }),
    );
    const parsed = client.parsedTranscript(filePath, "s3");
    expect((parsed.thread as any).permissionMode).toBe("acceptEdits");
  });

  it("bounds the cache to 8 entries, evicting least-recently-used first", () => {
    const { client, cwd } = makeClient();
    const paths = Array.from({ length: 9 }, (_, i) =>
      writeTranscript(cwd, `lru-${i}`, transcriptLine(`t${i}`)),
    );
    const firstParse = client.parsedTranscript(paths[0], "lru-0");
    // Fill entries 1..7, then touch entry 0 so it becomes most-recent.
    for (let i = 1; i < 8; i += 1) client.parsedTranscript(paths[i], `lru-${i}`);
    expect(client.parsedTranscript(paths[0], "lru-0")).toBe(firstParse);
    // 9th distinct file exceeds the bound — the LRU entry (index 1) is evicted,
    // while the recently-touched entry 0 survives.
    client.parsedTranscript(paths[8], "lru-8");
    expect(client.parsedTranscriptCache.size).toBe(8);
    expect(client.parsedTranscriptCache.has(paths[1])).toBe(false);
    expect(client.parsedTranscriptCache.has(paths[0])).toBe(true);
  });

  it("readSessionConfig maps permission mode from the shared cached parse", async () => {
    const { client, cwd } = makeClient();
    const filePath = writeTranscript(
      cwd,
      "s4",
      transcriptLine("a", { permissionMode: "bypassPermissions" }),
    );
    // Warm the cache directly (resolveSessionFile scans ~/.claude in prod).
    client.resolveSessionFile = () => filePath;
    const config = await client.readSessionConfig({ sessionId: "s4" });
    expect(config).toEqual({ permissionMode: "full_access" });
  });
});
