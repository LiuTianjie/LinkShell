import Foundation
private final class GhosttyBundleToken {}
extension Bundle {
 static let ghosttyResources: Bundle = {
  let owner = Bundle(for: GhosttyBundleToken.self)
  let url = owner.url(forResource: "LinkGhosttyResources", withExtension: "bundle") ?? Bundle.main.url(forResource: "LinkGhosttyResources", withExtension: "bundle")
  return url.flatMap(Bundle.init(url:)) ?? owner
 }()
}
