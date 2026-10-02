// swift-tools-version:5.9
// LinkShell.app: the Mac side of the screen. Built and signed by scripts/build-app.mjs.

import PackageDescription

let package = Package(
  name: "LinkShell",
  // 13.0 is what the WebRTC binary itself was built for (LC_BUILD_VERSION minos 13.0).
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(
      name: "LinkShell",
      dependencies: ["WebRTC"],
      path: "Sources/LinkShell",
      linkerSettings: [
        // Where the framework is inside the app: Contents/Frameworks.
        .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"]),
      ]
    ),
    // What can be proved with no screen and no network (`swift test`, part of `pnpm check`).
    .testTarget(name: "LinkShellTests", dependencies: ["LinkShell"], path: "Tests/LinkShellTests"),
    // libwebrtc, prebuilt from the unmodified upstream source (M154, branch-heads/8037):
    // a dynamic framework with arm64 and x86_64 slices for macOS, of which the app keeps arm64.
    .binaryTarget(
      name: "WebRTC",
      url: "https://github.com/stasel/WebRTC/releases/download/154.0.0/WebRTC-M154.xcframework.zip",
      checksum: "a2bcdda93578c82452ceb6e49d54a2746e1bcb4caf7c2fa601ffac8028b58c16"
    ),
  ]
)
