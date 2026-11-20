import Foundation
import SwiftUI
import UIKit

public struct WatchAction: Codable, Hashable, Identifiable {
  public var id: String
  public var label: String
  public var role: String
  public var kind: String
  public var computerKey: String
  public var sessionId: String
  public var requestId: String
  public var optionId: String
  public var questionId: String?
}

public struct WatchComputer: Codable, Hashable, Identifiable {
  public var key: String
  public var name: String
  public var online: Bool
  public var selected: Bool
  public var platform: String?
  public var id: String { key }
}

public struct WatchWorkspace: Codable, Hashable, Identifiable {
  public var path: String
  public var name: String
  public var id: String { path }
}

public struct WatchConfigOptionValue: Codable, Hashable, Identifiable {
  public var value: String
  public var name: String
  public var description: String?
  public var id: String { value }
}

public struct WatchConfigOption: Codable, Hashable, Identifiable {
  public var id: String
  public var name: String
  public var category: String?
  public var current: String
  public var currentLabel: String?
  public var values: [WatchConfigOptionValue]
}

public struct WatchSubagentCount: Codable, Hashable {
  public var total: Int
  public var running: Int
}

public struct WatchPlanProgress: Codable, Hashable {
  public var completed: Int
  public var total: Int
  public var currentStep: String?

  public var fraction: Double {
    guard total > 0 else { return 0 }
    return min(1.0, max(0.0, Double(completed) / Double(total)))
  }

  public var percent: Int {
    Int((fraction * 100.0).rounded())
  }
}

public struct WatchTimelineItem: Codable, Hashable, Identifiable {
  public var id: String
  public var kind: String
  public var title: String?
  public var text: String
  public var detail: String?
  public var status: String?
  public var filePath: String?
  public var diffAdded: Int?
  public var diffRemoved: Int?
  public var subagentType: String?
  public var subagentName: String?
  public var subagentModel: String?
  public var imageBase64: String?
  public var imageMimeType: String?
}

public struct WatchSession: Codable, Hashable, Identifiable {
  public var id: String
  public var title: String
  public var subtitle: String
  public var project: String
  public var cwd: String?
  public var branch: String?
  public var agent: String
  public var model: String?
  public var mode: String?
  public var subagents: WatchSubagentCount?
  public var configOptions: [WatchConfigOption]?
  public var phase: String
  public var updatedAt: Double
  public var pinned: Bool?
  public var promptTitle: String?
  public var commandPreview: String?
  public var detailPreview: String?
  public var goal: String?
  public var planProgress: WatchPlanProgress?
  public var actions: [WatchAction]?
  public var hasMoreActions: Bool?
  public var hasEarlier: Bool? = nil
  public var items: [WatchTimelineItem]?
  public var canCancel: Bool
  public var canSend: Bool
  public var handoff: String
  public var deepLink: String

  public var needsAttention: Bool {
    phase == "waiting_for_approval" || phase == "waiting_for_input"
  }

  public var isRunning: Bool {
    phase == "running" || phase == "starting"
  }

  public var isFailed: Bool {
    phase == "failed"
  }
}

public struct WatchTerminal: Codable, Hashable, Identifiable {
  public var id: String
  public var title: String
  public var subtitle: String
  public var project: String
  public var cwd: String?
  public var command: String?
  public var outputPreview: String?
  public var phase: String
  public var activeAt: Double
  public var exitCode: Int?
  public var deepLink: String
}

public struct WatchSnapshot: Codable, Hashable {
  public var version: Int
  public var generatedAt: Double
  public var computerKey: String
  public var computerName: String
  public var online: Bool
  public var statusLabel: String
  public var waitingCount: Int
  public var runningCount: Int
  public var failedCount: Int
  public var completedCount: Int
  public var availableAgents: [String]?
  public var workspaces: [WatchWorkspace]?
  public var computers: [WatchComputer]
  public var sessions: [WatchSession]
  public var terminals: [WatchTerminal]

  /// What the app shows, restored at launch.
  public static let cacheKey = "LinkShellWatch.cachedSnapshot.v1"
  /// What the watch face shows. Usually the same as `cacheKey`; while the watch connects on its
  /// own, the phone may still bring this one up to date in the background (same computer only).
  public static let widgetCacheKey = "LinkShellWatch.widgetSnapshot.v1"

  /// Never synced: nothing has been heard from a computer yet.
  public var isUnsynced: Bool { generatedAt <= 0 }

