import Foundation
import ActivityKit
import React

@available(iOS 16.2, *)
@objc(LiveActivityModule)
class LiveActivityModule: NSObject {

    private var activityId: String? = nil
    private var startTime: Date? = nil

    // MARK: - Start

    @objc
    func startActivity(_ snapshotsJson: String,
                       extendedJson: String,
                       activeSessionId: String,
                       focusedTid: String,
                       resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            reject("NOT_AVAILABLE", "Live Activities are not enabled", nil)
            return
        }

        guard let snapshots = decodeSnapshots(snapshotsJson) else {
            reject("DECODE_FAILED", "Failed to decode snapshots JSON", nil)
            return
        }

        // Write extended data to shared UserDefaults
        writeExtendedData(extendedJson)

        let attributes = LinkShellAttributes(startedAt: Date())
        let state = LinkShellAttributes.ContentState(
            terminals: snapshots,
            focusedSid: activeSessionId,
            focusedTid: focusedTid
        )

        do {
            let content = ActivityContent(state: state, staleDate: nil)
            let activity = try Activity.request(
                attributes: attributes,
                content: content,
                pushType: nil
            )
            activityId = activity.id
            startTime = Date()
            resolve(activity.id)
        } catch {
            reject("START_FAILED", error.localizedDescription, error)
        }
    }

    // MARK: - Update

    @objc
    func updateActivity(_ snapshotsJson: String,
                        extendedJson: String,
                        activeSessionId: String,
                        focusedTid: String,
                        alert: Bool,
                        resolver resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let aid = activityId else {
            reject("NOT_FOUND", "No active Live Activity", nil)
            return
        }

        guard let snapshots = decodeSnapshots(snapshotsJson) else {
            reject("DECODE_FAILED", "Failed to decode snapshots JSON", nil)
            return
        }

        // Write extended data to shared UserDefaults
        writeExtendedData(extendedJson)

        let state = LinkShellAttributes.ContentState(
            terminals: snapshots,
            focusedSid: activeSessionId,
            focusedTid: focusedTid
        )

        Task {
            for activity in Activity<LinkShellAttributes>.activities {
                if activity.id == aid {
                    let content = ActivityContent(state: state, staleDate: nil)
                    if alert {
                        await activity.update(
                            content,
                            alertConfiguration: AlertConfiguration(
                                title: "需要操作",
                                body: "终端等待输入",
                                sound: .default
                            )
                        )
                    } else {
                        await activity.update(content)
                    }
                    resolve(true)
                    return
                }
            }
            reject("NOT_FOUND", "Activity not found", nil)
        }
    }

    // MARK: - End

    @objc
    func endActivity(_ resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let aid = activityId else {
            resolve(false)
            return
        }

        activityId = nil
        startTime = nil

        // Clear extended data
        LiveActivityStore.defaults?.removeObject(forKey: LiveActivityStore.extendedDataKey)
        LiveActivityStore.defaults?.synchronize()

        Task {
            for activity in Activity<LinkShellAttributes>.activities {
                if activity.id == aid {
                    let finalState = LinkShellAttributes.ContentState(
                        terminals: [],
                        focusedSid: "",
                        focusedTid: ""
                    )
                    let content = ActivityContent(state: finalState, staleDate: nil)
                    await activity.end(content, dismissalPolicy: .after(.now + 5))
                    resolve(true)
                    return
                }
            }
            resolve(false)
        }
    }

    // MARK: - Confirm Action (clear permission from widget)

    @objc
    func confirmAction(_ requestId: String,
                       resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
        var extendedMap = LiveActivityStore.readExtendedData()
        var changed = false

        for (sid, var data) in extendedMap {
            if data.permissionRequestId == requestId {
                data.permissionTool = ""
                data.permissionContext = ""
                data.permissionRequestId = ""
                data.quickActions = []
                extendedMap[sid] = data
                changed = true
                break
            }
        }

        if changed {
            LiveActivityStore.writeExtendedData(Array(extendedMap.values))
        }

        resolve(changed)
    }

    // MARK: - Availability

    @objc
    func isAvailable(_ resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        if #available(iOS 16.2, *) {
            resolve(ActivityAuthorizationInfo().areActivitiesEnabled)
        } else {
            resolve(false)
        }
    }

    @objc static func requiresMainQueueSetup() -> Bool { return false }

    // MARK: - Helpers

    private func decodeSnapshots(_ json: String) -> [TerminalSnapshot]? {
        guard let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode([TerminalSnapshot].self, from: data)
    }

    private func writeExtendedData(_ json: String) {
        guard let defaults = LiveActivityStore.defaults else { return }
        // Store raw JSON directly — widget will decode
        defaults.set(json.data(using: .utf8), forKey: LiveActivityStore.extendedDataKey)
        defaults.synchronize()
    }
}
