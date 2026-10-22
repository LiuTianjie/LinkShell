import Foundation

/// A long text kept as its beginning and its latest end: a reply streamed for minutes stays
/// bounded, and both how it opened and where it got to stay readable.
struct WatchText {
  let limit: Int
  private(set) var head = "", tail = ""
  private(set) var total = 0, headCount = 0, tailCount = 0

  init(limit: Int) { self.limit = limit }
  var isEmpty: Bool { total == 0 }
  mutating func append(_ piece: String) {
    guard !piece.isEmpty else { return }
    var rest = Substring(piece)
    if total == headCount && headCount < limit {
      let take = rest.prefix(limit - headCount), count = take.count
      head += take; headCount += count; total += count; rest = rest.dropFirst(count)
    }
    guard !rest.isEmpty else { return }
    total += rest.count
    tail = String((tail + rest).suffix(max(1, limit / 4))); tailCount = tail.count
  }
  /// Text that was there but isn't kept: what lies between the next tail and what came before.
  mutating func skip(_ count: Int) { guard count > 0 else { return }; total += count; tail = ""; tailCount = 0 }
  mutating func append(_ later: WatchText) { append(later.head); skip(later.total - later.headCount - later.tailCount); append(later.tail) }
  var string: String {
    let omitted = total - headCount - tailCount
    return omitted > 0 ? head + "\n\n…（中间略去 \(omitted) 字）…\n\n" + tail : head + tail
  }
}

struct WatchDiff { var path: String; var added: Int; var removed: Int; var preview: String }

/// One conversation row, merged from its events as they arrive: a reply streamed in a thousand
/// deltas is one item, so what is held and paged counts rows, not deltas. `row` is what the
/// snapshot shows, rebuilt only when the item changes.
struct WatchHistoryItem {
  static let outputLimit = 1600
  let id: String
  var kind: String
  var firstSeq: Int, lastSeq: Int
  /// Holds its own beginning: an earlier page must not put that beginning in front of it again.
  var sealed = false
  var text: WatchText
  var images = 0, imageData: String?, imageMime: String?
  var streaming = false
  var title = "", status = "", detail = "", name = "", toolKind = "other", location = ""
  /// A tool call's `detail` (`ToolDetail`), or a plan's entries.
  var info: [String: Any] = [:]
  var output = "", content = "", rawOutput = ""
  var diffs: [WatchDiff] = []
  /// A sub-agent's own work, nested under the call that spawned it (as the phone nests it).
  var hasSub = false, subMessage = "", subLatest = ""
  var row: [String: Any]?

  init(id: String, kind: String, seq: Int) {
    self.id = id; self.kind = kind; firstSeq = seq; lastSeq = seq
    text = WatchText(limit: kind == "user" ? 4000 : kind == "assistant" ? 2400 : kind == "thought" ? 1200 : 1000)
  }

  mutating func absorb(_ block: [String: Any]) {
    switch block["type"] as? String {
    case "text": text.append(block["text"] as? String ?? "")
    case "image":
      images += 1
      // Lazy pictures arrive without data; small inline ones can show as a thumbnail.
      if imageData == nil, let data = block["data"] as? String, !data.isEmpty, data.count <= 12_000 { imageData = data; imageMime = block["mimeType"] as? String }
    case "resource_link" where kind == "user":
      text.append((text.isEmpty ? "" : "\n") + (block["name"] as? String ?? block["uri"] as? String ?? ""))
    default: break
    }
  }

  mutating func absorbTool(_ update: [String: Any], isCall: Bool) {
    if let value = update["title"] as? String { title = String(value.prefix(240)) }
    if let value = update["name"] as? String { name = value }
    if let value = update["kind"] as? String { toolKind = value }
    if let value = update["status"] as? String { status = value }
    if let value = update["detail"] as? [String: Any] { info = value }
    if let value = (update["locations"] as? [[String: Any]])?.first?["path"] as? String { location = value }
    if let entries = update["content"] as? [[String: Any]] { setContent(entries, replace: isCall || update["replaceContent"] as? Bool == true) }
    if let value = update["replaceOutput"] as? String { output = String(value.suffix(Self.outputLimit)) }
    else if let value = update["appendOutput"] as? String { output = String((output + value).suffix(Self.outputLimit)) }
    if let raw = update["rawOutput"] { rawOutput = Self.describe(raw) }
  }

  /// An update's content replaces the call's, except that a result without diffs ("The file has
  /// been updated.") keeps the diffs the call carried, as the phone's `keepDiffs` does.
  private mutating func setContent(_ entries: [[String: Any]], replace: Bool) {
    var texts: [String] = [], found: [WatchDiff] = [], pictures = 0
    for entry in entries {
      switch entry["type"] as? String {
      case "diff":
        found.append(Self.diff(path: entry["path"] as? String ?? "", old: entry["oldText"] as? String ?? "", new: entry["newText"] as? String ?? ""))
      case "patch":
        found.append(Self.patch(path: entry["path"] as? String ?? "", diff: entry["diff"] as? String ?? ""))
      case "content":
        let block = entry["content"] as? [String: Any] ?? [:]
        if let value = block["text"] as? String { texts.append(value) }
        else if let value = (block["resource"] as? [String: Any])?["text"] as? String { texts.append(value) }
        else if block["type"] as? String == "image" { pictures += 1 }
      default: break
      }
    }
    content = String(texts.joined(separator: "\n").suffix(Self.outputLimit))
    images = pictures
    if !found.isEmpty || replace { diffs = found }
  }

  static func describe(_ raw: Any) -> String {
    if let text = raw as? String { return String(text.suffix(outputLimit)) }
    guard let object = raw as? [String: Any] else { return "" }
    for key in ["output", "stdout", "formatted_output", "aggregated_output", "result", "error"] {
      if let text = object[key] as? String, !text.isEmpty { return String(text.suffix(outputLimit)) }
    }
    return ""
  }

  static func diff(path: String, old: String, new: String) -> WatchDiff {
    let oldLines = old.split(separator: "\n").map(String.init), newLines = new.split(separator: "\n").map(String.init)
    let oldSet = Set(oldLines), newSet = Set(newLines)
    let removed = oldLines.filter { !newSet.contains($0) }, added = newLines.filter { !oldSet.contains($0) }
    let preview = removed.prefix(4).map { "- " + $0.trimmingCharacters(in: .whitespaces).prefix(72) }
      + added.prefix(4).map { "+ " + $0.trimmingCharacters(in: .whitespaces).prefix(72) }
    return WatchDiff(path: path, added: added.count, removed: removed.count, preview: preview.joined(separator: "\n"))
  }

