/// The window's full screen for the native remote screen. AppKit ignores a toggle while the
/// window is still animating in or out, so the page's latest wish is kept and applied when the
/// animation ends: a click or Esc during it is never lost, and the window never ends up full
/// screen behind a page that left it (or the other way round).
struct ScreenFullScreen: Equatable {
  enum Action: Equatable {
    /// Toggle the window's full screen.
    case toggle
    /// Tell the page whether it shows only the picture.
    case report(Bool)
  }

  /// What the page asked for last.
  private(set) var wanted = false
  /// The window went full screen for the screen (not by the user's own ⌃⌘F), so leaving the
  /// screen takes it back out.
  private(set) var owned = false
  /// A full screen animation is running; nothing is toggled until it ends.
  private(set) var moving = false
  /// The running animation is one this asked for, not the user's green button or ⌃⌘F.
  private var ours = false
  /// A toggle was made and AppKit hasn't started its animation yet.
  private(set) var awaitingStart = false
  /// Toggles in a row that AppKit didn't start an animation for.
  private var unanswered = 0
  /// After this many, the window is taken as it is instead of trying again.
  static let attempts = 3

  /// The page asks to show only the picture, or to stop.
  mutating func request(_ enabled: Bool, isFull: Bool, visible: Bool) -> [Action] {
    wanted = enabled
    return reconcile(isFull: isFull, visible: visible)
  }

  /// An animation started, whoever asked for it.
  mutating func willMove() { moving = true; awaitingStart = false; unanswered = 0 }

  /// A toggle this asked for started no animation (AppKit drops one made while it is still
  /// finishing the previous): try again, a few times, then take the window as it is.
  mutating func toggleUnanswered(isFull: Bool, visible: Bool) -> [Action] {
    guard awaitingStart else { return [] }
    moving = false; ours = false; awaitingStart = false
    unanswered += 1
    if unanswered >= Self.attempts {
      unanswered = 0
      if !isFull { owned = false }
      wanted = wanted && isFull
      return [.report(wanted)]
    }
    return reconcile(isFull: isFull, visible: visible)
  }

  /// The window finished going full screen.
  mutating func entered(visible: Bool) -> [Action] {
    moving = false; ours = false; awaitingStart = false
    return reconcile(isFull: true, visible: visible)
  }

  /// The window finished leaving full screen.
  mutating func exited(visible: Bool) -> [Action] {
    let requested = ours
    moving = false; ours = false; awaitingStart = false; owned = false
    // The green button or ⌃⌘F ended it: the picture leaves with it.
    if !requested { wanted = false }
    return reconcile(isFull: false, visible: visible)
  }

  /// AppKit gave up on the animation: take the window as it is.
  mutating func failed(isFull: Bool) -> [Action] {
    moving = false; ours = false; awaitingStart = false
    if !isFull { owned = false }
    wanted = wanted && isFull
    return [.report(wanted)]
  }

  private mutating func reconcile(isFull: Bool, visible: Bool) -> [Action] {
    if moving { return [] }
    if wanted {
      guard visible else { wanted = false; return reconcile(isFull: isFull, visible: visible) }
      // Already full screen (the user's own ⌃⌘F included): show the picture there.
      if isFull { return [.report(true)] }
      owned = true; moving = true; ours = true; awaitingStart = true
      return [.toggle]
    }
    if isFull && owned {
      moving = true; ours = true; awaitingStart = true
      return [.toggle]
    }
    if !isFull { owned = false }
    return [.report(false)]
  }
}
