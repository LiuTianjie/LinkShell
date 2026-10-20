import SwiftUI
import CoreImage.CIFilterBuiltins

private struct DesktopPairingOffer: Decodable {
  let code: String
  let link: String
  let gateway: String
  let expiresAt: Double
}

struct DesktopPairingView: View {
  @ObservedObject var model: DesktopModel
  @State private var offer: DesktopPairingOffer?
  @State private var loading = false
  @State private var error: String?
  @State private var initialDevices: Set<String> = []
  @State private var paired = false
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 14) {
        Image(systemName: "qrcode.viewfinder").font(.system(size: 24)).foregroundStyle(DesktopStyle.accent)
        VStack(alignment: .leading, spacing: 4) {
          Text("连接你的手机").font(.system(size: 15, weight: .semibold))
          Text("扫描二维码或输入配对码，添加这台 Mac").font(.system(size: 12)).foregroundStyle(DesktopStyle.secondary)
        }
        Spacer()
        if offer == nil {
          Button("配对新设备") { Task { await start() } }
            .buttonStyle(.borderedProminent).tint(DesktopStyle.accent).foregroundStyle(DesktopStyle.onAccent)
            .disabled(loading || model.preview)
        } else {
          Button("重新生成") { Task { await start() } }.disabled(loading || model.preview)
        }
      }
      if loading { ProgressView("正在生成安全配对码…") }
      if paired { Label("设备已配对", systemImage: "checkmark.circle.fill").foregroundStyle(DesktopStyle.mint) }
      if let error { Text(error).font(.system(size: 12)).foregroundStyle(.orange) }
      if let offer {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          let remaining = max(0, Int(offer.expiresAt / 1000 - context.date.timeIntervalSince1970))
          HStack(spacing: 24) {
            if remaining > 0, let image = qr(offer.link) {
              Image(nsImage: image).interpolation(.none).resizable().frame(width: 136, height: 136).padding(10).background(.white).clipShape(RoundedRectangle(cornerRadius: 10)).accessibilityLabel("设备配对二维码")
            } else { Image(systemName: "clock.badge.exclamationmark").font(.largeTitle).frame(width: 156, height: 156).foregroundStyle(DesktopStyle.secondary) }
            VStack(alignment: .leading, spacing: 10) {
              Text(remaining > 0 ? "在 LinkShell 手机端扫描" : "配对码已过期").font(.system(size: 14, weight: .medium))
              if remaining > 0 {
                Text("也可以输入配对码").font(.system(size: 11)).foregroundStyle(DesktopStyle.secondary)
                Text(offer.code).font(.system(size: 28, weight: .semibold, design: .monospaced)).tracking(4).textSelection(.enabled)
                Text(String(format: "%02d:%02d 后失效 · 请勿分享给他人", remaining / 60, remaining % 60)).font(.system(size: 11)).foregroundStyle(DesktopStyle.secondary)
              } else { Text("点击「重新生成」继续添加设备。").font(.footnote).foregroundStyle(DesktopStyle.secondary) }
              Text(offer.gateway).font(.system(size: 11)).foregroundStyle(DesktopStyle.secondary).textSelection(.enabled)
            }
          }
        }
      } else if !paired {
        Text("同账号登录可自动发现；设备配对独立于账号。免登录配对需连接自建网关，官方网关需要 Pro 账号。").font(.system(size: 11.5)).foregroundStyle(DesktopStyle.secondary)
      }
    }.padding(18)
      .background(RoundedRectangle(cornerRadius: 12).fill(DesktopStyle.card))
      .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(DesktopStyle.line, lineWidth: 1) }
      .task {
        if model.preview {
          offer = DesktopPairingOffer(code: "000000", link: "https://example.invalid/linkshell-design-preview", gateway: "设计预览 · 示例二维码，不可用于配对", expiresAt: Date().timeIntervalSince1970 * 1000 + 600_000)
        }
      }
      .onChange(of: model.devices.map(\.id)) { devices in
        if offer != nil, !Set(devices).subtracting(initialDevices).isEmpty { offer = nil; paired = true }
      }
  }
  private func qr(_ text: String) -> NSImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage, let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
    return NSImage(cgImage: cg, size: NSSize(width: output.extent.width, height: output.extent.height))
  }
  private func start() async {
    loading = true; error = nil; paired = false; offer = nil
    initialDevices = Set(model.devices.map(\.id))
    do {
      let data = try await Task.detached { try DesktopCommand.run(["desktop", "--action", "pair"], timeout: 30) }.value
      offer = try JSONDecoder().decode(DesktopPairingOffer.self, from: data)
    } catch { self.error = error.localizedDescription }
    loading = false
  }
}