  static func patch(path: String, diff: String) -> WatchDiff {
    var added = 0, removed = 0, body: [String] = []
    for line in diff.split(separator: "\n", omittingEmptySubsequences: false) {
      if line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("@@") { continue }
      if line.hasPrefix("+") { added += 1 } else if line.hasPrefix("-") { removed += 1 } else { continue }
      if body.count < 8 { body.append(String(line.prefix(80))) }
    }
    return WatchDiff(path: path, added: added, removed: removed, preview: body.joined(separator: "\n"))
  }
}

/// Native projection of the same host events the phone's timeline (`client-core/timeline.ts`)
/// reduces, merged at ingest. Events after `lastSeq` are live; events at or before `startSeq`
/// are an older page, put in front once its own `startSeq` says where it begins.
struct WatchHistory {
  /// Most rows a conversation shows; paging further would only load rows that can't be shown.
  static let maxVisibleItems = 400
  /// Rows held before the oldest ones are let go. Well above `maxVisibleItems`, and eviction
  /// never takes a row inside the user's window.
  static let maxItems = 800

  var startSeq = 0 { didSet { if !earlier.isEmpty { foldEarlier() } } }
  var visibleItems = 30
  private(set) var lastSeq = 0
  private(set) var items: [WatchHistoryItem] = []
  private(set) var configuration: [[String: Any]] = []
  private(set) var plan: [[String: Any]] = []
  private var index: [String: Int] = [:]
  private var earlier: [[String: Any]] = []
  private var paging = false
  private var planID: String?
  private var turnActive = false
  private var driver: String?
  private var streamingIDs = Set<String>()
  /// A sub-agent's calls → the top-level call it runs under (sub-agents can nest).
  private var roots: [String: String] = [:]
  private var requests: [String: [String: Any]] = [:]
  /// The last id-less chunk's kind and row: such chunks continue the row while they're contiguous.
  private var chunk: (type: String, id: String)?

  init(startSeq: Int = 0, visibleItems: Int = 30) { self.startSeq = startSeq; self.visibleItems = visibleItems }

  mutating func append(_ event: [String: Any]) {
    guard let seq = event["seq"] as? Int, let update = event["update"] as? [String: Any] else { return }
    if seq > lastSeq {
      lastSeq = seq
      apply(update, seq: seq)
      if !paging && items.count > Self.maxItems { evict() }
    } else if seq <= startSeq {
      earlier.append(event)
    }
  }

  /// A `sessions.history` page, older than everything held.
  mutating func prepend(_ events: [[String: Any]], startSeq: Int) {
    earlier += events
    self.startSeq = startSeq
  }

  /// `session.window`: the host's backlog starts after `start`. What can't be continued from
  /// there starts over, keeping how much the user had scrolled back (the phone's `startWindow`).
  mutating func window(_ start: Int) {
    if lastSeq == 0 || lastSeq == start { startSeq = start } else { self = WatchHistory(startSeq: start, visibleItems: visibleItems) }
  }

  /// The newest `limit` rows, and whether there are older rows than those.
  func rows(limit: Int) -> (rows: [[String: Any]], more: Bool) {
    var out: [[String: Any]] = []
    for item in items.reversed() {
      guard let row = item.row else { continue }
      if out.count == limit { return (out.reversed(), true) }
      out.append(row)
    }
    return (out.reversed(), false)
  }

  // MARK: reducer (mirrors client-core's applyUpdate)

