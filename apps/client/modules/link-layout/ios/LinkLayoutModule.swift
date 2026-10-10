import ExpoModulesCore
import UIKit

public class LinkLayoutModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LinkLayout")
    Constants([
      "viewControllerStatusBarAppearance": Bundle.main.object(forInfoDictionaryKey: "UIViewControllerBasedStatusBarAppearance") as? Bool ?? true
    ])
    AsyncFunction("requestLandscape") { [weak self] in
      guard let scene = self?.appContext?.utilities?.currentViewController()?.view.window?.windowScene else { return }
      // Request the initial wide presentation without restricting later device rotations.
      scene.requestGeometryUpdate(.iOS(interfaceOrientations: .landscape))
    }.runOnQueue(.main)
    View(LinkLayoutView.self) {
      Events("onMetrics")
      Prop("revision") { (view: LinkLayoutView, revision: String) in view.updateRevision(revision) }
    }
  }
}

final class LinkLayoutView: ExpoView {
  let onMetrics = EventDispatcher()
  private var last: NSDictionary?
  private var revision = ""
  private var recheckScheduled = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    #if LINK_LAYOUT_RESERVED_REGIONS
    if #available(iOS 27.1, *) {
      addInteraction(UIHingeInteraction { [weak self] _, _ in self?.scheduleRecheck() })
    }
    #endif
  }

  func updateRevision(_ revision: String) {
    guard self.revision != revision else { return }
    self.revision = revision
    scheduleRecheck()
  }

  // UIKit can update reserved regions after the hinge notification's layout pass.
  private func scheduleRecheck() {
    setNeedsLayout()
    guard !recheckScheduled else { return }
    recheckScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.recheckScheduled = false
      self.setNeedsLayout()
      self.layoutIfNeeded()
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    fixWindowTypography()
    setNeedsLayout()
  }

  private func fixWindowTypography() {
    guard let window else { return }
    // Native navigation, tabs and presented menus must use the same fixed scale as RN text.
    // Set an explicit override even if the inherited category is currently already .large.
    if #available(iOS 17.0, *) {
      window.windowScene?.traitOverrides.preferredContentSizeCategory = .large
      window.traitOverrides.preferredContentSizeCategory = .large
    } else {
      window.minimumContentSizeCategory = .large
      window.maximumContentSizeCategory = .large
    }
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard window != nil, bounds.width > 0, bounds.height > 0 else { return }
    var divisions: [[String: Any]] = []
    var occlusions: [[String: Any]] = []
    #if LINK_LAYOUT_RESERVED_REGIONS
    if #available(iOS 27.1, *) {
      divisions = reservedRegions(kind: .division, options: [.includeInactive]).map { region in
        ["x": region.frame.minX, "y": region.frame.minY, "width": region.frame.width,
         "height": region.frame.height, "active": region.isActive]
      }
      occlusions = reservedRegions(kind: .occlusion).map { region in
        ["x": region.frame.minX, "y": region.frame.minY, "width": region.frame.width,
         "height": region.frame.height, "active": region.isActive]
      }
    }
    #endif
    let metrics: [String: Any] = [
      "revision": revision, "width": bounds.width, "height": bounds.height, "divisions": divisions, "occlusions": occlusions,
      "insets": ["top": safeAreaInsets.top, "right": safeAreaInsets.right,
                 "bottom": safeAreaInsets.bottom, "left": safeAreaInsets.left]
    ]
    let next = metrics as NSDictionary
    guard last == nil || !next.isEqual(last) else { return }
    last = next
    onMetrics(metrics)
  }
}
