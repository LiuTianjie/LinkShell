import AppKit
import SwiftUI

/** The same official mark and light/dark treatment as the mobile AgentTile. */
struct DesktopAgentMark: View {
  let agent: String
  var size: CGFloat = 22
  @Environment(\.colorScheme) private var scheme
  private static var images: [String: NSImage] = [:]
  private var image: NSImage? {
    let key = agent + (scheme == .dark ? "dark" : "light")
    if let cached = Self.images[key] { return cached }
    guard let encoded = DesktopAgentAssets.png[key], let data = Data(base64Encoded: encoded), let image = NSImage(data: data) else { return nil }
    Self.images[key] = image
    return image
  }
  var body: some View {
    Group {
      if let image { Image(nsImage: image).resizable().scaledToFit() }
      else {
        ZStack {
          DesktopStyle.selection
          Text(String(agent.prefix(1)).uppercased()).font(.system(size: size * 0.5, weight: .semibold))
        }
      }
    }.frame(width: size, height: size).clipShape(RoundedRectangle(cornerRadius: size * 0.24))
      .accessibilityHidden(true)
  }
}
