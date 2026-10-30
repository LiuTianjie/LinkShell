import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanWindowsUpdateDownloads, downloadWindowsInstaller, verifyInstaller, windowsRelease } from "../dist/main/windows-update.js";

const release = (version, bytes = Buffer.from("installer")) => {
  const name = `LinkShell-Setup-${version}-windows-x64.exe`;
  const url = `https://github.com/LiuTianjie/LinkShell/releases/download/desktop-v${version}/${name}`;
  return { tag_name: `desktop-v${version}`, prerelease: version.includes("-"), assets: [
    { name, browser_download_url: url, size: bytes.length },
    { name: name + ".sha256", browser_download_url: url + ".sha256" },
  ] };
};

test("Windows updates pick the newest compatible official release and respect prerelease order", () => {
  const releases = [release("1.0.1"), release("1.1.0-beta.9"), release("1.1.0-beta.10"), release("1.0.4")];
  assert.equal(windowsRelease(releases, false)?.version, "1.0.4");
  assert.equal(windowsRelease(releases, true)?.version, "1.1.0-beta.10");
  assert.equal(windowsRelease([...releases, release("1.1.0")], true)?.version, "1.1.0");
  const malicious = release("9.0.0");
  malicious.assets[0].browser_download_url = "https://github.com/another/project/releases/download/desktop-v9.0.0/installer.exe";
  const noChecksum = release("8.0.0"); noChecksum.assets.pop();
  assert.equal(windowsRelease([malicious, noChecksum, ...releases], false)?.version, "1.0.4");
});

test("a verified installer survives cleanup while downloading or postponed, and changed bytes cannot execute", async (t) => {
  const cache = await mkdtemp(join(tmpdir(), "linkshell-update-test-"));
  t.after(() => rm(cache, { recursive: true, force: true }));
  const bytes = Buffer.from("verified installer contents");
  const entry = windowsRelease([release("1.2.3", bytes)], false);
  let duringDownload;
  const fetch = async (url) => {
    if (url.endsWith(".sha256")) return new Response(`${createHash("sha256").update(bytes).digest("hex")}  ${entry.name}\n`);
    // A startup cleanup in another task of this process sees the transfer's owner marker.
    await cleanWindowsUpdateDownloads(cache);
    duringDownload = await readdir(cache);
    return new Response(bytes);
  };
  const download = await downloadWindowsInstaller(entry, cache, fetch, () => {});
  assert.equal(duringDownload.length, 1);
  await verifyInstaller(download);
  await cleanWindowsUpdateDownloads(cache);
  assert.deepEqual(await readFile(download.path), bytes);
  await writeFile(download.path, "tampered");
  await assert.rejects(verifyInstaller(download), /SHA-256/);
  await rm(join(download.directory, "owner"));
  await cleanWindowsUpdateDownloads(cache);
  assert.deepEqual(await readdir(cache), []);
});

test("corrupt or interrupted installer downloads are removed before any installer is returned", async (t) => {
  const cache = await mkdtemp(join(tmpdir(), "linkshell-update-test-"));
  t.after(() => rm(cache, { recursive: true, force: true }));
  const entry = windowsRelease([release("1.2.3", Buffer.from("correct"))], false);
  const hash = createHash("sha256").update("correct").digest("hex");
  for (const broken of [new Response("altered"), new Response(new ReadableStream({ start(controller) { controller.error(new Error("network interrupted")); } }))]) {
    const fetch = async (url) => url.endsWith(".sha256") ? new Response(`${hash}  ${entry.name}\n`) : broken;
    await assert.rejects(downloadWindowsInstaller(entry, cache, fetch, () => {}));
    assert.deepEqual(await readdir(cache), []);
  }
});
