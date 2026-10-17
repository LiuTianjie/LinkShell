import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, expect } from "vitest";

it.skipIf(process.platform !== "darwin")("native host projection decodes into Watch UI models and excludes complex approvals", () => {
  const dir = mkdtempSync(join(tmpdir(), "linkshell-watch-projection-"));
  const swift = resolve(import.meta.dirname, "../plugins/watch");
  try {
    const models = readFileSync(join(swift, "WatchModels.swift"), "utf8").split("public struct WatchQuickPrompt")[0].replace("import SwiftUI\n", "").replace("import UIKit\n", "");
    writeFileSync(join(dir, "Models.swift"), models);
    writeFileSync(join(dir, "main.swift"), String.raw`import Foundation
let session: [String: Any] = ["id": "s", "agent": "codex", "driver": "remote", "state": "waiting", "cwd": "/tmp/test", "permission": ["requestId": "r", "title": "Run tests?", "options": [["optionId": "allow", "name": "Allow", "kind": "allow_once"]]]]
var history = WatchHistory()
history.append(["seq": 1, "update": ["sessionUpdate": "agent_message_chunk", "content": ["type": "text", "text": "Hello"]]])
history.append(["seq": 2, "update": ["sessionUpdate": "agent_message_chunk", "content": ["type": "text", "text": " world"]]])
history.append(["seq": 3, "update": ["sessionUpdate": "ls_config", "options": [["id": "model", "name": "Model", "current": "test", "values": [["value": "test", "name": "Test"]]]]]])
let identity = try WatchIdentity().peer
let machine = WatchMachine(id: identity.id, signKey: identity.signKey, boxKey: identity.boxKey, name: "Test", platform: "darwin", online: true, via: "paired")
let json = try WatchSnapshotBuilder.snapshot(gateway: URL(string: "https://example.com")!, machine: machine, machines: [machine], online: true, sessions: ["s": session], terminals: ["t": ["id": "t", "exitCode": 1]], histories: ["s": history], outputs: ["t": "\u{001B}]0;title\u{0007}\u{001B}[31mfailed\u{001B}[0m"], info: ["agents": [["id": "codex", "installed": true]]], projects: [])
let snapshot = try JSONDecoder().decode(WatchSnapshot.self, from: Data(json.utf8))
precondition(snapshot.waitingCount == 1 && snapshot.sessions[0].actions?.first?.optionId == "allow")
precondition(snapshot.sessions[0].items?.first?.text == "Hello world")
precondition(snapshot.sessions[0].configOptions?.first?.current == "test")
precondition(snapshot.terminals[0].phase == "failed" && snapshot.terminals[0].outputPreview == "failed")
var complex = session
complex["permission"] = ["requestId": "r", "questions": [["id": "q", "kind": "choices", "options": [["value": "a"]]]]]
precondition(WatchSnapshotBuilder.actions(complex, key: "key").isEmpty)
complex["permission"] = ["requestId": "r", "url": ["url": "https://example.com"], "options": [["optionId": "allow"]]]
precondition(WatchSnapshotBuilder.actions(complex, key: "key").isEmpty)
print("projection passed")
`);
    const binary = join(dir, "projection");
    execFileSync("xcrun", ["swiftc", join(swift, "WatchCrypto.swift"), join(swift, "WatchRelay.swift"), join(swift, "WatchSnapshotBuilder.swift"), join(dir, "Models.swift"), join(dir, "main.swift"), "-o", binary], { stdio: "pipe" });
    expect(execFileSync(binary, { encoding: "utf8" })).toContain("projection passed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