  /// Older than this, a count on the watch face may no longer be true and is shown as such.
  public func isStale(at now: Date = Date(), after limit: TimeInterval = 600) -> Bool {
    !isUnsynced && now.timeIntervalSince1970 - generatedAt / 1000 > limit
  }

  /// The newest snapshot kept on this watch, or nil when it has never synced. A face must not
  /// fall back to sample content: "1 待确认" on a watch that has never connected is a lie.
  public static func stored(in shared: UserDefaults?, file: URL?, standard: UserDefaults = .standard) -> WatchSnapshot? {
    let texts = [shared?.string(forKey: widgetCacheKey), shared?.string(forKey: cacheKey),
                 file.flatMap { try? String(contentsOf: $0, encoding: .utf8) }, standard.string(forKey: cacheKey)]
    return texts.compactMap { text in
      text.flatMap { $0.data(using: .utf8) }.flatMap { try? JSONDecoder().decode(WatchSnapshot.self, from: $0) }
    }.filter { !$0.isUnsynced }.max { $0.generatedAt < $1.generatedAt }
  }

  public static let empty = WatchSnapshot(
    version: 1,
    generatedAt: 0,
    computerKey: "",
    computerName: "未连接电脑",
    online: false,
    statusLabel: "请在 iPhone 上打开 LinkShell",
    waitingCount: 0,
    runningCount: 0,
    failedCount: 0,
    completedCount: 0,
    // Only agents a computer reports: an invented list would offer agents it doesn't have.
    availableAgents: [],
    workspaces: [],
    computers: [],
    sessions: [],
    terminals: []
  )
}

public struct WatchQuickPrompt: Identifiable, Hashable {
  public let id: String
  public let label: String
  public let icon: String
  public let prompt: String

  public static let defaults: [WatchQuickPrompt] = [
    WatchQuickPrompt(id: "continue", label: "继续推进", icon: "play.fill", prompt: "请继续推进当前任务。"),
    WatchQuickPrompt(id: "test", label: "运行测试", icon: "checkmark.circle.fill", prompt: "请运行相关测试并汇报结果。"),
    WatchQuickPrompt(id: "summary", label: "总结进展", icon: "text.alignleft", prompt: "请简明总结目前的进展与下一步计划。"),
    WatchQuickPrompt(id: "fix", label: "排查修复", icon: "wrench.and.screwdriver.fill", prompt: "请分析当前报错原因并直接修复验证。"),
  ]
}

public struct WatchAgent: Identifiable, Hashable {
  public let id: String

