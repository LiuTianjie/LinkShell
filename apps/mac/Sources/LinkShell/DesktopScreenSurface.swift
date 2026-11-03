import AppKit
import CoreVideo
import WebRTC
@_exported import LinkShellScreen

protocol DesktopScreenOutput: RTCVideoRenderer {
  var onInput: (([String: Any], Bool) -> Void)? { get set }
  var onFirstFrame: (() -> Void)? { get set }
  var onFailure: ((String) -> Void)? { get set }
  var controlEnabled: Bool { get set }
  var physicalKeys: Bool { get set }
  func updateCursor(_ message: [String: Any])
  func stop()
}

extension DesktopScreenSurface: DesktopScreenOutput {
  public func setSize(_ size: CGSize) {}
  public func renderFrame(_ frame: RTCVideoFrame?) {
    guard let frame, let picture = desktopPicture(frame) else { return }
    receive(picture)
  }
}

func desktopPicture(_ frame: RTCVideoFrame, release: @escaping () -> Void = {}) -> DesktopScreenFrame? {
  guard let buffer = frame.buffer as? RTCCVPixelBuffer else { return nil }
  return DesktopScreenFrame(buffer: buffer.pixelBuffer, width: Int(frame.width), height: Int(frame.height),
    rotation: Int(frame.rotation.rawValue), crop: CGRect(x: Int(buffer.cropX), y: Int(buffer.cropY),
      width: Int(buffer.cropWidth), height: Int(buffer.cropHeight)), release: release)
}
