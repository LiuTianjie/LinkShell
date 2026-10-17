import Foundation

// Native projection of the same host summaries/events consumed by the phone.
// No guessed approvals or settings: only options advertised by the host are actionable.
struct WatchHistory {
  var startSeq = 0
  var events: [Int: [String: Any]] = [:]
  var visibleItems = 30

  mutating func append(_ event: [String: Any]) {
    guard let seq = event["seq"] as? Int else { return }
    events[seq] = event
    if events.count > 1500, let oldest = events.keys.min() {
      events.removeValue(forKey: oldest)
      startSeq = max(startSeq, oldest)
    }
  }
  var updates: [[String: Any]] { events.keys.sorted().compactMap { events[$0]?["update"] as? [String: Any] } }
  var configuration: [[String: Any]] { updates.last(where: { $0["sessionUpdate"] as? String == "ls_config" })?["options"] as? [[String: Any]] ?? [] }
  var plan: [[String: Any]] { updates.last(where: { $0["sessionUpdate"] as? String == "plan" })?["entries"] as? [[String: Any]] ?? [] }

  var timeline: [[String: Any]] {
    var order: [String] = []
    var items: [String: [String: Any]] = [:]
    var chunkID: String?
    var chunkType: String?
    for seq in events.keys.sorted() {
      guard let update = events[seq]?["update"] as? [String: Any], update["parentToolCallId"] == nil else { continue }
      let type = update["sessionUpdate"] as? String ?? ""
      var id = update["messageId"] as? String ?? update["toolCallId"] as? String ?? "event-\(seq)"
      if ["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"].contains(type) {
        // ACP agents may stream chunks without message IDs; keep contiguous chunks together.
        if update["messageId"] == nil, chunkType == type, let chunkID { id = chunkID }
        chunkID = id; chunkType = type
      } else if type != "ls_config" { chunkID = nil; chunkType = nil }
      var item = items[id] ?? ["id": id, "text": ""]
      switch type {
      case "user_message_chunk", "agent_message_chunk", "agent_thought_chunk":
        let content = update["content"] as? [String: Any] ?? [:]
        item["kind"] = type == "user_message_chunk" ? "user" : type == "agent_thought_chunk" ? "thought" : "assistant"
        let text = content["text"] as? String ?? (content["type"] as? String == "image" ? "[图片]" : "")
        item["text"] = String(((item["text"] as? String ?? "") + text).suffix(6000))
      case "tool_call", "tool_call_update":
        item["kind"] = "tool"
        if let title = update["title"] as? String { item["title"] = String(title.prefix(160)) }
        if let status = update["status"] as? String { item["status"] = status == "in_progress" ? "running" : status }
        let detail = update["detail"] as? [String: Any] ?? [:]
        if let command = detail["command"] as? String { item["text"] = String(command.prefix(1000)) }
        if let output = detail["output"] as? String { item["detail"] = String(output.suffix(1000)) }
        if let path = detail["path"] as? String { item["filePath"] = path }
        if let content = update["content"] as? [[String: Any]] {
          let texts = content.compactMap { entry -> String? in
            if let value = entry["content"] as? [String: Any] { return value["text"] as? String }
            if let diff = entry["diff"] as? String { return diff }
            return entry["text"] as? String
          }
          if !texts.isEmpty { item["detail"] = String(texts.joined(separator: "\n").suffix(1600)) }
        }
      case "plan":
        item["kind"] = "plan"; item["title"] = "执行计划"
        item["text"] = (update["entries"] as? [[String: Any]] ?? []).map { ($0["status"] as? String == "completed" ? "✓ " : "· ") + ($0["content"] as? String ?? "") }.joined(separator: "\n")
      case "ls_permission": item["kind"] = "permission"; item["text"] = update["title"] as? String ?? "等待确认"
      case "ls_notice": item["kind"] = "error"; item["text"] = update["title"] as? String ?? ""; item["detail"] = update["detail"]
      default: continue
      }
      if items[id] == nil { order.append(id) }
      items[id] = item
    }
    return order.compactMap { items[$0] }
  }
}

enum WatchSnapshotBuilder {
  static func computerKey(gateway: URL, machine: WatchMachine) -> String { "watch:\(gateway.absoluteString):\(machine.id)" }
  static func phase(_ session: [String: Any], online: Bool) -> String {
    if !online { return "stale" }
    if let permission = session["permission"] as? [String: Any] {
      return (permission["questions"] as? [Any] ?? []).isEmpty ? "waiting_for_approval" : "waiting_for_input"
    }
    if !(session["asyncQuestions"] as? [Any] ?? []).isEmpty { return "waiting_for_input" }
    switch session["state"] as? String {
    case "running": return "running"
    case "starting": return "starting"
    case "waiting": return "waiting_for_approval"
    case "error": return "failed"
    case "idle": return "completed"
    default: return "stale"
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
      let items = history.timeline
      var card: [String: Any] = [
        "id": id, "title": String((session["title"] as? String ?? "新会话").prefix(120)),
        "subtitle": String((permission?["title"] as? String ?? session["preview"] as? String ?? state).prefix(240)),
        "project": URL(fileURLWithPath: cwd).lastPathComponent, "cwd": cwd, "agent": agent,
        "phase": phase, "updatedAt": session["updatedAt"] as? Double ?? 0,
        "canSend": online && driver != "desktop" && tier != "terminal",
        "canCancel": online && ["running", "waiting", "unknown"].contains(state),
        "handoff": driver == "desktop" ? "can_takeover" : driver == "remote" && (tier == "handoff" || agent == "claude") ? "can_release" : "none",
        "deepLink": "", "actions": actions,
        "hasMoreActions": (permission != nil && actions.isEmpty) || ((permission?["questions"] as? [Any] ?? []).count > 1),
        "hasEarlier": history.visibleItems < 100 && (history.startSeq > 0 || items.count > history.visibleItems),
        "items": Array(items.suffix(history.visibleItems)), "configOptions": history.configuration,
      ]
      card["promptTitle"] = question?["text"] ?? permission?["title"]
      card["detailPreview"] = session["preview"]
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
      "availableAgents": agents.filter { $0["installed"] as? Bool == true }.compactMap { $0["id"] as? String },
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
