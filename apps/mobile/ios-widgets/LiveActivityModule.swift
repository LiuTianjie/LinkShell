import Foundation
import ActivityKit
import React

@available(iOS 16.2, *)
@objc(LiveActivityModule)
class LiveActivityModule: NSObject {

    private var activityId: String? = nil
    private var startTime: Date? = nil

    @objc
    func startActivity(_ sessionsJson: String,
                       activeSessionId: String,
                       resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            reject("NOT_AVAILABLE", "Live Activities are not enabled", nil)
            return
        }

        guard let sessions = decodeSessions(sessionsJson) else {
            reject("DECODE_FAILED", "Failed to decode sessions JSON", nil)
            return
        }

        let attributes = LinkShellAttributes(startedAt: Date())
        let state = LinkShellAttributes.ContentState(
            sessions: sessions,
            activeSessionId: activeSessionId
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

    @objc
    func updateActivity(_ sessionsJson: String,
                        activeSessionId: String,
                        resolver resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let aid = activityId else {
            reject("NOT_FOUND", "No active Live Activity", nil)
            return
        }

        guard let sessions = decodeSessions(sessionsJson) else {
            reject("DECODE_FAILED", "Failed to decode sessions JSON", nil)
            return
        }

        let state = LinkShellAttributes.ContentState(
            sessions: sessions,
            activeSessionId: activeSessionId
        )

        Task {
            for activity in Activity<LinkShellAttributes>.activities {
                if activity.id == aid {
                    let content = ActivityContent(state: state, staleDate: nil)
                    await activity.update(content)
                    resolve(true)
                    return
                }
            }
            reject("NOT_FOUND", "Activity not found", nil)
        }
    }

    @objc
    func endActivity(_ resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let aid = activityId else {
            resolve(false)
            return
        }

        activityId = nil
        startTime = nil

        Task {
            for activity in Activity<LinkShellAttributes>.activities {
                if activity.id == aid {
                    let finalState = LinkShellAttributes.ContentState(
                        sessions: [],
                        activeSessionId: ""
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

    private func decodeSessions(_ json: String) -> [SessionState]? {
        guard let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode([SessionState].self, from: data)
    }
}
