import Foundation
import IOKit.pwr_mgt

/// One viewer's hold on the display: while anyone holds it the display does not go to sleep for
/// want of someone at the Mac, and taking it wakes a display that had. A viewer of a sleeping
/// display sees black and can do nothing about it.
///
/// What it can't do: unlock a locked screen (the viewer sees the login window), or wake a
/// display that isn't there (a closed lid with no other display).
final class Awake {
  private static let lock = NSLock()
  private static var holds = 0
  private static var noSleep = IOPMAssertionID(kIOPMNullAssertionID)
  private static var activity = IOPMAssertionID(kIOPMNullAssertionID)
  /// As `pmset -g assertions` shows it.
  private static let reason = "LinkShell: this screen is being watched from another device" as CFString

  init() {
    Awake.lock.withLock {
      Awake.holds += 1
      if Awake.holds == 1 {
        IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), Awake.reason, &Awake.noSleep)
      }
      // As a touch of the keyboard does: a sleeping display wakes. The same assertion each time,
      // as the system asks.
      IOPMAssertionDeclareUserActivity(Awake.reason, kIOPMUserActiveLocal, &Awake.activity)
    }
  }

  /// The last hold gone, the display sleeps when the user's own settings say. (A process that
  /// ends takes its assertions with it: nothing to do on the way out.)
  deinit {
    Awake.lock.withLock {
      Awake.holds -= 1
      guard Awake.holds == 0 else { return }
      for assertion in [Awake.noSleep, Awake.activity] where assertion != IOPMAssertionID(kIOPMNullAssertionID) {
        IOPMAssertionRelease(assertion)
      }
      Awake.noSleep = IOPMAssertionID(kIOPMNullAssertionID)
      Awake.activity = IOPMAssertionID(kIOPMNullAssertionID)
    }
  }
}