  private mutating func apply(_ update: [String: Any], seq: Int) {
    let type = update["sessionUpdate"] as? String ?? ""
    if chunk?.type != type { chunk = nil }
    if let parent = update["parentToolCallId"] as? String, !parent.isEmpty,
       ["ls_message", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "ls_message_done", "ls_turn"].contains(type) {
      return applyToChild(update, type: type, parent: parent, seq: seq)
    }
    let active = turnActive
    switch type {
    case "ls_message":
      guard let message = update["messageId"] as? String, let blocks = update["content"] as? [[String: Any]] else { return }
      let role = update["role"] as? String ?? "agent"
      let kind = role == "user" ? "user" : role == "thought" ? "thought" : "assistant"
      let append = update["append"] as? Bool == true
      edit(role == "thought" ? "thought:\(message)" : message, kind: kind, seq: seq) { item in
        if !append { item.text = WatchText(limit: item.text.limit); item.images = 0; item.imageData = nil }
        blocks.forEach { item.absorb($0) }
        item.streaming = kind != "user" && active
      }
    case "user_message_chunk":
      edit(chunkID(update, type: type, seq: seq), kind: "user", seq: seq) { $0.absorb(update["content"] as? [String: Any] ?? [:]) }
    case "agent_message_chunk", "agent_thought_chunk":
      // Claude gives a turn's thinking and its reply the same message id: they stay two rows.
      let thought = type == "agent_thought_chunk", message = chunkID(update, type: type, seq: seq)
      edit(thought ? "thought:\(message)" : message, kind: thought ? "thought" : "assistant", seq: seq) {
        $0.absorb(update["content"] as? [String: Any] ?? [:]); $0.streaming = true
      }
    case "ls_message_done":
      guard let message = update["messageId"] as? String else { return }
      let id = update["role"] as? String == "thought" ? "thought:\(message)" : message
      guard let at = index[id], ["assistant", "thought"].contains(items[at].kind) else { return }
      edit(id, kind: items[at].kind, seq: seq) { $0.streaming = false }
      guard items[at].kind == "assistant" else { return }
      for question in (update["questions"] as? [[String: Any]] ?? []).prefix(2) {
        guard let qid = question["id"] as? String else { continue }
        edit("\(id):q:\(qid)", kind: "question", seq: seq) { item in
          item.title = "Agent 提问"; item.text = WatchText(limit: 400); item.text.append(question["title"] as? String ?? "")
          item.detail = (question["options"] as? [String] ?? []).map { "• \($0)" }.joined(separator: "\n"); item.status = "waiting"
        }
      }
    case "tool_call", "tool_call_update":
      guard let id = update["toolCallId"] as? String else { return }
      if type == "tool_call" { settleStreaming() }
      edit(id, kind: "tool", seq: seq) { $0.absorbTool(update, isCall: type == "tool_call") }
    case "plan":
      let id = (update["planId"] as? String).map { "plan:\($0)" } ?? planID ?? "plan-\(seq)"
      if update["removed"] as? Bool == true {
        remove(id)
        if planID == id { planID = nil; plan = [] }
        return
      }
      let entries = update["entries"] as? [[String: Any]] ?? []
      edit(id, kind: "plan", seq: seq) { $0.info = ["entries": entries]; $0.title = update["title"] as? String ?? "" }
      planID = id
      if !entries.isEmpty { plan = entries }
    case "ls_config":
      configuration = update["options"] as? [[String: Any]] ?? []
    case "current_mode_update":
      let mode = update["currentModeId"] as? String
      configuration = configuration.map { option in
        guard option["category"] as? String == "mode", let mode else { return option }
        var next = option; next["current"] = mode; return next
      }
    case "ls_turn":
      if update["state"] as? String == "started" { turnActive = true; planID = nil; return }
      settleStreaming(); turnActive = false
      requests = requests.filter { $0.value["childSessionId"] != nil }
      // A normal end is implied; limits and refusals stay visible.
      if let reason = update["stopReason"] as? String, let copy = Self.stopCopy[reason] {
        edit("turn-end-\(seq)", kind: "notice", seq: seq) { $0.text.append(copy); $0.status = reason == "cancelled" ? "completed" : "waiting" }
      }
    case "ls_status":
      let state = update["state"] as? String ?? ""
      let next = update["turnActive"] as? Bool ?? (state == "running" || state == "waiting")
      if !next && turnActive { settleStreaming() }
      turnActive = next
    case "ls_permission":
      guard let id = update["requestId"] as? String, requests[id] == nil else { return }
      settleStreaming(); requests[id] = update
    case "ls_permission_resolved":
      guard let id = update["requestId"] as? String, let request = requests.removeValue(forKey: id) else { return }
      let option = (request["options"] as? [[String: Any]] ?? []).first { $0["optionId"] as? String == update["optionId"] as? String }
      let questions = request["questions"] as? [[String: Any]]
      let answers = questions.map { Self.answered($0, update["answers"] as? [[String: Any]] ?? []) } ?? []
      let title = String((request["title"] as? String ?? "").prefix(80))
      if !answers.isEmpty {
        edit("perm-\(id)", kind: "question", seq: seq) { item in
          item.title = title.isEmpty ? "已回答问题" : title; item.text.append(answers.joined(separator: "\n")); item.status = "completed"
        }
      } else {
        let name = option?["name"] as? String
        let allowed = (option?["kind"] as? String).map { $0.hasPrefix("allow") }
        edit("perm-\(id)", kind: "permission", seq: seq) { item in
          item.title = title.isEmpty ? "权限请求" : title
          item.text.append(name.map { "已选择：\($0)" } ?? (allowed == false ? "已拒绝" : "已允许"))
          item.status = allowed == false ? "failed" : "completed"
        }
      }
    case "ls_driver":
      let value = update["driver"] as? String
      guard value != driver else { return }
      let previous = driver
      driver = value
      // The first report is just the starting state; later ones are handoffs worth showing.
      guard previous != nil else { return }
      edit("driver-\(seq)", kind: "notice", seq: seq) { item in
        item.text.append(value == "remote" ? "手机接管了会话" : value == "desktop" ? "回到电脑上继续" : "电脑终端已退出 · 可以在这里继续")
        item.status = "completed"
      }
    case "ls_error":
      settleStreaming()
      edit("error-\(seq)", kind: "error", seq: seq) { item in
        item.title = "错误"; item.text.append(update["message"] as? String ?? ""); item.detail = update["hint"] as? String ?? ""; item.status = "failed"
      }
    case "ls_notice":
      edit("notice-\(seq)", kind: "notice", seq: seq) { item in
        item.title = update["title"] as? String ?? ""; item.text.append(update["detail"] as? String ?? "")
        item.status = update["level"] as? String == "warning" ? "waiting" : "completed"
      }
    default: return
    }
  }

  /// A sub-agent's update: the phone nests it under the spawning call, and its watch row shows
  /// the call with the sub-agent's latest words or step.
  private mutating func applyToChild(_ update: [String: Any], type: String, parent: String, seq: Int) {
    let root = roots[parent] ?? parent
    if type.hasPrefix("tool_call"), let call = update["toolCallId"] as? String, call != root { roots[call] = root }
    edit(root, kind: "tool", seq: seq) { item in
      if !item.hasSub {
        item.hasSub = true
        if item.title.isEmpty { item.title = "Sub-agent" }
        if item.info.isEmpty { item.info = ["type": "subagent"] }
        if item.status.isEmpty { item.status = "in_progress" }
      }
      switch type {
      case "tool_call":
        if let title = update["title"] as? String { item.subLatest = "正在执行: \(WatchFormat.toolTitle(title))" }
      case "agent_message_chunk", "ls_message":
        if type == "ls_message", !["agent", "session"].contains(update["role"] as? String ?? "") { return }
        let blocks = type == "ls_message" ? update["content"] as? [[String: Any]] ?? [] : [update["content"] as? [String: Any] ?? [:]]
        let text = blocks.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined()
        let message = update["messageId"] as? String ?? ""
        let restart = message != item.subMessage || (type == "ls_message" && update["append"] as? Bool != true)
        item.subMessage = message
        let joined = (restart ? "" : item.subLatest.hasPrefix("正在执行: ") ? "" : item.subLatest) + text
        if !joined.isEmpty { item.subLatest = String(joined.suffix(400)) }
      default: break
      }
    }
  }

  /// Agents that stream a message without an id: contiguous chunks of one kind are one message.
  private mutating func chunkID(_ update: [String: Any], type: String, seq: Int) -> String {
    if let id = update["messageId"] as? String { chunk = nil; return id }
    let id = chunk?.id ?? "chunk-\(seq)"
    chunk = (type, id)
    return id
  }