  public init(id: String) {
    self.id = id.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  public var name: String {
    switch id {
    case "claude": return "Claude"
    case "codex": return "Codex"
    case "antigravity": return "Antigravity"
    case "cursor": return "Cursor"
    case "gemini": return "Gemini"
    case "copilot": return "Copilot"
    case "grok": return "Grok"
    case "opencode": return "OpenCode"
    case "cline": return "Cline"
    case "kilo": return "Kilo"
    case "qwen": return "Qwen"
    case "kimi": return "Kimi"
    case "codebuddy": return "CodeBuddy"
    case "qoder": return "Qoder"
    case "minimax": return "MiniMax"
    case "trae": return "TRAE"
    case "deepseek": return "DeepSeek"
    case "glm": return "GLM"
    case "iflow": return "iFlow"
    case "comate": return "Comate"
    case "terminal": return "终端"
    default: return id.isEmpty ? "Agent" : id.capitalized
    }
  }

  public var accentColor: Color {
    switch id {
    case "claude": return Color(red: 0.85, green: 0.47, blue: 0.34)
    case "codex": return Color(red: 0.39, green: 0.40, blue: 0.95)
    case "antigravity": return Color(red: 0.26, green: 0.52, blue: 0.96)
    case "cursor": return Color(red: 0.13, green: 0.77, blue: 0.69)
    case "gemini": return Color(red: 0.31, green: 0.55, blue: 0.97)
    case "copilot": return Color(red: 0.55, green: 0.36, blue: 0.96)
    case "grok": return Color(red: 0.96, green: 0.25, blue: 0.37)
    case "cline": return Color(red: 0.45, green: 0.48, blue: 0.56)
    case "kilo": return Color(red: 0.91, green: 0.88, blue: 0.28)
    case "qwen": return Color(red: 0.03, green: 0.18, blue: 1.00)
    case "kimi": return Color(red: 0.09, green: 0.51, blue: 1.00)
    case "codebuddy": return Color(red: 0.42, green: 0.30, blue: 1.00)
    case "qoder": return Color(red: 0.39, green: 0.45, blue: 0.55)
    case "minimax": return Color(red: 0.89, green: 0.09, blue: 0.49)
    case "trae": return Color(red: 0.20, green: 0.94, blue: 0.55)
    case "deepseek": return Color(red: 0.30, green: 0.42, blue: 1.00)
    case "glm": return Color(red: 0.22, green: 0.35, blue: 1.00)
    case "iflow": return Color(red: 1.00, green: 0.38, blue: 0.01)
    case "comate": return Color(red: 0.14, green: 0.64, blue: 0.98)
    case "terminal": return Color(red: 0.20, green: 0.78, blue: 0.35)
    default: return Color(red: 0.39, green: 0.40, blue: 0.95)
    }
  }

  private static let icons: [String: UIImage] = {
    let raw: [String: String] = [
      "codex": "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",
      "gemini": "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",
      "claude": "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAABmJLR0QA/wD/AP+gvaeTAAAC0klEQVR4nO3bvWsTcRzH8W/TI82DjTE1MYnVFimWxgdKRNBBV2cnJx1cnET/DWeH0kUQHAV3RxcHKZRoKUWp1dbGJjGPXh4uudQh7alH20/85ecD+HlNx4/yvcu7/LjehQ6lZk4L7c/zty/gX8dAAAMBDAQwEMBAAAMBDAQwEMBAAAMBDAQwEMBAAAMBDAQwEMBAAAMBDAQwEMBAAAMBDAQwEMBAAAMBDAQwEGBonHXU7z0zFtQ4UM3SF7PQsHRN0xloKhy4n57UOFDNg1fvNQbiFgMYCGAggIEABgIYCNB5m9/PfGa9anVE5Fhg5FYqOeC0x0ubuUZLREJe4875Exqu70B/ItDCVjXfsETk1OHA4NMW89W1akNEon7v4NMgbjGAgQAGAhgIYCBA8S52fSqWCPpci7HA3reVm6lks9MVkVHvsNrpfnRjOl6zbBHxGXv/dq9NjqVjIddi1mw+e5dTOJ1ioIvx8Eyk31c/V44fUTvLni4lwgf/wGzUXUdEloumWiBuMYCBAAYCGAhgIICBgCG1f+oNGsOGxx33Qjx0d/akjqsayMPFjwufq67FTrdrdmyFaYp/B5kdW8R9vnpb5Qq0q7ftitXWNY1bDGAggIEABgIYCND50j5Xt56vFXrH56KjieBI7/jFRnH3dYdxObnzLP6h2lwpfu1z8nTk0ERo5+3Ky81yzeqIiM/wXB2P9BazZut1vuZchoYPs0tnoNVKfS5T7x3fS084gZ4sZ51vNZxAmULt0ZuNPiffPjvuBHr6dmu1UheRqN/rBFopmXOZdU2f4yfcYgADAQwEMBDAQMDv+m6+1Gh/qjV7x/b2du/AsrvOYrn1C8+T5db3aZbddcY6i6WGtqdTF8XXHf8PbjGAgQAGAhgIYCCAgQAGAhgIYCCAgQAGAhgIYCCAgQAGAhgIYCCAgQAGAhgIYCCAgQAGAhgIYCCAgQAGAr4BYsSy8kPcyT0AAAAASUVORK5CYII=",
      "copilot": "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAABmJLR0QA/wD/AP+gvaeTAAAKZklEQVR4nO2beVATWR6AXyAk4UiAgGuQywAKeJaWiMKUguA5iu6gCOPizajoOqJS6lTpiI7WzCjj7owoniuIAnJ6FMgSQhCPEXAVuW+DIDBFMoRwJGDS+0d2YoSkX9N0cLaqv79ev7s/Ot2vf/2gdEn7AIluDD71BP7skIIgkIIgkIIgkIIgkIIgkIIgkIIgkIIgkIIgkIIgkIIgkIIgkIIgkIIgkIIgkIIgkIIgkIIgkIIgkIIgkIIgUD/t8DK5vL6uXtjcLBaLJRKJtFsKAGCymObm5lZWbEcHRxcXFzqd9gln+AkEIQhSXFycl5f/5OnT8vIKhUKBUtnQ0HD6tGne3l5+fr5z5syhUChjNk8VlLH8sioSiePi4lNS01paWnA0t7e3X7c2cNOmjWy2JeFz08UYCerqksTEXIiLT+jvH+1wJiammzeF7tq108LCnJC5oTMWgvh8waHDR9rb2wnsc5y19alTJ5cvX0Zgn1rRryC5fODwN9+kpqTpqf+goHWnT32n17u4HgVJpdLtYTuePn2mzjE2NuFwxpsxTft7+1vftWH/uZmYmE6w4RibGvdIe9vbOzQbent7Xbkcy2QyCZ79H+hLkFj8e3DIl1VV1RQKZeHCBStXrvjMy9vWzlZdQalUlpdVxFy4mJWdjdLPiuXL9+wOnzptioHB/5ZsCIK0trY+fvLkwYOsR48KEQSZMsU9KfG2paWFPk5EL4JkcnlI8IaSFy+4XO75n/85Y+Z0XTURBNmxMzw7+6HW0s9XLL94MQbl0V5a+vrve/c1NTV5eHgk3k7Qx29NLyvpM2eiS168+Mu4cRnpqSh2AAAUCmV/xD5dpfv3R6AvfGbOnJGRnjrO2rq4uDg6+if8M9YN8YLKyyuuXr0GADgYecDKig2t7+bmamPDGZ4/wXbC5MmToM2trNj7D0QAAC5fuVpRUTny+UIgXtD3P/yoVCoZdHrAqs8xNnFxdsGYqZXVAatoNCOFQnHmzFmss8QMwYJq6+oKCh4BAFzdXE1NzTC20np/tTBnYWzOZDInTZ4MAODnC+obGjC2wgjBgu7cSVUluFwu9lb9MhmDTs96cL+gIK+gIC/rwX0GnS6Ty7H34DRxIgAAQZCkpDsjmS8cggUJBAJVgmmG9fIBAIg6RTK53NmF68R1cuI6ObtwZXK5qFOEvQf1OujhwxzsrbBA5Nt8e3t7bW2dKj04+B5jK6VSWVVdAwC4fOXa4MAgAIBGpwEAqqprlEqlevmDzvs/QgJCobChsdHZyWmkk9cFkYIKCx8jCKJKi8RY//7PnxepVsbR0ec08/v6eouLSzw952LpRCz6MFxJSQmBgoj8ib16VapOqy8lKP+6Eaer6Pr1Gxg7qdEYrvTVa4ytsEDkFdTU9EadFgqF9Q0NLs7O6E1uxN1ULaP9/RatWbPa1NQUAND29uZeXm5vL5efnZ194+bmTaHonWzdulUmk2EaCwsLKRRKyosXL1269MGDh+3t7aoSBoNhb2//mbe3r+/eadOmEaxbF0RuoFIoFOnpGWd/Oveu9Z1mPo1mtGTx4sDALz7z9sISQkSnv7/v8eOnaWnpeTze/v37V6xYgWrEwtzc3sH+iy++CAkJdnNzQ3WCSfNff4l59OixTCbD2JBOpy9atGjDhg0rV64kOIqhhkhBbW1tCQkJV65coVKpsLaKioqTJ08uWLDAw8MDtdkIAEClUgUFBcXGxpJWp6WlZfv27WFhYZaWljidjAZkCxqOvr7en3/+edeuXbhvxB/FmAWNhba2ttu3b+/Zs4ec4kbe+TjGSVhY2O7du83NzdmdfsIgBUGgx8CNW9CfE1IQBFIQBFIQBFIQBFIQBFIQBFIQBFIQBFIQBFIQBFIQBFIQBFIQBFIQBFIQBPofq8aP8L7t0L4AAAAASUVORK5CYII=",
      "grok": "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",
      "opencode": "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAABmJLR0QA/wD/AP+gvaeTAAABXklEQVR4nO3cMQrCMBhAYRUHu3To0imjXka8iPQ44kXEyyi6dCq4mKWOnsA8qI11eN+en/AgEGjo/Pl4zPTZYuoN/DsDAQMBAwEDAQMBAwEDAQMBAwEDAQMBAwEDAQMBAwEDAQMBAwEDAQMBA4FljqH7pmnbNsfkhBDC8XAYfWyWQNfL5Xa/55ic8Or7HGM9YsBAwEDAQMBAwEDAQMBAIMtFMe18OpVlOWBhjHG7242+n7QJAtV1XVXVgIVFUYy+GeQRAwYCBgIGAgYCBgIGAgYCBgIGAgYCBgIGAgYCBgIGAgYCBgIGAgYCBgIGAgYCBgIGAgYCBgITfJvvuq4f9CI1xjj6ZtAEgX7/QuMbHjFgIGAgYCBgIGAgYCBgIJDlorjebFY/f5EaQsgxdu6PJtM8YsBAwEDAQMBAwEDAQMBAwEDAQMBAwEDAQMBAwEDAQMBAwEDAQMBAwEDAQOANaTslQLfSOEUAAAAASUVORK5CYII=",
      "cursor": "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",
      "antigravity": "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",
      "qwen": "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",
      "kimi": "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAACXBIWXMAAAsTAAALEwEAmpwYAAAEz0lEQVR4nO2b7VNUdRTH/Q821GWXh0RCQBJFecioppqyfNFMU4lZVNP0NDXTNOWQTWVTjJrDq5rMmh5eZI1TTVOiiBkImFaWZCK7gLASK0oziYBLy/XU1eXb3DtQoJD32u6eu/eeF9+Xd3/L5/M759zl/u4MhVRIVDYGMwS+yroBRQCJAHBDkAogfhDSgsiZkRlAIgDcEKQCiB+EtCByZmQGkAgANwSpAOIHIS2InBmZASQCwA1BKoD4QUgLImdGZgBdDGUwrKKq6TxKN48i/XWg4M1RVOyMIDggAhDrHdk/rOL2D0fhWY+Lkv8G0PbbOakAJYYCnq+NTAl/PMs+GMWItCA1JvCHwioyq6aHP54DwehVgcwA+heGr+/cJeFr2dJ8XgQoMaiA5l5jAj5vEQHgEqDdFUXzbkhaEJkTsHZ3RO6CFAYB3vXAszsiCCnRXTMuFfDWpnfhSnJPmdnJqeg5fjJqa/X0nkTxNddNu97E5C0omHTtqZCKNbsieK5mcjY2RnQ5sWATFwHrNlT9Jwhf29GorBM80YeSpdcbgq+J/3JbTcz/dscICJ7oM7zz3Z40fFW9kx2+bQR09/RicWFJwsG3hYBjvx43BX9bdS07dNsICHQHUbCk2DD86u3Wgp/QAgLdQSxaXGQY/vYdu9hh20ZAwAT8ZK914SekgK5jQSwsKDQOv8a68BNOQJcJ+J6UK7G7roEdsG0EdAZ6kL9oiSH43tQ5+Ka+kR2ubQT427uQm7fQMPy6+iZ2sLYR4GvvNAW/fk/iwLe8AF97J3Lm59sWvqUF+NqOGoafkpaBPQ172WHaRoDPJPyGxm/ZQdpGQKu/Azm5zoBvOQFHfO3IzllgHH7TPnaAthFwxAT89Iws7P/hJ3Z4thGwuuIFZGblGoKv5elnVrODs5UAl8nMnO3Fy69UIvSHwg7QkQJcY7nl1uXo6Oxmh+hYAa6xebD1sy/YQTpWgGssjz3xFE4PhtiBOlaAK8mNopJSNB9qYYdqGwGFxddiljvF1DUebzo2bX4PI2f/Yoeb0ALuXrEKg6Ewvjtw0PBDmIm5864y/awQN+CEFHBP2X0YCo38c/3vpwbw4EOPmJaQlZ2H2q/r2CEnlIAVK++fBH9iPv7kU/1RoxkJV8xMRsWaF3FmeOrP5I6lBJTdWz4t/PEc/PkwCouWmq6GG29ehraOADtwywoof+Bhw79s+08P4dHHnzQtITV9rv5dtOu5wVtKQLkJ+BPz0Zat+n9FzYq4at58/Tsd+qUVYeVPEXC4xX/ZELTnB6U33GRawnjmzM3WH306ugJa/R3/6/O1uaENWm3gXo6Exr37RYASBdHayeeMzBwREO8KUC44rn7b8jukArgEKKRiOHxWXzNplkdaEIcAZSza2VAjh7pkBvhjI0BL/8AZvLT2Nf0dAREQ5wpQLnh99dXKDZiXfbXzKuDtd96fdve5PWlRfU/4UtF+eO37/kdUrtuIslXl+vtl8dgArAIkqghQLLoRpAJIBIAbglQA8YOQFkTOjMwAEgHghiAVQPwgpAWRMyMzgEQAuCFIBRA/CGlB5MzIDCARAG4IUgHED0JaEDkzMgNIBIAbglQA8YOQFkTOjMwAEgHghiAVQPwgpAWRMyMzgEQAuCFw5m/TfQ7EhtHJJAAAAABJRU5ErkJggg==",
      "codebuddy": "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",
      "qoder": "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",
      "minimax": "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",
      "trae": "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAACXBIWXMAAAsTAAALEwEAmpwYAAACtElEQVR4nO2aMWtTURiG+x/OreIlsW/akNimKLlroboJddBRKGSo1sVBKCrippuaxcWto0Vw01kcBP0tgmD+wScFI2hzc09S4cvteYZ3C4fwPPf9vnNDloJyI7kbgyXg564PIAKEAPOGQAPkD4IRpDTDDhACzBsCDZA/CEaQ0gw7QAgwbwg0QP4gGEFKM+wAIcC8IdAA+YNgBCnNsAOEAPOGQAPkD4IRpDTDDhACzBsCDZA/CEaQ0sx/2wGtZzeTSlg0AcVomFQCAoYIoAE5I6hgBLEDAkt4yBL2vpUU3IL8oRRcQ8shdA4Htny5VYt0Dgdn7z2g/WbX/bU/ROb4uyJACKABI0aQMYLYAZb8Es7WZVm7cao2ZGsNW+61WMIzg1tfsd6nB7b+4b6FTnNu+N2ju7b57bGdu7LKLWhW+MXvZTiPhDH88RkxEriG6iT8eST8Cz9WQvICshL4fyR8rJZQBj9GQtICsgr4MRKq4FdJSFZAttawjc8HlWeN031/b+I53bd70Wf0vjw8ccNKVkBQbisH1634+aryvP6Pl9bc2554RmN3y/rfX0QJWH1+iwaEGSVMgz+LhEnwk29AqJAQAz9GQhl8BKi8CbPAnyah6o9VSe+AUDKO5oE/SULMv9oQoL+B6MmONe9cPdUD0hhsWevpjajPIkC+QYAQsDA7INAABBQp34ICDUBAUYcGbH59NDXt17ftwk6/Frn0br9+L2JVOb6Dx/5CWdQgCBghgAaIEWSMIHaAsYRHLGFuQeIaalxDpzwF57c37OL+tTOTULcXMZIjICzgg0ADhADzhkAD5A+CEaQ0ww4QAswbAg2QPwhGkNIMO0AIMG8INED+IBhBSjPsACHAvCHQAPmDYAQpzbADhADzhkAD5A+CEaQ0ww4QAswbAg2QPwhGkPxheOQXX7f8wl2o9ZEAAAAASUVORK5CYII=",
      "deepseek": "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",
      "glm": "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAACXBIWXMAAAsTAAALEwEAmpwYAAAEC0lEQVR4nO2b20vUURDH94/oYppd3byUWVlKQolGPlhpGRWa5Usr6pOFBWGRhYiWD1mkRBZYgkEpdqEbXRYSMjKsxLys1pKZl3Z/6RCFZU1sz+vbzs7vnN88zPPhfD5nZpbfl7UZgCiFbAxsAh9ZH6AIABGA3BCkA4AfhIwgsGbJDgARgNwQpAOAH4SMILBmyQ4AEYDcEKQDgB+EjCCwZskOABGA3BCkA4AfhIwgsGbJDgARgNwQpAOAH4SMILBmyQ4AzQW03nXi7Hl2nBUSEfCKT9yEQyPf/Z5beuIMyZm+chQcVkNAj2sU7dHrSCCELojBtvZuv+fee/QC54ZFBl26qQR4Jv7gth37yF7h+bpGv+e6PnoweuX6oEs3nYCy8rNk8PfuL5pReubOPLJzz9VeCzgnEgEPHr8kGwGxqzfgh6EJv+dWVNWSwd+V7UDv5F/zCxhwezEmLokEQsj8SHzifO33XGfbW5wXHkUmffDTN5JJEVABvheyOyef7BVWVl/0e657eBLj4pPJpD92dpDAD7iA/sFxrLvURFL1Dc3/Z7w/6dm5hWTSK07XkcEPuACOqqm9SgZ/6/Zc/PptWgQYM8Bvf9WLYYtWkMCPXJ6IfQPj5A9I2Q4YHvuBCUlpJPDnhC7DO/fbgnIPZQU4Cg6TjZ5jZdVBu4eSAuobmsngp6Zl4Zj3twgwZoDf2eXGhUvjSOAvsa/Brp7PQX1MSnXAqGcKN6ZkkL3+680Pg34npQQUl5SRwT9YcpLlTsoIaL71lCxXSEregiPjP0WAMQP87r4vaI9aSwI/fHEsdrwZZHtYpu+AcWMa09L3kI2ey1dbWO9negGlhNFi3oFi9vuZWsA9haJF7QS4FIsWtRLgUTBa1EpAhYLRojYCnIpGi1oIcCscLWohIGdfkbLRovICahSPFpUW0K5BtKisgGHiaPH2/efskE0twKFJtKikgHqNokXlBOgWLRoqCdAxWjRUEqBjtGioIkDXaNFQQYDO0aJhdgG6R4uG2QXoHi0aZhZghWjRMKsAq0SLhhkFWClaNMwowPcNngp+dm6h32jR93GP6m9Sl67c+P9jQgkBXNFiftERMunllRfU6ACuaLGx6S4Z/PSMHJJQx6ZLtNjZ5cZFEatIzlwWk4C9rjGSSWHTIVoc9UxhcmomyZm+zyY3W5+QwA+4AK5o8dCRU2TSjx6vIoMfUAFc0WLL7WdkH/dSNmfhqPeXGgI4osX3/SNkH/d8oc6790Ok8AMqQApFgKHgQ5AOABGA3BCkA4AfhIwgsGbJDgARgNwQpAOAH4SMILBmyQ4AEYDcEKQDgB+EjCCwZskOABGA3BCkA4AfhIwgsGbJDgARgNwQpAOAH4SMILBmyQ4AXgH/AMvBP/9d4TDfAAAAAElFTkSuQmCC",
      "iflow": "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",
      "comate": "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",
      "cline": "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",
      "kilo": "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAACXBIWXMAAAsTAAALEwEAmpwYAAADTUlEQVR4nO2cTWuTQRSF+xsGiqURTGNLsYmmQhelNrSmqRVXppjUjC78wFbFj1Wp3VqhZCn+AHGhUlwIbsSfIIobQQipVTcX5ldcGbHBN5mE9ytOkjmLswmTRc7z3nvunaQdUiQZktY8GIL50uoDCAAEAGzbBFQA2TcCLYjcFDKAAIBtm4AKIPtGoAWRm0IGEACwbRNQAWTfCLQgclPIAAIAtm0CKoDsG4EWRG4qtgwQQjglBQACAFABEi1IoAWZM2C1OMlPdmYHQqvFyf7LgOrunPUJQ8Uk/VkAgAAAFSDQghgtCBnACGFCCGMKIoyhjDE04h5Q3Z1jWZlqaPvRTOhz+rV/zxzq7p1p/nWwhj3AZKysTHmg5c+mQp/Tr7W7lji3PM4/9sNDGNhFTP4nAFEhAEAlOgCtB/emAaBbFXDzxknOzSc9Gh0d9rzv+rUMAHQyNpUaMQap1ovn+YbevT3vy8j5M0kACJIBooO2Ns0TEgDEGMIiZgiogJgBiIAQACAggERiuCVItcaSRzzndh7PAkCv7QHbhk04ecwLLpNJtJzxu7FjERPR9wCTNAQAEN3fhAGgyy0oDwDBM2Brc8YTtnqbDXvOtAn7kZ+pamAzQPWJAIAAABUg0IIYLaiHQ1ghA+xuwqpJb/aWOZs9apSG+OVTESEsuwhAf2/QaQFLpxP8+eNFt6cgaRFAEAjOA6j6/PlKUABaV6+kAUAEeLLb6fXLAj97mmtI/2HF7Y1siyYmRnAZF6W1qDZaynsv4yqXzbeczXdGuA0VANDzIaxQAQAgXP5OONck0yaMDAgBYP3WqVDfYplaVTMADdO0Be+9KvyZ/Q/17esld8fQg3qZC0vHYwFQLp3w9d4P7y8E/mwDC0CR5J/f13hlZTwygP1amRcXxwAgKAD1txI21rNtfxfarHabcL1W4oWFzhBQAV1WvVbih/dPG7dgLb8XcM60INUHAgACAFSAQAtitCBkACOECSGMKUj0wRiKf1km7QIYdKler4BBlwIAAQCoANk7LQiSAKD68EFABRAAsG0TUAFk3wi0IHJTyAACALZtAiqA7BuBFkRuChlAAMC2TUAFkH0j0ILITSEDCADYtgmoALJvBFoQ2TfDhn4DKtkefXpmRNQAAAAASUVORK5CYII=",
    ]
    var out: [String: UIImage] = [:]
    for (key, b64) in raw {
      if let data = Data(base64Encoded: b64), let image = UIImage(data: data, scale: 3.0) {
        out[key] = image
      }
    }
    return out
  }()

  public var iconImage: UIImage? {
    Self.icons[id]
  }
}

public struct WatchAgentBadge: View {
  public let agent: WatchAgent
  public var size: CGFloat = 24

