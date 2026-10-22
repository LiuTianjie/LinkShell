import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, expect } from "vitest";

// The watch reduces host events itself in independent mode: it must page, merge and label them as the phone does.
it.skipIf(process.platform !== "darwin")("native watch history pages, merges deltas and renders every conversation kind", () => {
  const dir = mkdtempSync(join(tmpdir(), "linkshell-watch-history-"));
  const swift = resolve(import.meta.dirname, "../plugins/watch");
  try {
    const models = readFileSync(join(swift, "WatchModels.swift"), "utf8").split("public struct WatchQuickPrompt")[0].replace("import SwiftUI\n", "").replace("import UIKit\n", "");
    writeFileSync(join(dir, "Models.swift"), models);
    writeFileSync(join(dir, "main.swift"), String.raw`import Foundation
func event(_ seq: Int, _ update: [String: Any]) -> [String: Any] { ["seq": seq, "ts": Double(seq), "update": update] }
func text(_ value: String) -> [String: Any] { ["type": "text", "text": value] }
func chunk(_ seq: Int, _ id: String, _ value: String, thought: Bool = false) -> [String: Any] {
  event(seq, ["sessionUpdate": thought ? "agent_thought_chunk" : "agent_message_chunk", "messageId": id, "content": text(value)])
}
func rows(_ history: WatchHistory, _ limit: Int = 400) -> [[String: Any]] { history.rows(limit: limit).rows }
func row(_ history: WatchHistory, _ id: String) -> [String: Any]? { rows(history, 5000).first { $0["id"] as? String == id } }
func check(_ condition: Bool, _ message: String) { if !condition { print("FAILED: \(message)"); exit(1) } }

// Paging: a page older than 1600 live events (Codex deltas) still shows, and a reply cut by the page boundary is one row again.
func page(_ from: Int, _ to: Int) -> [[String: Any]] {
  var events: [[String: Any]] = []
  for seq in from...to {
    if seq == from { events.append(event(seq, ["sessionUpdate": "user_message_chunk", "messageId": "u-old", "content": text("旧的问题")])) }
    else if seq == to - 1 { events.append(chunk(seq, "straddle", "开头")) }
    else if seq == to { events.append(chunk(seq, "straddle", "中间")) }
    else { events.append(chunk(seq, "old-\(seq / 100)", "x")) }
  }
  return events
}
var live = WatchHistory(startSeq: 2000)
live.append(chunk(2001, "straddle", "结尾"))
for seq in 2002...3700 {
  live.append(seq % 400 == 0 ? event(seq, ["sessionUpdate": "user_message_chunk", "messageId": "u-\(seq)", "content": text("问题 \(seq)")]) : chunk(seq, "reply-\(seq / 400)", "字"))
}
check(live.items.count < 20, "deltas merge into rows at ingest (\(live.items.count))")
var appended = live
for value in page(1501, 2000) { appended.append(value) }
appended.startSeq = 1500
live.prepend(page(1501, 2000), startSeq: 1500)
for history in [live, appended] {
  let all = rows(history)
  check(all.first?["id"] as? String == "u-old" && all.first?["text"] as? String == "旧的问题", "the older page is in front")
  check(row(history, "straddle")?["text"] as? String == "开头中间结尾", "a reply cut by the page joins in order")
  check(history.startSeq == 1500, "startSeq moves back to the page's start")
}

// Thinking and the reply share Claude's message id but are two rows; the thought is its own kind.
var claude = WatchHistory()
claude.append(chunk(1, "m1", "Let me think", thought: true))
claude.append(chunk(2, "m1", "Answer"))
check(row(claude, "thought:m1")?["kind"] as? String == "thought" && row(claude, "thought:m1")?["text"] as? String == "Let me think", "thought row")
check(row(claude, "m1")?["kind"] as? String == "assistant" && row(claude, "m1")?["text"] as? String == "Answer", "reply row is only the answer")

// ACP v2 / session messages, the reply envelope, and other kinds the phone shows.
var acp = WatchHistory()
acp.append(event(1, ["sessionUpdate": "ls_message", "messageId": "a1", "role": "session", "content": [text("Hello")]]))
acp.append(event(2, ["sessionUpdate": "ls_message", "messageId": "a1", "role": "session", "content": [text(" there")], "append": true]))
let reply = "<send_user_message_question_reply>\n[{\"questionItemId\":\"q1\",\"question\":\"Ship it?\",\"answer\":\"Yes\"}]\n</send_user_message_question_reply>\n"
acp.append(event(3, ["sessionUpdate": "ls_message", "messageId": "u1", "role": "user", "content": [text(reply)]]))
acp.append(event(4, ["sessionUpdate": "ls_permission", "requestId": "r1", "title": "Run tests?", "options": [["optionId": "allow", "name": "允许", "kind": "allow_once"]]]))
acp.append(event(5, ["sessionUpdate": "ls_permission_resolved", "requestId": "r1", "optionId": "allow"]))
acp.append(event(6, ["sessionUpdate": "ls_error", "code": "x", "message": "出错了", "hint": "重试"]))
acp.append(event(7, ["sessionUpdate": "ls_turn", "state": "ended", "stopReason": "cancelled"]))
acp.append(event(8, ["sessionUpdate": "tool_call", "toolCallId": "spawn", "title": "Task", "kind": "other", "status": "in_progress", "detail": ["type": "subagent", "action": "spawn", "agentType": "Explore", "task": "查找入口"]]))
acp.append(event(9, ["sessionUpdate": "agent_message_chunk", "parentToolCallId": "spawn", "messageId": "s1", "content": text("找到了 main.ts")]))
acp.append(event(10, ["sessionUpdate": "tool_call", "parentToolCallId": "spawn", "toolCallId": "inner", "title": "Read file", "kind": "read", "status": "completed"]))
check(row(acp, "a1")?["kind"] as? String == "assistant" && row(acp, "a1")?["text"] as? String == "Hello there", "ls_message renders and appends")
check(row(acp, "u1")?["text"] as? String == "Ship it? → Yes", "reply envelope is cleaned")
check(row(acp, "perm-r1")?["kind"] as? String == "permission" && row(acp, "perm-r1")?["text"] as? String == "已选择：允许", "resolved permission")
check(row(acp, "error-6")?["detail"] as? String == "重试", "error with hint")
check(row(acp, "turn-end-7")?["text"] as? String == "已停止", "a stopped turn stays visible")
check(row(acp, "spawn")?["kind"] as? String == "subagent" && row(acp, "spawn")?["text"] as? String == "查找入口", "sub-agent call")
check(row(acp, "inner") == nil && row(acp, "s1") == nil, "sub-agent internals nest under their call")
check((row(acp, "spawn")?["detail"] as? String ?? "").hasPrefix("正在执行"), "sub-agent row shows its latest step")

// Tool output deltas (with terminal escapes) and diffs.
var tools = WatchHistory()
tools.append(event(1, ["sessionUpdate": "tool_call", "toolCallId": "t1", "title": "bash -lc 'pnpm test'", "kind": "execute", "status": "in_progress"]))
for seq in 2...60 { tools.append(event(seq, ["sessionUpdate": "tool_call_update", "toolCallId": "t1", "appendOutput": "\u{001B}[32mline \(seq)\u{001B}[0m\n"])) }
tools.append(event(61, ["sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed"]))
let output = row(tools, "t1")?["detail"] as? String ?? ""
check(row(tools, "t1")?["text"] as? String == "pnpm test" && output.hasSuffix("line 60") && !output.contains("line 2\n") && !output.contains("\u{001B}"), "tool output tail: \(output)")
tools.append(event(62, ["sessionUpdate": "tool_call", "toolCallId": "e1", "title": "Edit", "kind": "edit", "status": "pending", "content": [
  ["type": "diff", "path": "/repo/src/a.swift", "oldText": "let a = 1\n", "newText": "let a = 2\nlet b = 3\n"],
  ["type": "diff", "path": "/repo/src/b.swift", "oldText": NSNull(), "newText": "print(1)\n"],
]]))
tools.append(event(63, ["sessionUpdate": "tool_call_update", "toolCallId": "e1", "status": "completed", "content": [["type": "content", "content": text("The file has been updated.")]]]))
let diff = row(tools, "e1") ?? [:]
check(diff["kind"] as? String == "diff" && diff["filePath"] as? String == "/repo/src/a.swift" && diff["diffAdded"] as? Int == 3 && diff["diffRemoved"] as? Int == 1, "diff summary: \(diff)")
check((diff["detail"] as? String ?? "").contains("b.swift") && (diff["text"] as? String ?? "").contains("2 个文件"), "diff names every edited file")

// A long reply keeps its beginning and its end, with a visible marker.
var long = WatchHistory()
long.append(chunk(1, "l", "BEGIN" + String(repeating: "a", count: 10_000) + "END"))
let longText = row(long, "l")?["text"] as? String ?? ""
check(longText.hasPrefix("BEGIN") && longText.hasSuffix("END") && longText.contains("略去") && longText.count < 3200, "long text is bounded with a marker")

// Eviction lets go of old rows outside the window only, and a re-paged row isn't added twice.
var busy = WatchHistory(startSeq: 0, visibleItems: 400)
for seq in 1...1000 { busy.append(event(seq, ["sessionUpdate": "tool_call", "toolCallId": "c\(seq)", "title": "ls \(seq)", "kind": "execute", "status": "completed"])) }
check(busy.items.count <= WatchHistory.maxItems && busy.startSeq > 0, "eviction bounds rows and moves startSeq (\(busy.items.count), \(busy.startSeq))")
check(rows(busy).count == 400 && rows(busy).last?["id"] as? String == "c1000", "the visible window is intact")
let cut = busy.startSeq
busy.prepend((1...cut).map { event($0, ["sessionUpdate": "tool_call", "toolCallId": "c\($0)", "title": "ls \($0)", "kind": "execute", "status": "completed"]) }, startSeq: 0)
check(busy.items.count == 1000 && Set(busy.items.map(\.id)).count == 1000, "re-paged rows come back once")
// A dropped row updated late moves the cut past rows that are kept: those keep their text, not twice.
func straddled(_ seq: Int) -> [String: Any] {
  seq == 1 ? event(1, ["sessionUpdate": "tool_call", "toolCallId": "A", "title": "make", "kind": "execute", "status": "in_progress"])
    : seq == 791 ? event(791, ["sessionUpdate": "tool_call_update", "toolCallId": "A", "appendOutput": "late"]) : chunk(seq, "m\(seq)", "x")
}
var sealed = WatchHistory(startSeq: 0, visibleItems: 30)
for seq in 1...900 { sealed.append(straddled(seq)) }
check(sealed.startSeq == 791 && sealed.items.first?.id == "m102", "the cut follows the late update (\(sealed.startSeq))")
sealed.prepend((1...791).map(straddled), startSeq: 0)
check(row(sealed, "m500")?["text"] as? String == "x" && Set(sealed.items.map(\.id)).count == sealed.items.count, "kept rows aren't doubled")
check(sealed.items.first?.id == "A" && row(sealed, "A")?["detail"] as? String == "late", "the dropped row comes back whole")

// Card labels follow the wire; agents are the host's, without terminal-tier ones.
let identity = try WatchIdentity().peer
let machine = WatchMachine(id: identity.id, signKey: identity.signKey, boxKey: identity.boxKey, name: "Test", platform: "darwin", online: true, via: "paired")
let sessions: [String: [String: Any]] = [
  "a": ["id": "a", "agent": "codex", "state": "unknown", "cwd": "/tmp/a", "updatedAt": 3.0],
  "b": ["id": "b", "agent": "codex", "state": "idle", "cwd": "/tmp/b", "updatedAt": 2.0],
  "c": ["id": "c", "agent": "codex", "state": "waiting", "cwd": "/tmp/c", "updatedAt": 1.0],
]
let agents: [[String: Any]] = [["id": "codex", "installed": true, "tier": "native"], ["id": "aider", "installed": true, "tier": "terminal"], ["id": "gemini", "installed": false, "tier": "acp"]]
let json = try WatchSnapshotBuilder.snapshot(gateway: URL(string: "https://example.com")!, machine: machine, machines: [machine], online: true, sessions: sessions, terminals: [:], histories: ["b": claude], outputs: [:], info: ["agents": agents], projects: [])
let snapshot = try JSONDecoder().decode(WatchSnapshot.self, from: Data(json.utf8))
let card = { (id: String) in snapshot.sessions.first { $0.id == id }! }
check(card("a").phase == "starting", "unknown is starting")
check(card("b").phase == "completed" && card("b").subtitle == "本轮任务已结束", "idle subtitle is Chinese: \(card("b").subtitle)")
check(card("c").phase == "waiting_for_approval" && card("c").hasMoreActions == true && card("c").subtitle == "需要你的确认", "waiting without a request points elsewhere")
check(card("b").items?.map(\.kind) == ["thought", "assistant"], "card items decode")
check(snapshot.availableAgents == ["codex"], "agents: \(snapshot.availableAgents ?? [])")
check(WatchSnapshot.empty.availableAgents?.isEmpty == true, "no invented agents")
print("history passed")
`);
    const binary = join(dir, "history");
    execFileSync("xcrun", ["swiftc", join(swift, "WatchCrypto.swift"), join(swift, "WatchRelay.swift"), join(swift, "WatchSnapshotBuilder.swift"), join(dir, "Models.swift"), join(dir, "main.swift"), "-o", binary], { stdio: "pipe" });
    expect(execFileSync(binary, { encoding: "utf8" })).toContain("history passed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60_000);
