import Foundation
import React

@objc(ActionBridgeModule)
class ActionBridgeModule: RCTEventEmitter {

    private var hasListeners = false
    private static var darwinRegistered = false

    override init() {
        super.init()
        registerDarwinObserver()
    }

    @objc override static func requiresMainQueueSetup() -> Bool { return true }

    override func supportedEvents() -> [String]! {
        return ["onQuickAction"]
    }

    override func startObserving() {
        hasListeners = true
        // Check for queued actions on start
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.processPendingActions()
        }
    }

    override func stopObserving() {
        hasListeners = false
    }

    @objc func checkPendingActions(_ resolve: @escaping RCTPromiseResolveBlock,
                                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        processPendingActions()
        resolve(true)
    }

    // MARK: - Darwin Notification

    private func registerDarwinObserver() {
        guard !ActionBridgeModule.darwinRegistered else { return }
        ActionBridgeModule.darwinRegistered = true

        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterAddObserver(
            center,
            observer,
            { (_, observer, _, _, _) in
                guard let observer = observer else { return }
                let module = Unmanaged<ActionBridgeModule>.fromOpaque(observer).takeUnretainedValue()
                DispatchQueue.main.async {
                    module.processPendingActions()
                }
            },
            "com.bd.linkshell.quickAction" as CFString,
            nil,
            .deliverImmediately
        )
    }

    // MARK: - Process Queue

    private func processPendingActions() {
        guard hasListeners else { return }

        let defaults = UserDefaults(suiteName: "group.com.bd.linkshell")
        guard let queue = defaults?.array(forKey: "pendingActions") as? [[String: String]], !queue.isEmpty else {
            return
        }

        // Clear queue first to avoid double-processing
        defaults?.removeObject(forKey: "pendingActions")
        defaults?.synchronize()

        for action in queue {
            guard let sessionId = action["sessionId"],
                  let terminalId = action["terminalId"],
                  let input = action["input"] else { continue }

            sendEvent(withName: "onQuickAction", body: [
                "sessionId": sessionId,
                "terminalId": terminalId,
                "input": input,
                "requestId": action["requestId"] ?? "",
            ])
        }
    }
}