  public init(agent: WatchAgent, size: CGFloat = 24) {
    self.agent = agent
    self.size = size
  }

  public var body: some View {
    let cornerRadius = size * 0.26
    Group {
      if let uiImage = agent.iconImage {
        let needsLightPlate = agent.id == "copilot" || agent.id == "opencode"
        Image(uiImage: uiImage)
          .resizable()
          .interpolation(.high)
          .aspectRatio(contentMode: .fill)
          .frame(width: size, height: size)
          .background(needsLightPlate ? Color(white: 0.94) : Color(white: 0.16))
          .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
              .strokeBorder(Color.white.opacity(0.14), lineWidth: 0.5)
          )
      } else if agent.id == "terminal" {
        ZStack {
          RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(Color(white: 0.16))
          RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .strokeBorder(Color.white.opacity(0.14), lineWidth: 0.5)
          Image(systemName: "terminal.fill")
            .font(.system(size: size * 0.44, weight: .semibold))
            // The phone's terminal tile draws its prompt in this green too.
            .foregroundColor(WatchPalette.diffAdd)
        }
        .frame(width: size, height: size)
      } else {
        ZStack {
          RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(Color(white: 0.18))
          RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .strokeBorder(Color.white.opacity(0.14), lineWidth: 0.5)
          Text(String(agent.name.prefix(1)).uppercased())
            .font(.system(size: size * 0.46, weight: .bold))
            .foregroundColor(.white)
        }
        .frame(width: size, height: size)
      }
    }
  }
}

