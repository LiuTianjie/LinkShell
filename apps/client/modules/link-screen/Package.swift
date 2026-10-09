// swift-tools-version:5.9
import PackageDescription

// The scheduling primitives can be checked without a phone, GPU, WebRTC or Expo.
let package = Package(name: "ScreenTiming", targets: [
  .target(name: "ScreenTiming", path: "ios/Core"),
  .testTarget(name: "ScreenTimingTests", dependencies: ["ScreenTiming"], path: "Tests"),
])
