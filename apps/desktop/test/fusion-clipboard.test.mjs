import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FusionClipboard,
  MAX_CLIPBOARD_BYTES,
  buildMacNsFilenamesPlist,
  buildWindowsDropFiles,
  parseMacNsFilenamesPlist,
  parseWindowsDropFiles,
  parseWindowsFileNameW,
  resolveSafeClipFilePath,
} from "../dist/main/fusion/clipboard.js";

function board(initial = {}, options = {}) {
  const state = { text: "", image: undefined, files: undefined, writtenFiles: undefined, concealed: false, ...initial };
  const sent = [];
  const png = () => state.image && Buffer.concat([Buffer.from("PNG"), state.image]);
  const port = {
    read: async () => ({
      text: state.text,
      concealed: state.concealed,
      types: [state.text ? "text/plain" : "", state.image ? "image/png" : ""].join(","),
      png: async () => png(),
      ...(state.files ? { files: state.files } : {}),
    }),
    write: async (clip) => {
      state.text = clip.text ?? "";
      state.image = clip.png ? clip.png.subarray(3) : undefined;
    },
    writeFiles: async (paths) => {
      state.writtenFiles = paths;
      state.files = paths;
    },
  };
  return { state, sent, clipboard: new FusionClipboard(port, (m) => sent.push(m), options) };
}

test("what is copied goes once, on focus, and again only when it changes", async () => {
  const { state, sent, clipboard } = board({ text: "one" });
  await clipboard.tick();
  assert.equal(sent.length, 0, "nothing before the user has been in a window");
  await clipboard.focused();
  await clipboard.focused();
  await clipboard.tick();
  assert.deepEqual(sent, [{ t: "clip", text: "one" }]);
  state.text = "two";
  await clipboard.tick();
  assert.deepEqual(sent[1], { t: "clip", text: "two" });
});

test("a picture goes as PNG; a second picture with the same formats is seen at the next focus", async () => {
  const { state, sent, clipboard } = board({ image: Buffer.from([1, 2, 3, 4]) });
  await clipboard.focused();
  assert.equal(sent[0].png, Buffer.concat([Buffer.from("PNG"), Buffer.from([1, 2, 3, 4])]).toString("base64"));
  state.image = Buffer.from([9, 9, 9, 9]);
  await clipboard.tick();
  assert.equal(sent.length, 1, "the cheap look cannot tell two pictures apart");
  await clipboard.focused();
  assert.equal(sent.length, 2);
});

test("what the remote sent is written and not sent back", async () => {
  const { state, sent, clipboard } = board();
  await clipboard.received({ t: "clip", text: "early" });
  assert.equal(state.text, "", "not before the first focus");
  await clipboard.focused();
  await clipboard.received({ t: "clip", text: "from remote", png: Buffer.from("PNGabcd").toString("base64") });
  assert.equal(state.text, "from remote");
  assert.deepEqual([...state.image], [...Buffer.from("abcd")]);
  await clipboard.tick();
  await clipboard.focused();
  assert.equal(sent.length, 0);
});

test("concealed and oversized clipboards stay here", async () => {
  const secret = board({ text: "hunter2", concealed: true });
  await secret.clipboard.focused();
  assert.equal(secret.sent.length, 0);
  const big = board({ text: "caption", image: Buffer.alloc(MAX_CLIPBOARD_BYTES) });
  await big.clipboard.focused();
  assert.deepEqual(big.sent, [{ t: "clip", text: "caption" }], "the picture is left out, the text still goes");
  await big.clipboard.received({ t: "clip", png: Buffer.alloc(MAX_CLIPBOARD_BYTES + 1).toString("base64") });
  assert.equal(big.state.text, "caption");
});

test("OS file clipboard plist and CF_HDROP codecs roundtrip cleanly", () => {
  const paths = ["/tmp/hello & world.txt", "/Users/alice/Documents/<report>.pdf"];
  const plist = buildMacNsFilenamesPlist(paths);
  assert.deepEqual(parseMacNsFilenamesPlist(plist), paths);

  const winPaths = ["C:\\Users\\Alice\\a & b.txt", "D:\\Work\\notes.md"];
  const hdrop = buildWindowsDropFiles(winPaths);
  assert.deepEqual(parseWindowsDropFiles(hdrop), winPaths);

  assert.deepEqual(parseWindowsFileNameW(Buffer.from("C:\\temp\\one.bin\0\0", "utf16le")), [
    "C:\\temp\\one.bin",
  ]);
});

test("resolveSafeClipFilePath blocks path traversal and control characters", () => {
  const stageDir = "/tmp/linkshell-stage-test";
  assert.equal(resolveSafeClipFilePath(stageDir, 0, "../escape.txt"), null);
  assert.equal(resolveSafeClipFilePath(stageDir, 0, "sub/file.txt"), null);
  assert.equal(resolveSafeClipFilePath(stageDir, 0, "sub\\file.txt"), null);
  assert.equal(resolveSafeClipFilePath(stageDir, 0, "."), null);
  assert.equal(resolveSafeClipFilePath(stageDir, 0, ".."), null);
  assert.equal(resolveSafeClipFilePath(stageDir, 0, "bad\0name.txt"), null);
  assert.equal(resolveSafeClipFilePath(stageDir, 0, "a".repeat(256)), null);
  const safe = resolveSafeClipFilePath(stageDir, 2, "safe-file.txt");
  assert.ok(safe?.endsWith(join("2", "safe-file.txt")));
});

