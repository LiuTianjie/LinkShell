import CoreVideo
import Metal
import MetalKit
import QuartzCore
import UIKit
import WebRTC

private struct ScreenPicture {
  let frame: RTCVideoFrame
  let buffer: CVPixelBuffer
  let timestamp: UInt32
}

/// A display-synchronised mailbox, not a playback FIFO. Decode keeps running on WebRTC's
/// thread while one GPU submission is in flight; the next display opportunity takes the newest
/// decoded picture. Reference-frame ordering stays entirely inside WebRTC/VideoToolbox.
final class ScreenMetalView: UIView, RTCVideoRenderer {
  override class var layerClass: AnyClass { CAMetalLayer.self }
  let metrics: ScreenMetrics
  var onFailure: ((String) -> Void)?
  var onPicture: ((CGSize) -> Void)?
  var pointer = CGPoint(x: 0.5, y: 0.5) { didSet { dirty = true } }
  var showsPointer = true { didSet { dirty = true } }
  var zoom: CGFloat = 1 { didSet { dirty = true } }
  var pan = CGPoint.zero { didSet { dirty = true } }
  var externalContentRect: CGRect? { didSet { dirty = true } }
  private(set) var pictureSize = CGSize(width: 16, height: 9)
  private(set) var requestedFps = 60
  private let mailbox = ScreenMailbox<ScreenPicture>()
  private let inFlight = DispatchSemaphore(value: 1)
  private let timingLock = NSLock()
  private var gpuSeconds = 0.0005
  private var current: ScreenPicture?
  private var submittedTimestamp: UInt32?
  private var dirty = true
  private var reportedFrame = false
  private var reportedSize = CGSize.zero
  private var reportedFailure = false
  private var queue: MTLCommandQueue?
  private var yuvPipeline: MTLRenderPipelineState?
  private var rgbaPipeline: MTLRenderPipelineState?
  private var cache: CVMetalTextureCache?
  private var cursorTexture: MTLTexture?
  private var cursorSize = CGSize(width: 18, height: 26)
  private var cursorHotspot = CGPoint.zero
  private var driver: ScreenDisplayDriver?
  private var metalLink: AnyObject?
  private var legacyLink: CADisplayLink?