  private mutating func edit(_ id: String, kind: String, seq: Int, _ change: (inout WatchHistoryItem) -> Void) {
    let at = index[id]
    // Same id, another kind: a new item in its place, as the phone's upsert does.
    var item = at.flatMap { items[$0].kind == kind ? items[$0] : nil } ?? WatchHistoryItem(id: id, kind: kind, seq: seq)
    item.lastSeq = max(item.lastSeq, seq)
    change(&item)
    item.row = WatchFormat.row(item)
    if item.streaming { streamingIDs.insert(id) } else { streamingIDs.remove(id) }
    if let at { items[at] = item } else { index[id] = items.count; items.append(item) }
  }

  private mutating func remove(_ id: String) {
    guard let at = index[id] else { return }
    items.remove(at: at); streamingIDs.remove(id); reindex()
  }

  private mutating func reindex() {
    index = [:]
    for (at, item) in items.enumerated() { index[item.id] = at }
  }

  /// Stops every streaming row (turn ended, a tool started, a request or error arrived).
  private mutating func settleStreaming() {
    for id in streamingIDs {
      guard let at = index[id] else { continue }
      items[at].streaming = false; items[at].row = WatchFormat.row(items[at])
    }
    streamingIDs = []
  }

  /// Lets go of the oldest rows outside the user's window. They can be paged in again from the
  /// new `startSeq`; rows kept across the cut are sealed so their beginning isn't added twice.
  private mutating func evict() {
    var shown = 0, firstShown = items.count
    while firstShown > 0 && shown < visibleItems {
      firstShown -= 1
      if items[firstShown].row != nil { shown += 1 }
    }
    let drop = min(items.count - (Self.maxItems - 100), firstShown)
    guard drop > 0 else { return }
    let cut = items[..<drop].map(\.lastSeq).max() ?? 0
    for item in items[..<drop] { streamingIDs.remove(item.id) }
    items.removeFirst(drop)
    for at in items.indices where items[at].firstSeq <= cut { items[at].sealed = true }
    reindex()
    roots = roots.filter { index[$0.value] != nil }
    if cut > startSeq { startSeq = cut }
  }

  /// Puts a page of earlier history in front. A row that straddles the page boundary (a long
  /// turn was cut) becomes one row again, as the phone's `prependEvents` does.
  private mutating func foldEarlier() {
    let events = earlier.sorted { ($0["seq"] as? Int ?? 0) < ($1["seq"] as? Int ?? 0) }
    earlier = []
    var page = WatchHistory()
    page.paging = true
    for event in events { page.append(event) }
    page.settleStreaming()
    var joined: [WatchHistoryItem] = [], seen = Set<String>()
    for item in page.items {
      guard let at = index[item.id] else { joined.append(item); continue }
      seen.insert(item.id)
      joined.append(items[at].sealed ? items[at] : Self.join(item, items[at]))
    }
    joined += items.filter { !seen.contains($0.id) }
    items = joined
    reindex()
    for (call, root) in page.roots where roots[call] == nil { roots[call] = root }
    if configuration.isEmpty { configuration = page.configuration }
    if plan.isEmpty { plan = page.plan }
  }

  /// One row seen in two pages: `earlier` has how it began, `later` how it went on.
  static func join(_ earlier: WatchHistoryItem, _ later: WatchHistoryItem) -> WatchHistoryItem {
    guard earlier.kind == later.kind else { return later }
    var item = later
    item.firstSeq = earlier.firstSeq
    switch later.kind {
    case "user", "assistant", "thought":
      var text = earlier.text; text.append(later.text); item.text = text
      item.images = earlier.images + later.images
      if item.imageData == nil { item.imageData = earlier.imageData; item.imageMime = earlier.imageMime }
    case "tool":
      if ["", "Tool", "Sub-agent"].contains(later.title) { item.title = earlier.title }
      if earlier.toolKind != "other" { item.toolKind = earlier.toolKind }
      if later.name.isEmpty { item.name = earlier.name }
      item.info = earlier.info.merging(later.info) { _, new in new }
      if later.location.isEmpty { item.location = earlier.location }
      if later.diffs.isEmpty { item.diffs = earlier.diffs }
      if later.content.isEmpty { item.content = earlier.content }
      if later.rawOutput.isEmpty { item.rawOutput = earlier.rawOutput }
      item.output = String((earlier.output + later.output).suffix(WatchHistoryItem.outputLimit))
      item.hasSub = earlier.hasSub || later.hasSub
      if later.subLatest.isEmpty { item.subLatest = earlier.subLatest }
    default: break
    }
    item.row = WatchFormat.row(item)
    return item
  }

  static let stopCopy = [
    "cancelled": "已停止", "error": "这一轮出错结束", "max_tokens": "达到输出上限，回复被截断",
    "max_turn_requests": "达到本轮请求次数上限", "unknown": "本轮已结束，Agent 未提供明确原因", "refusal": "Agent 拒绝了这个请求",
  ]

  /// Questions with what was answered, as text: the options' labels, then the user's own words.
  static func answered(_ questions: [[String: Any]], _ answers: [[String: Any]]) -> [String] {
    questions.compactMap { question in
      guard let answer = answers.first(where: { $0["id"] as? String == question["id"] as? String }) else { return nil }
      let options = question["options"] as? [[String: Any]] ?? []
      let picked = (answer["values"] as? [String] ?? []).filter { !$0.isEmpty }.map { value in
        options.first { $0["value"] as? String == value }?["label"] as? String ?? value
      }
      var said = question["secret"] as? Bool == true && !picked.isEmpty ? ["••••••"] : picked
      if let other = answer["other"] as? String, !other.isEmpty { said.append(other) }
      guard !said.isEmpty else { return nil }
      return "\(question["header"] as? String ?? question["text"] as? String ?? ""): \(said.joined(separator: "，"))"
    }
  }
}