test("outgoing file-clipboard chunks files, enforces size limit, and suppresses echoes", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "ls-clip-out-"));
  const stageRoot = mkdtempSync(join(tmpdir(), "ls-clip-stage-"));
  try {
    const fileA = join(workDir, "alpha.bin");
    const fileB = join(workDir, "beta.txt");
    const contentA = Buffer.alloc(1400, 0x41);
    const contentB = Buffer.from("hello-fusion-files", "utf8");
    writeFileSync(fileA, contentA);
    writeFileSync(fileB, contentB);

    const { state, sent, clipboard } = board(
      { files: [fileA, fileB] },
      { stageRoot, chunkBytes: 512, maxFileBytes: 4096, canSendFiles: () => true },
    );
    await clipboard.focused();
    await new Promise((r) => setTimeout(r, 30));

    const startMsg = sent.find((m) => m.t === "clip.file.start");
    const chunks = sent.filter((m) => m.t === "clip.file.chunk");
    const endMsg = sent.find((m) => m.t === "clip.file.end");
    assert.ok(startMsg);
    assert.equal(startMsg.totalBytes, contentA.length + contentB.length);
    assert.deepEqual(startMsg.files, [
      { index: 0, name: "alpha.bin", size: contentA.length },
      { index: 1, name: "beta.txt", size: contentB.length },
    ]);
    assert.equal(chunks.filter((c) => c.index === 0).length, 3);
    assert.equal(chunks.filter((c) => c.index === 1).length, 1);
    assert.equal(endMsg?.ok, true);

    // Next tick with same file list must not re-send.
    const countBefore = sent.length;
    await clipboard.tick();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(sent.length, countBefore);

    // Oversized file transfer is skipped cleanly.
    const oversized = join(workDir, "too-big.bin");
    writeFileSync(oversized, Buffer.alloc(5000, 0x42));
    state.files = [oversized];
    await clipboard.tick();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(sent.length, countBefore);
    clipboard.dispose();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(stageRoot, { recursive: true, force: true });
  }
});

test("incoming file-clipboard stages into 0700 temp dir, verifies integrity, and cleans up on abort/dispose", async () => {
  const stageRoot = mkdtempSync(join(tmpdir(), "ls-clip-in-"));
  try {
    mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
    const { state, sent, clipboard } = board({}, { stageRoot, chunkBytes: 512, maxFileBytes: 4096 });
    await clipboard.focused();

    const payload = Buffer.from("chunk-one-chunk-two");
    await clipboard.receivedFileMessage({
      t: "clip.file.start",
      transferId: "tx-good",
      files: [{ index: 0, name: "readme.txt", size: payload.length }],
      totalBytes: payload.length,
    });
    await clipboard.receivedFileMessage({
      t: "clip.file.chunk",
      transferId: "tx-good",
      index: 0,
      seq: 0,
      data: payload.subarray(0, 10).toString("base64"),
    });
    await clipboard.receivedFileMessage({
      t: "clip.file.chunk",
      transferId: "tx-good",
      index: 0,
      seq: 1,
      data: payload.subarray(10).toString("base64"),
    });
    await clipboard.receivedFileMessage({
      t: "clip.file.end",
      transferId: "tx-good",
      ok: true,
    });

    assert.equal(state.writtenFiles?.length, 1);
    const stagedPath = state.writtenFiles[0];
    assert.equal(readFileSync(stagedPath, "utf8"), "chunk-one-chunk-two");
    if (process.platform !== "win32") {
      const stageParent = join(stagedPath, "..", "..");
      assert.equal(statSync(stageParent).mode & 0o777, 0o700);
    }

    // Echo suppression ensures newly written staged files are not sent back out.
    await clipboard.tick();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(sent.filter((m) => m.t === "clip.file.start").length, 0);

    // Path traversal filename in start is rejected with clip.file.end ok=false and nothing staged.
    await clipboard.receivedFileMessage({
      t: "clip.file.start",
      transferId: "tx-bad-name",
      files: [{ index: 0, name: "../evil.sh", size: 5 }],
      totalBytes: 5,
    });
    assert.equal(sent.at(-1)?.transferId, "tx-bad-name");
    assert.equal(sent.at(-1)?.ok, false);

    // Out-of-order chunk triggers failure & cleanup.
    await clipboard.receivedFileMessage({
      t: "clip.file.start",
      transferId: "tx-bad-seq",
      files: [{ index: 0, name: "ok.txt", size: 5 }],
      totalBytes: 5,
    });
    await clipboard.receivedFileMessage({
      t: "clip.file.chunk",
      transferId: "tx-bad-seq",
      index: 0,
      seq: 2,
      data: Buffer.from("hello").toString("base64"),
    });
    assert.equal(sent.at(-1)?.transferId, "tx-bad-seq");
    assert.equal(sent.at(-1)?.ok, false);

    clipboard.dispose();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(existsSync(stagedPath), false);
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
});