  init(metrics: ScreenMetrics) {
    self.metrics = metrics
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    clipsToBounds = true
    backgroundColor = .black
    configureMetal()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private func configureMetal() {
    guard let device = MTLCreateSystemDefaultDevice() else { return fail("这台设备无法使用原生屏幕渲染") }
    let surface = layer as! CAMetalLayer
    surface.device = device
    surface.pixelFormat = .bgra8Unorm
    surface.framebufferOnly = true
    surface.maximumDrawableCount = 2
    surface.presentsWithTransaction = false
    surface.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
    queue = device.makeCommandQueue()
    CVMetalTextureCacheCreate(nil, nil, device, nil, &cache)
    do {
      let library = try device.makeLibrary(source: Self.shader, options: nil)
      func pipeline(_ fragment: String, blend: Bool) throws -> MTLRenderPipelineState {
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = library.makeFunction(name: "screenVertex")
        descriptor.fragmentFunction = library.makeFunction(name: fragment)
        descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
        if blend {
          let attachment = descriptor.colorAttachments[0]!
          attachment.isBlendingEnabled = true
          attachment.sourceRGBBlendFactor = .one
          attachment.destinationRGBBlendFactor = .oneMinusSourceAlpha
          attachment.sourceAlphaBlendFactor = .one
          attachment.destinationAlphaBlendFactor = .oneMinusSourceAlpha
        }
        return try device.makeRenderPipelineState(descriptor: descriptor)
      }
      yuvPipeline = try pipeline("screenYUV", blend: false)
      rgbaPipeline = try pipeline("screenRGBA", blend: true)
      let image = UIGraphicsImageRenderer(size: cursorSize).image { context in
        let path = UIBezierPath()
        path.move(to: CGPoint(x: 1, y: 1)); path.addLine(to: CGPoint(x: 1, y: 21))
        path.addLine(to: CGPoint(x: 6, y: 17)); path.addLine(to: CGPoint(x: 10, y: 25))
        path.addLine(to: CGPoint(x: 14, y: 23)); path.addLine(to: CGPoint(x: 10, y: 15))
        path.addLine(to: CGPoint(x: 17, y: 15)); path.close()
        UIColor.white.setFill(); path.fill()
        UIColor.black.setStroke(); path.lineWidth = 1; path.stroke()
      }
      setCursor(image, size: cursorSize, hotspot: .zero)
    } catch { fail("原生屏幕渲染初始化失败") }
  }

  func setCursor(_ image: UIImage, size: CGSize, hotspot: CGPoint) {
    guard let device = (layer as? CAMetalLayer)?.device, let cg = image.cgImage else { return }
    cursorTexture = try? MTKTextureLoader(device: device).newTexture(cgImage: cg, options: [.SRGB: false])
    cursorSize = size; cursorHotspot = hotspot; dirty = true
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let scale = window?.screen.scale ?? UIScreen.main.scale
    let surface = layer as! CAMetalLayer
    surface.contentsScale = scale
    surface.drawableSize = CGSize(width: max(1, bounds.width * scale), height: max(1, bounds.height * scale))
    dirty = true
  }

  var contentRect: CGRect {
    if let externalContentRect { return externalContentRect }
    let fit = min(bounds.width / max(1, pictureSize.width), bounds.height / max(1, pictureSize.height))
    let size = CGSize(width: pictureSize.width * fit * zoom, height: pictureSize.height * fit * zoom)
    return CGRect(x: (bounds.width - size.width) / 2 + pan.x, y: (bounds.height - size.height) / 2 + pan.y, width: size.width, height: size.height)
  }

  func start(fps: Int) {
    stopDisplayLink()
    requestedFps = min(fps, window?.screen.maximumFramesPerSecond ?? UIScreen.main.maximumFramesPerSecond)
    let driver = ScreenDisplayDriver(view: self)
    self.driver = driver
    let range = CAFrameRateRange(minimum: Float(min(60, requestedFps)), maximum: Float(requestedFps), preferred: Float(requestedFps))
    if #available(iOS 17.0, *) {
      let link = CAMetalDisplayLink(metalLayer: layer as! CAMetalLayer)
      link.preferredFrameLatency = 1
      link.preferredFrameRateRange = range
      link.delegate = driver
      link.add(to: .main, forMode: .common)
      metalLink = link
    } else {
      let link = CADisplayLink(target: driver, selector: #selector(ScreenDisplayDriver.tick(_:)))
      link.preferredFrameRateRange = range
      link.add(to: .main, forMode: .common)
      legacyLink = link
    }
  }

  func stop() {
    stopDisplayLink()
    _ = mailbox.take()
    current = nil
    submittedTimestamp = nil
    reportedFrame = false
  }

  private func stopDisplayLink() {
    if #available(iOS 17.0, *) { (metalLink as? CAMetalDisplayLink)?.invalidate() }
    metalLink = nil
    legacyLink?.invalidate(); legacyLink = nil; driver = nil
  }

  deinit {
    if #available(iOS 17.0, *) { (metalLink as? CAMetalDisplayLink)?.invalidate() }
    legacyLink?.invalidate()
  }

  func setSize(_ size: CGSize) { /* The frame and its dimensions must be consumed together. */ }

  func renderFrame(_ frame: RTCVideoFrame?) {
    guard let frame else { return }
    guard let native = frame.buffer as? RTCCVPixelBuffer else {
      DispatchQueue.main.async { [weak self] in self?.fail("当前视频格式无法使用原生屏幕渲染") }
      return
    }
    mailbox.put(ScreenPicture(frame: frame, buffer: native.pixelBuffer, timestamp: UInt32(bitPattern: frame.timeStamp)))
  }

  func takeReplacements() -> Int { mailbox.takeReplacements() }

  fileprivate func draw(drawable supplied: CAMetalDrawable?, deadline: Double) {
    timingLock.lock(); let cost = gpuSeconds; timingLock.unlock()
    guard ScreenTiming.canSubmit(now: CACurrentMediaTime(), deadline: deadline, gpuSeconds: cost),
          inFlight.wait(timeout: .now()) == .success else { metrics.missed(); return }
    var committed = false
    defer { if !committed { inFlight.signal() } }
    if let picture = mailbox.take() {
      current = picture
      pictureSize = CGSize(width: Int(picture.frame.width), height: Int(picture.frame.height))
      dirty = true
    }
    guard dirty, let picture = current, let cache, let queue,
          let command = queue.makeCommandBuffer(), let drawable = supplied ?? (layer as! CAMetalLayer).nextDrawable() else { return }
    let format = CVPixelBufferGetPixelFormatType(picture.buffer)
    var heldTextures: [CVMetalTexture] = []
    func texture(_ plane: Int, _ format: MTLPixelFormat, planar: Bool) -> MTLTexture? {
      var cv: CVMetalTexture?
      let width = planar ? CVPixelBufferGetWidthOfPlane(picture.buffer, plane) : CVPixelBufferGetWidth(picture.buffer)
      let height = planar ? CVPixelBufferGetHeightOfPlane(picture.buffer, plane) : CVPixelBufferGetHeight(picture.buffer)
      guard CVMetalTextureCacheCreateTextureFromImage(nil, cache, picture.buffer, nil, format, width, height, plane, &cv) == kCVReturnSuccess,
            let cv, let texture = CVMetalTextureGetTexture(cv) else { return nil }
      heldTextures.append(cv)
      return texture
    }
    let planar = format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange || format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
    guard planar || format == kCVPixelFormatType_32BGRA else { return fail("原生屏幕收到不支持的像素格式") }
    guard let first = texture(0, planar ? .r8Unorm : .bgra8Unorm, planar: planar),
          let pipeline = planar ? yuvPipeline : rgbaPipeline else { return fail("屏幕纹理创建失败") }
    let uv = planar ? texture(1, .rg8Unorm, planar: true) : nil
    if planar, uv == nil { return fail("屏幕色彩纹理创建失败") }
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = drawable.texture
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].storeAction = .store
    pass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 1)
    guard let encoder = command.makeRenderCommandEncoder(descriptor: pass) else { return }
    func viewport(_ rect: CGRect) {
      let scale = (layer as! CAMetalLayer).contentsScale
      encoder.setViewport(MTLViewport(originX: rect.minX * scale, originY: rect.minY * scale, width: rect.width * scale, height: rect.height * scale, znear: 0, zfar: 1))
    }
    viewport(contentRect)
    encoder.setRenderPipelineState(pipeline)
    encoder.setFragmentTexture(first, index: 0)
    encoder.setFragmentTexture(uv, index: 1)
    let full = format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
    var range = SIMD4<Float>(full ? 1 : 255.0 / 219, full ? 0 : 16.0 / 255, full ? 1 : 255.0 / 224, 0)
    encoder.setFragmentBytes(&range, length: MemoryLayout<SIMD4<Float>>.size, index: 0)
    encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
    if showsPointer, let cursorTexture, let rgbaPipeline {
      let rect = contentRect
      viewport(CGRect(x: rect.minX + pointer.x * rect.width - cursorHotspot.x, y: rect.minY + pointer.y * rect.height - cursorHotspot.y, width: cursorSize.width, height: cursorSize.height))
      encoder.setRenderPipelineState(rgbaPipeline)
      encoder.setFragmentTexture(cursorTexture, index: 0)
      encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
    }
    encoder.endEncoding()
    // The simulator SDK has no drawable presentation feedback. Substituting GPU completion
    // would produce a plausible but false display-latency result.
    #if !targetEnvironment(simulator)
    if submittedTimestamp != picture.timestamp, metrics.samples(picture.timestamp) {
      let submitted = CACurrentMediaTime()
      drawable.addPresentedHandler { [metrics] shown in
        metrics.shown(picture.timestamp, submitted: submitted, expected: deadline, actual: shown.presentedTime)
      }
    }
    #endif
    command.addCompletedHandler { [weak self, inFlight, heldTextures] buffer in
      _ = heldTextures; _ = picture
      if let self, buffer.gpuEndTime > buffer.gpuStartTime {
        self.timingLock.lock()
        self.gpuSeconds = self.gpuSeconds * 0.8 + (buffer.gpuEndTime - buffer.gpuStartTime) * 0.2
        self.timingLock.unlock()
      }
      inFlight.signal()
      if buffer.status == .error {
        DispatchQueue.main.async { [weak self] in self?.fail("屏幕渲染失败，请重新连接") }
      }
    }
    command.present(drawable)
    command.commit()
    committed = true
    submittedTimestamp = picture.timestamp
    dirty = false
    if !reportedFrame || reportedSize != pictureSize {
      reportedFrame = true
      reportedSize = pictureSize
      onPicture?(pictureSize)
    }
  }

  private func fail(_ message: String) {
    guard !reportedFailure else { return }
    reportedFailure = true
    onFailure?(message)
  }

  private static let shader = """
  #include <metal_stdlib>
  using namespace metal;
  struct V { float4 position [[position]]; float2 uv; };
  vertex V screenVertex(uint i [[vertex_id]]) {
    const float2 p[4] = {float2(-1,1),float2(-1,-1),float2(1,1),float2(1,-1)};
    const float2 uv[4] = {float2(0,0),float2(0,1),float2(1,0),float2(1,1)};
    return {float4(p[i],0,1),uv[i]};
  }
  fragment float4 screenYUV(V v [[stage_in]], texture2d<float> y [[texture(0)]], texture2d<float> uv [[texture(1)]], constant float4& r [[buffer(0)]]) {
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    float l = (y.sample(s,v.uv).r-r.y)*r.x;
    float2 c = (uv.sample(s,v.uv).rg-float2(128.0/255.0))*r.z;
    return float4(l+1.5748*c.y,l-0.187324*c.x-0.468124*c.y,l+1.8556*c.x,1);
  }
  fragment float4 screenRGBA(V v [[stage_in]], texture2d<float> t [[texture(0)]]) {
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    return t.sample(s,v.uv);
  }
  """
}

private final class ScreenDisplayDriver: NSObject {
  weak var view: ScreenMetalView?
  init(view: ScreenMetalView) { self.view = view }
  @objc func tick(_ link: CADisplayLink) { view?.draw(drawable: nil, deadline: link.targetTimestamp) }
}

@available(iOS 17.0, *)
extension ScreenDisplayDriver: CAMetalDisplayLinkDelegate {
  func metalDisplayLink(_ link: CAMetalDisplayLink, needsUpdate update: CAMetalDisplayLink.Update) {
    view?.draw(drawable: update.drawable, deadline: update.targetPresentationTimestamp)
  }
}