/// The phone's colours in dark mode (`src/theme/brand-colors.json`), so a state reads the same
/// on the wrist as in the app; the Watch is always dark. `accentFill` and `waitingFill` sit
/// behind white text, which the paler `accent` and `waiting` can't carry.
/// `apps/web/test/brand-colors.test.ts` checks that these copies match the JSON.
public enum WatchPalette {
  public static let accent = Color(red: 0x8d / 255, green: 0x9b / 255, blue: 0xff / 255)
  public static let accentFill = Color(red: 0x52 / 255, green: 0x63 / 255, blue: 0xe8 / 255)
  public static let waiting = Color(red: 1, green: 0xad / 255, blue: 0x5c / 255)
  public static let waitingFill = Color(red: 0xb2 / 255, green: 0x56 / 255, blue: 0)
  public static let ok = Color(red: 0x4c / 255, green: 0xc3 / 255, blue: 0x8a / 255)
  public static let danger = Color(red: 1, green: 0x7b / 255, blue: 0x72 / 255)
  public static let diffAdd = Color(red: 0x7f / 255, green: 0xdd / 255, blue: 0xb4 / 255)
  public static let diffDel = Color(red: 1, green: 0x9a / 255, blue: 0x9a / 255)
}

public enum WatchPhaseStyle {
  public static func label(for phase: String) -> String {
    switch phase {
    case "waiting_for_approval": return "等你确认"
    case "waiting_for_input": return "等你回答"
    case "failed": return "出错"
    case "running": return "运行中"
    case "starting": return "启动中"
    case "completed": return "空闲"
    default: return "离线"
    }
  }

  public static func symbol(for phase: String) -> String {
    switch phase {
    case "waiting_for_approval": return "hand.raised.fill"
    case "waiting_for_input": return "questionmark.bubble.fill"
    case "failed": return "exclamationmark.triangle.fill"
    case "running": return "waveform"
    case "starting": return "sparkles"
    case "completed": return "checkmark.circle.fill"
    default: return "wifi.slash"
    }
  }

  public static func color(for phase: String) -> Color {
    switch phase {
    case "waiting_for_approval", "waiting_for_input":
      return WatchPalette.waiting
    case "failed":
      return WatchPalette.danger
    case "running", "starting":
      return WatchPalette.accent
    default:
      // Idle and done are the resting state: grey, as offline is.
      return Color.white.opacity(0.45)
    }
  }
}
