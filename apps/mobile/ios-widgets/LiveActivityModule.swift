import Foundation
import ActivityKit
import React

@available(iOS 16.2, *)
@objc(LiveActivityModule)
class LiveActivityModule: NSObject {

    private var activityId: String? = nil
    private var startTime: Date? = nil
    private var activityGeneration: Int = 0

    // MARK: - Start

    @objc
    func startActivity(_ stateJson: String,
                       extendedJson: String,
                       resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            reject("NOT_AVAILABLE", "Live Activities are not enabled", nil)
            return
        }

        guard let state = decodeState(stateJson) else {
            reject("DECODE_FAILED", "Failed to decode state JSON", nil)
            return
        }

        writeExtendedData(extendedJson)
        activityGeneration += 1
        let generation = activityGeneration
        let staleActivities = Activity<LinkShellAttributes>.activities

        // End any stale activities before starting a new one
        Task {
            for activity in staleActivities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }

            guard generation == self.activityGeneration else {
                resolve("")
                return
            }

            let attributes = LinkShellAttributes(startedAt: Date())
            do {
                let content = ActivityContent(state: state, staleDate: nil)
                let activity = try Activity.request(
                    attributes: attributes,
                    content: content,
                    pushType: nil
                )
                guard generation == self.activityGeneration else {
                    await activity.end(nil, dismissalPolicy: .immediate)
                    resolve("")
                    return
                }
                self.activityId = activity.id
                self.startTime = Date()
                resolve(activity.id)
            } catch {
                reject("START_FAILED", error.localizedDescription, error)
            }
        }
    }

    // MARK: - Update

    @objc
    func updateActivity(_ stateJson: String,
                        extendedJson: String,
                        alert: Bool,
                        resolver resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let aid = activityId else {
            reject("NOT_FOUND", "No active Live Activity", nil)
            return
        }

        guard let state = decodeState(stateJson) else {
            reject("DECODE_FAILED", "Failed to decode state JSON", nil)
            return
        }

        writeExtendedData(extendedJson)

        Task {
            for activity in Activity<LinkShellAttributes>.activities {
                if activity.id == aid {
                    let content = ActivityContent(state: state, staleDate: nil)
                    if alert {
                        await activity.update(
                            content,
                            alertConfiguration: AlertConfiguration(
                                title: "Agent 需要操作",
                                body: "有新的权限请求等待处理",
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
        activityGeneration += 1
        let targetActivityId = activityId
        let activitiesToEnd = Activity<LinkShellAttributes>.activities.filter { activity in
            targetActivityId == nil || activity.id == targetActivityId
        }

        activityId = nil
        startTime = nil

        LiveActivityStore.defaults?.removeObject(forKey: LiveActivityStore.extendedDataKey)
        LiveActivityStore.defaults?.synchronize()

        Task {
            var didEnd = false
            let finalState = LinkShellAttributes.ContentState(
                conversationId: "",
                sessionId: "",
                provider: "custom",
                project: "",
                status: "idle",
                phaseLabel: "",
                summary: "",
                hasPermission: false,
                permissionCount: 0,
                updatedAt: Date().timeIntervalSince1970 * 1000
            )
            let content = ActivityContent(state: finalState, staleDate: nil)
            for activity in activitiesToEnd {
                didEnd = true
                if targetActivityId == nil {
                    await activity.end(content, dismissalPolicy: .immediate)
                } else {
                    await activity.end(content, dismissalPolicy: .after(.now + 5))
                }
            }
            resolve(didEnd)
        }
    }

    // MARK: - Confirm Action

    @objc
    func confirmAction(_ requestId: String,
                       resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard var ext = LiveActivityStore.readExtendedData() else {
            NSLog("[LiveActivityAction] liveActivity confirm no extended data requestId=%@", requestId)
            resolve(false)
            return
        }

        if ext.permissionRequestId == requestId {
            NSLog("[LiveActivityAction] liveActivity confirm matched requestId=%@", requestId)
            ext.permissionTitle = ""
            ext.currentToolName = ""
            ext.currentToolInput = ""
            ext.permissionContext = ""
            ext.permissionRequestId = ""
            ext.permissionOptions = []
            LiveActivityStore.writeExtendedData(ext)
            Task {
                for activity in Activity<LinkShellAttributes>.activities {
                    var state = activity.content.state
                    state.status = "running"
                    state.phaseLabel = "运行中"
                    state.hasPermission = false
                    state.permissionCount = 0
                    state.updatedAt = Date().timeIntervalSince1970 * 1000
                    await activity.update(ActivityContent(state: state, staleDate: nil))
                }
                resolve(true)
            }
        } else {
            NSLog("[LiveActivityAction] liveActivity confirm mismatch requestId=%@ current=%@", requestId, ext.permissionRequestId)
            resolve(false)
        }
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

    private func decodeState(_ json: String) -> LinkShellAttributes.ContentState? {
        guard let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(LinkShellAttributes.ContentState.self, from: data)
    }

    private func writeExtendedData(_ json: String) {
        guard let defaults = LiveActivityStore.defaults else { return }
        defaults.set(json.data(using: .utf8), forKey: LiveActivityStore.extendedDataKey)
        defaults.synchronize()
    }
}