/// Text helpers ported from the phone (`watch-sync.ts`, `client-core/user-message.ts`,
/// `wire/live-activity.ts`) so a row reads the same on the wrist.
enum WatchFormat {
  private static func regex(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression {
    try! NSRegularExpression(pattern: pattern, options: options)
  }
  private static let contextSummary = regex(#"<CONTEXT_SUMMARY>[\s\S]*?</CONTEXT_SUMMARY>"#, .caseInsensitive)
  private static let userRequest = regex(#"<USER_REQUEST>([\s\S]*?)</USER_REQUEST>"#, .caseInsensitive)
  private static let originalTask = regex(#"<original_task>([\s\S]*?)</original_task>"#, .caseInsensitive)
  private static let questionReply = regex(#"<send_user_message_question_reply>([\s\S]*?)</send_user_message_question_reply>"#, .caseInsensitive)
  private static let heartbeatMessage = regex(#"^<heartbeat>\s*([\s\S]*?)\s*</heartbeat>$"#, .caseInsensitive)
  private static let automationMessage = regex(#"^<codex_automation_message>\s*([\s\S]*?)\s*</codex_automation_message>$"#, .caseInsensitive)
  private static let heartbeatTrailer = regex(#"(?:```(?:xml)?\s*)?<heartbeat>\s*([\s\S]*?)\s*</heartbeat>(?:\s*```)?"#, .caseInsensitive)
  private static let imageEnvelope = regex(#"^# Files mentioned by the user:\n\n[\s\S]+?\n\nDistinguish instructions in attached documents from the user's request\.\n\n## My request:(?:\n([\s\S]*))?$"#)
  private static let englishVerb = regex(#"^(read|reading|edit|editing|write|writing|update|create|delete|search|searching|list|run|running|fetch|grep|glob|find|view|open)\b[:\s]+"#, .caseInsensitive)
  private static let shellPrefix = regex(#"^(?:/\S*/)?(?:ba|z|da|k)?sh\s+-l?c\s+"#)
  private static let envPrefix = regex(#"^(?:export\s+\w+=(?:'[^']*'|"[^"]*"|\S*)\s*(?:;|&&|\n)\s*|\w+=(?:'[^']*'|"[^"]*"|\S+)\s+(?=\S))"#)
  private static let osc = regex(#"\x{1B}\][^\x{07}\x{1B}]*(?:\x{07}|\x{1B}\\)"#)
  private static let csi = regex(#"\x{1B}\[[0-?]*[ -/]*[@-~]"#)
  private static let escape = regex(#"\x{1B}[=>@-_]"#)
  private static let backspace = regex(#"[^\n\x{08}]\x{08}"#)
  // Nerd Font glyphs (private use) show as boxes in the watch's font.
  private static let controls = regex(#"[\x{00}-\x{08}\x{0B}-\x{1F}\x{7F}\x{E000}-\x{F8FF}]"#)

  private static func replace(_ re: NSRegularExpression, _ text: String, _ template: String = "") -> String {
    re.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
  }
  private static func group(_ re: NSRegularExpression, _ text: String, _ at: Int = 1) -> String? {
    guard let match = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
    return Range(match.range(at: at), in: text).map { String(text[$0]) } ?? ""
  }
  private static func tag(_ name: String, _ text: String) -> String? {
    group(regex("<\(name)>([\\s\\S]*?)</\(name)>", .caseInsensitive), text).map(trim).flatMap { $0.isEmpty ? nil : $0 }
  }
  static func trim(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

  /// A user message without the envelopes agents and Codex Desktop wrap around what was typed.
  static func userText(_ raw: String, images: Int) -> String {
    var text = trim(raw.replacingOccurrences(of: "\r\n", with: "\n"))
    guard text.contains("<") || text.hasPrefix("# Files") else { return text }
    if let body = group(heartbeatMessage, text) { return tag("instructions", body) ?? trim(replace(regex(#"<(automation_id|current_time_iso)>[\s\S]*?</\1>"#, .caseInsensitive), body)) }
    if let body = group(automationMessage, text) { return tag("body", body) ?? tag("title", body) ?? "" }
    text = trim(replace(contextSummary, text))
    if let inner = group(userRequest, text) { text = trim(inner) }
    if let inner = group(originalTask, text) { text = trim(inner) }
    if let inner = group(questionReply, text), let parsed = try? JSONSerialization.jsonObject(with: Data(trim(inner).utf8)) {
      let entries = parsed as? [[String: Any]] ?? (parsed as? [String: Any]).map { [$0] } ?? []
      let lines = entries.compactMap { entry -> String? in
        guard let answer = entry["answer"] as? String ?? (entry["answers"] as? [String])?.joined(separator: " / ") else { return nil }
        let question = trim(entry["question"] as? String ?? ""), said = trim(answer).isEmpty ? "已跳过" : trim(answer)
        return question.isEmpty ? said : "\(question) → \(said)"
      }
      if !lines.isEmpty { return lines.joined(separator: "\n") }
    }
    if images > 0, let request = group(imageEnvelope, text) { return trim(request) }
    return text
  }

  /// An agent reply without Codex Desktop's `<heartbeat>` trailer.
  static func agentText(_ raw: String) -> String {
    guard raw.range(of: "<heartbeat>", options: .caseInsensitive) != nil else { return raw }
    var message: String?
    var found = false
    let ns = raw as NSString
    var visible = raw
    for match in heartbeatTrailer.matches(in: raw, range: NSRange(location: 0, length: ns.length)).reversed() {
      let inner = ns.substring(with: match.range(at: 1))
      let decision = tag("decision", inner), automation = tag("automation_id", inner), said = tag("message", inner)
      guard decision != nil || automation != nil || said != nil else { continue }
      found = true; message = message ?? said
      visible = (visible as NSString).replacingCharacters(in: match.range, with: "")
    }
    guard found else { return raw }
    let text = trim(visible)
    return text.isEmpty ? message ?? "定时检查完成" : text
  }

  /// The agent's own English verb and wrapping backticks off a tool title.
  static func toolTitle(_ title: String) -> String {
    var text = trim(replace(englishVerb, title))
    if text.count > 2, text.hasPrefix("`"), text.hasSuffix("`") { text = String(text.dropFirst().dropLast()) }
    return trim(text)
  }

  /// The shell wrapper and environment prefixes agents put around a command.
  static func command(_ raw: String) -> String {
    var text = trim(raw)
    if let prefix = shellPrefix.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)), let range = Range(prefix.range, in: text) {
      let word = trim(String(text[range.upperBound...]))
      if word.count >= 2, let quote = word.first, quote == "'" || quote == "\"", word.last == quote {
        let inner = String(word.dropFirst().dropLast())
        text = quote == "'" ? inner.replacingOccurrences(of: "'\\''", with: "'") : inner.replacingOccurrences(of: "\\\"", with: "\"")
      } else if !word.contains(" ") { text = word }
    }
    while true {
      let next = replace(envPrefix, text)
      if next == text { break }
      text = next
    }
    text = trim(text)
    return text.isEmpty ? raw : text
  }

  /// Terminal output as readable lines: escapes and control bytes out, the latest lines kept.
  static func terminalTail(_ raw: String, lines limit: Int = 12, chars: Int = 600) -> String {
    guard !raw.isEmpty else { return "" }
    var text = replace(escape, replace(csi, replace(osc, raw)))
    text = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    while text.contains("\u{0008}") {
      let next = replace(backspace, text)
      if next == text { break }
      text = next
    }
    text = replace(controls, text)
    var lines: [String] = []
    for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
      let tidy = line.trimmingCharacters(in: .whitespaces)
      if tidy == "%" || (tidy.isEmpty && (lines.last?.isEmpty ?? true)) { continue }
      lines.append(tidy)
    }
    while lines.last?.isEmpty == true { lines.removeLast() }
    return String(lines.suffix(limit).joined(separator: "\n").suffix(chars))
  }

  static func baseName(_ path: String) -> String { path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path }

  /// Markdown flattened to one line, for subtitles (wire's `plainPreview`, simplified).
  static func plain(_ text: String) -> String {
    var out = text.replacingOccurrences(of: #"```[\s\S]*?```"#, with: " ", options: .regularExpression)
    out = out.replacingOccurrences(of: #"`([^`]*)`"#, with: "$1", options: .regularExpression)
    out = out.replacingOccurrences(of: #"!?\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
    out = out.replacingOccurrences(of: #"(?m)^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+"#, with: "", options: .regularExpression)
    out = out.replacingOccurrences(of: #"(\*\*|__|~~)(\S(?:.*?\S)?)\1"#, with: "$2", options: .regularExpression)
    return trim(out.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression))
  }

  /// What the watch shows for an item (the phone's `extractAllWatchTimelineItems`); nil hides it.
  static func row(_ item: WatchHistoryItem) -> [String: Any]? {
    var row: [String: Any] = ["id": item.id, "kind": item.kind]
    switch item.kind {
    case "user":
      let text = userText(item.text.string, images: item.images)
      guard !text.isEmpty || item.images > 0 else { return nil }
      row["kind"] = text.isEmpty ? "image" : "user"
      row["title"] = item.images > 0 ? "你 · 附图(\(item.images))" : "你"
      row["text"] = text.isEmpty ? "发送了 \(item.images) 张图片" : text
      row["status"] = "completed"
    case "assistant":
      let text = trim(agentText(item.text.string))
      guard !text.isEmpty || item.images > 0 else { return nil }
      row["kind"] = text.isEmpty ? "image" : "assistant"
      row["title"] = item.images > 0 ? "Agent · 附图(\(item.images))" : "Agent"
      row["text"] = text.isEmpty ? "生成了 \(item.images) 张图片" : text
      row["status"] = item.streaming ? "running" : "completed"
    case "thought":
      let text = trim(item.text.string)
      guard !text.isEmpty else { return nil }
      row["title"] = "思考"; row["text"] = text; row["status"] = item.streaming ? "running" : "completed"
    case "tool": tool(item, into: &row)
    case "plan":
      let entries = item.info["entries"] as? [[String: Any]] ?? []
      guard !entries.isEmpty else { return nil }
      row["title"] = item.title.isEmpty ? "执行计划" : item.title
      row["text"] = entries.prefix(8).map { entry -> String in
        let status = entry["status"] as? String
        return (status == "completed" ? "✓ " : status == "in_progress" ? "▸ " : "○ ") + (entry["content"] as? String ?? "")
      }.joined(separator: "\n")
      row["status"] = entries.allSatisfy { $0["status"] as? String == "completed" } ? "completed" : "running"
    case "notice":
      let text = trim(item.text.string)
      guard !text.isEmpty || !item.title.isEmpty else { return nil }
      if text.isEmpty { row["text"] = item.title } else { row["text"] = text; if !item.title.isEmpty { row["title"] = item.title } }
      row["status"] = item.status
    default:
      row["title"] = item.title; row["text"] = item.text.string; row["status"] = item.status
      if !item.detail.isEmpty { row["detail"] = item.detail }
    }
    if let data = item.imageData { row["imageBase64"] = data; row["imageMimeType"] = item.imageMime ?? "image/png" }
    return row
  }

  private static func tool(_ item: WatchHistoryItem, into row: inout [String: Any]) {
    let status = item.status == "failed" ? "failed" : item.status == "completed" ? "completed" : "running"
    let info = item.info, title = toolTitle(item.title)
    let output = terminalTail(item.output)
    if info["type"] as? String == "subagent" || item.hasSub {
      let type = info["agentType"] as? String ?? "Subagent", name = info["name"] as? String
      let task = trim(info["task"] as? String ?? "")
      let detail = output.isEmpty ? item.subLatest : output
      row["kind"] = "subagent"
      row["title"] = "子代理 · \(name ?? type)"
      let fallback = ["Sub-agent", ""].contains(title) ? (item.name.isEmpty ? "执行子代理任务" : item.name) : title
      row["text"] = String((task.isEmpty ? fallback : task).prefix(400))
      if !detail.isEmpty { row["detail"] = String(detail.suffix(400)) }
      row["subagentType"] = String(type.prefix(48))
      if let name { row["subagentName"] = String(name.prefix(48)) }
      if let model = info["model"] as? String { row["subagentModel"] = String(model.prefix(64)) }
      row["status"] = info["state"] as? String == "running" ? "running" : status
      return
    }
    if !item.diffs.isEmpty || item.toolKind == "edit" {
      let path = item.diffs.first?.path ?? (item.location.isEmpty ? (title.isEmpty ? "文件修改" : title) : item.location)
      let files = Array(item.diffs.prefix(6))
      row["kind"] = "diff"
      row["title"] = "文件修改"
      row["text"] = baseName(path) + (item.diffs.count > 1 ? " 等 \(item.diffs.count) 个文件" : "")
      row["filePath"] = String(path.suffix(240))
      if !item.diffs.isEmpty {
        row["diffAdded"] = item.diffs.reduce(0) { $0 + $1.added }; row["diffRemoved"] = item.diffs.reduce(0) { $0 + $1.removed }
      }
      // Every edited file first, so even the collapsed card names them; then the first change.
      let list = item.diffs.count > 1 ? files.map { "• \(baseName($0.path))  +\($0.added) -\($0.removed)" } + (item.diffs.count > files.count ? ["• …"] : []) : []
      let detail = (list + [files.first?.preview ?? output]).filter { !$0.isEmpty }.joined(separator: "\n")
      if !detail.isEmpty { row["detail"] = String(detail.prefix(1200)) }
      row["status"] = status
      return
    }
    let mcp = info["type"] as? String == "mcp" ? info["server"] as? String : nil
    row["title"] = mcp.map { "MCP · \($0)" } ?? [
      "execute": "执行命令", "search": "搜索代码", "read": "读取文件", "fetch": "获取网页", "think": "思考", "delete": "删除文件", "move": "移动文件",
    ][item.toolKind] ?? (info["type"] as? String == "web_search" ? "网络搜索" : "工具调用")
    let subject = title.isEmpty ? (item.name.isEmpty ? "工具调用" : item.name) : title
    row["text"] = String((item.toolKind == "execute" ? command(subject) : subject).prefix(400))
    let detail = !output.isEmpty ? output : !item.content.isEmpty ? terminalTail(item.content) : terminalTail(item.rawOutput)
    if !detail.isEmpty { row["detail"] = detail }
    row["status"] = status
  }
}

enum WatchSnapshotBuilder {
  static func computerKey(gateway: URL, machine: WatchMachine) -> String { "watch:\(gateway.absoluteString):\(machine.id)" }

  /// The wire's `classifySessionPhase`: an unknown state is still starting, not offline.
  static func phase(_ session: [String: Any], online: Bool) -> String {
    let state = session["state"] as? String
    if !online || state == "offline" { return "stale" }
    let permission = session["permission"] as? [String: Any]
    if !(permission?["questions"] as? [Any] ?? []).isEmpty || !(session["asyncQuestions"] as? [Any] ?? []).isEmpty { return "waiting_for_input" }
    if permission != nil || state == "waiting" { return "waiting_for_approval" }
    switch state {
    case "running": return "running"
    case "error": return "failed"
    case "unknown", "starting": return "starting"
    default: return "completed"
    }
  }

  /// The wire's `liveActivitySessionTask` subtitle, in the same words.
  static func subtitle(_ session: [String: Any], phase: String) -> String {
    let preview = (session["preview"] as? String).map(WatchFormat.plain).flatMap { $0.isEmpty ? nil : $0 }
    if session["driver"] as? String == "desktop" && phase.hasPrefix("waiting") { return "在电脑终端等待确认 · 可接管后在腕表处理" }
    switch phase {
    case "waiting_for_approval", "waiting_for_input":
      return (session["permission"] as? [String: Any])?["title"] as? String
        ?? (session["asyncQuestions"] as? [[String: Any]])?.first?["title"] as? String ?? "需要你的确认"
    case "completed": return preview ?? "本轮任务已结束"
    case "failed": return preview ?? "执行出错，打开任务查看"
    case "stale": return preview ?? "电脑离线"
    default:
      let activity = session["activity"] as? [String: Any]
      if activity?["kind"] as? String == "responding", let preview { return preview }
      return activityText(activity)
    }
  }

  static func activityText(_ activity: [String: Any]?) -> String {
    guard let activity else { return "正在运行…" }
    switch activity["kind"] as? String {
    case "thinking": return "思考中…"
    case "responding": return "正在回复…"
    default:
      let kind = activity["toolKind"] as? String ?? ""
      let verb = ["read": "读取", "edit": "编辑", "delete": "删除", "move": "移动", "search": "搜索", "execute": "运行", "think": "思考", "fetch": "获取", "switch_mode": "切换模式"][kind] ?? ""
      let subject = (activity["title"] as? String).map { kind == "execute" ? WatchFormat.command(WatchFormat.toolTitle($0)) : WatchFormat.toolTitle($0) } ?? ""
      let text = [verb, subject].filter { !$0.isEmpty }.joined(separator: " ")
      return text.isEmpty ? "正在使用工具…" : text
    }
  }

  static func snapshot(gateway: URL, machine: WatchMachine?, machines: [WatchMachine], online: Bool,
                       sessions: [String: [String: Any]], terminals: [String: [String: Any]],
                       histories: [String: WatchHistory], outputs: [String: String], info: [String: Any], projects: [[String: Any]]) throws -> String {
    let key = machine.map { computerKey(gateway: gateway, machine: $0) } ?? ""
    let rank = ["waiting_for_approval": 0, "waiting_for_input": 0, "failed": 1, "running": 2, "starting": 3, "completed": 4, "stale": 5]
    let active = sessions.values.filter { $0["archived"] as? Bool != true }.sorted {
      let a = rank[phase($0, online: online)] ?? 5, b = rank[phase($1, online: online)] ?? 5
      if a != b { return a < b }
      return ($0["updatedAt"] as? Double ?? 0) > ($1["updatedAt"] as? Double ?? 0)
    }
    let agents = info["agents"] as? [[String: Any]] ?? []
    let cards = active.prefix(30).map { session -> [String: Any] in
      let id = session["id"] as? String ?? "", state = session["state"] as? String ?? ""
      let cwd = session["cwd"] as? String ?? "", agent = session["agent"] as? String ?? ""
      let driver = session["driver"] as? String ?? "", phase = phase(session, online: online)
      let history = histories[id] ?? WatchHistory()
      let permission = session["permission"] as? [String: Any]
      let question = (permission?["questions"] as? [[String: Any]])?.first
      let tier = agents.first { $0["id"] as? String == agent }?["tier"] as? String
      let actions = driver == "desktop" || !online ? [] : actions(session, key: key)
      let visible = min(history.visibleItems, WatchHistory.maxVisibleItems)
      let (items, more) = history.rows(limit: visible)
      var card: [String: Any] = [
        "id": id, "title": String((session["title"] as? String ?? "新会话").prefix(120)),
        "subtitle": String(subtitle(session, phase: phase).prefix(240)),
        "project": URL(fileURLWithPath: cwd).lastPathComponent, "cwd": cwd, "agent": agent,
        "phase": phase, "updatedAt": session["updatedAt"] as? Double ?? 0,
        "canSend": online && driver != "desktop" && tier != "terminal",
        "canCancel": online && ["running", "waiting", "unknown"].contains(state),
        "handoff": driver == "desktop" ? "can_takeover" : driver == "remote" && (tier == "handoff" || agent == "claude") ? "can_release" : "none",
        "deepLink": "", "actions": actions,
        // A request the watch can't answer (or one it can't see) points to the phone or computer.
        "hasMoreActions": (phase.hasPrefix("waiting") && actions.isEmpty) || ((permission?["questions"] as? [Any] ?? []).count > 1),
        "hasEarlier": visible < WatchHistory.maxVisibleItems && (history.startSeq > 0 || more),
        "items": items, "configOptions": history.configuration,
      ]
      card["promptTitle"] = question?["text"] ?? permission?["title"]
      card["detailPreview"] = (session["preview"] as? String).map { String(WatchFormat.plain($0).prefix(200)) }
      card["model"] = session["model"]
      card["subagents"] = session["subagents"]
      card["branch"] = (session["worktree"] as? [String: Any])?["branch"]
      if !history.plan.isEmpty {
        card["planProgress"] = ["total": history.plan.count, "completed": history.plan.filter { $0["status"] as? String == "completed" }.count,
          "currentStep": history.plan.first { $0["status"] as? String == "in_progress" }?["content"] as? String ?? ""]
      }
      return card
    }
    let terminalCards = terminals.values.sorted { ($0["activeAt"] as? Double ?? 0) > ($1["activeAt"] as? Double ?? 0) }.prefix(20).map { terminal -> [String: Any] in
      let id = terminal["id"] as? String ?? "", cwd = terminal["cwd"] as? String ?? ""
      var card: [String: Any] = ["id": id, "title": terminal["title"] as? String ?? "终端", "subtitle": terminal["command"] as? String ?? cwd,
        "project": URL(fileURLWithPath: cwd).lastPathComponent, "cwd": cwd, "phase": online ? (terminal["exitCode"] == nil ? "running" : (terminal["exitCode"] as? Int ?? 0) == 0 ? "completed" : "failed") : "stale",
        "activeAt": terminal["activeAt"] as? Double ?? 0, "deepLink": ""]
      card["command"] = terminal["command"]; card["exitCode"] = terminal["exitCode"]; card["outputPreview"] = outputs[id].map(cleanTerminal)
      return card
    }
    var paths = Set<String>()
    var workspaces: [[String: String]] = []
    for path in projects.compactMap({ $0["path"] as? String ?? $0["cwd"] as? String }) + active.compactMap({ $0["cwd"] as? String }) + [info["home"] as? String ?? ""] {
      if !path.isEmpty && paths.insert(path).inserted && workspaces.count < 12 { workspaces.append(["path": path, "name": URL(fileURLWithPath: path).lastPathComponent]) }
    }
    let payload: [String: Any] = ["version": 1, "generatedAt": Date().timeIntervalSince1970 * 1000,
      "computerKey": key, "computerName": machine?.name ?? "选择电脑", "online": online,
      "statusLabel": online ? "已独立连接" : "连接中断", "computers": machines.map {
        ["key": computerKey(gateway: gateway, machine: $0), "name": $0.name, "online": $0.online, "selected": $0.id == machine?.id, "platform": $0.platform ?? "unknown"]
      },
      "waitingCount": active.filter { phase($0, online: online).hasPrefix("waiting") }.count,
      "runningCount": active.filter { phase($0, online: online) == "running" }.count,
      "failedCount": active.filter { phase($0, online: online) == "failed" }.count,
      "completedCount": active.filter { phase($0, online: online) == "completed" }.count,
      // As the phone lists them: terminal-tier agents are started from a terminal, not a session.
      "availableAgents": agents.filter { $0["installed"] as? Bool == true && $0["tier"] as? String != "terminal" }.compactMap { $0["id"] as? String },
      "workspaces": workspaces, "sessions": cards, "terminals": terminalCards]
    return String(decoding: try JSONSerialization.data(withJSONObject: payload), as: UTF8.self)
  }

  static func actions(_ session: [String: Any], key: String) -> [[String: Any]] {
    let id = session["id"] as? String ?? ""
    func action(_ request: String, _ option: String, _ label: String, _ kind: String, _ role: String = "accept", _ question: String? = nil) -> [String: Any] {
      var value: [String: Any] = ["id": "\(request):\(option)", "computerKey": key, "sessionId": id, "requestId": request, "optionId": option, "label": label, "kind": kind, "role": role]
      value["questionId"] = question
      return value
    }
    if let permission = session["permission"] as? [String: Any], let request = permission["requestId"] as? String {
      let questions = permission["questions"] as? [[String: Any]] ?? []
      if permission["url"] != nil { return [] }
      if questions.count == 1, let q = questions.first, q["kind"] as? String == "choice", q["secret"] as? Bool != true {
        return (q["options"] as? [[String: Any]] ?? []).prefix(20).compactMap { option in
          guard let value = option["value"] as? String else { return nil }
          return action(request, value, option["label"] as? String ?? value, "answer", "accept", q["id"] as? String)
        }
      }
      if !questions.isEmpty { return [] }
      return (permission["options"] as? [[String: Any]] ?? []).prefix(20).compactMap { option in
        guard let value = option["optionId"] as? String else { return nil }
        return action(request, value, option["name"] as? String ?? value, "permission", (option["kind"] as? String ?? "").hasPrefix("reject") ? "reject" : "accept")
      }
    }
    if let question = (session["asyncQuestions"] as? [[String: Any]])?.first, let request = question["id"] as? String {
      return (question["options"] as? [String] ?? []).prefix(20).map { action(request, $0, $0, "async-answer") }
    }
    return []
  }

  static func cleanTerminal(_ raw: String) -> String {
    var text = raw.replacingOccurrences(of: "\u{001B}\\][^\u{0007}\u{001B}]*(?:\u{0007}|\u{001B}\\\\)", with: "", options: .regularExpression)
    // Swift's regex engine accepts literal control characters, unlike JS escaping.
    text = text.replacingOccurrences(of: "\u{001B}\\[[0-?]*[ -/]*[@-~]", with: "", options: .regularExpression)
    text = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    return String(text.suffix(2400))
  }
}
