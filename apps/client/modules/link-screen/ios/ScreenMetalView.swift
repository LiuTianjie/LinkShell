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
  var pointer = CGPoint(x: 0.5, y: 0.5) { didSet { updatePresentation() } }
  var showsPointer = true { didSet { updatePresentation() } }
  var zoom: CGFloat = 1 { didSet { updatePresentation() } }
  var pan = CGPoint.zero { didSet { updatePresentation() } }
  var externalContentRect: CGRect? { didSet { updatePresentation() } }
  private(set) var pictureSize = CGSize(width: 16, height: 9)
  private(set) var requestedFps = 60
  private var renderer: ScreenMetalRenderer!

  init(metrics: ScreenMetrics) {
    self.metrics = metrics
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    clipsToBounds = true
    backgroundColor = .black
    renderer = ScreenMetalRenderer(surface: layer as! CAMetalLayer, metrics: metrics,
      picture: { [weak self] size in self?.pictureSize = size; self?.onPicture?(size) },
      failure: { [weak self] message in self?.onFailure?(message) })
    let size = CGSize(width: 18, height: 26)
    let image = UIGraphicsImageRenderer(size: size).image { _ in
      let path = UIBezierPath()
      path.move(to: CGPoint(x: 1, y: 1)); path.addLine(to: CGPoint(x: 1, y: 21))
      path.addLine(to: CGPoint(x: 6, y: 17)); path.addLine(to: CGPoint(x: 10, y: 25))
      path.addLine(to: CGPoint(x: 14, y: 23)); path.addLine(to: CGPoint(x: 10, y: 15))
      path.addLine(to: CGPoint(x: 17, y: 15)); path.close()
      UIColor.white.setFill(); path.fill()
      UIColor.black.setStroke(); path.lineWidth = 1; path.stroke()
    }
    setCursor(image, size: size, hotspot: .zero)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func layoutSubviews() { super.layoutSubviews(); updatePresentation() }

  private func updatePresentation() {
    guard renderer != nil else { return }
    renderer.presentation.update { state in
      state.bounds = bounds.size; state.scale = window?.screen.scale ?? UIScreen.main.scale
      state.pointer = pointer; state.showsPointer = showsPointer
      state.zoom = zoom; state.pan = pan; state.externalRect = externalContentRect
      state.revision &+= 1
    }
  }

  var contentRect: CGRect { renderer.presentation.read().contentRect(picture: pictureSize) }
  func setCursor(_ image: UIImage, size: CGSize, hotspot: CGPoint) {
    guard let cg = image.cgImage else { return }
    renderer.setCursor(cg, size: size, hotspot: hotspot)
  }
  func start(fps: Int) {
    requestedFps = min(fps, window?.screen.maximumFramesPerSecond ?? UIScreen.main.maximumFramesPerSecond)
    updatePresentation(); renderer.start(fps: requestedFps)
  }
  func pause() { renderer.pause() }
  func stop() { renderer.stop() }
  func setSize(_ size: CGSize) { /* The frame and its dimensions must be consumed together. */ }
  func renderFrame(_ frame: RTCVideoFrame?) { if let frame { renderer.receive(frame) } }
  func takeReplacements() -> Int { renderer.takeReplacements() }
}

private struct ScreenPresentation {
  var bounds = CGSize.zero
  var scale: CGFloat = 1
  var pointer = CGPoint(x: 0.5, y: 0.5)
  var showsPointer = true
  var zoom: CGFloat = 1
  var pan = CGPoint.zero
  var externalRect: CGRect?
  var cursor: MTLTexture?
  var cursorSize = CGSize(width: 18, height: 26)
  var cursorHotspot = CGPoint.zero
  var revision: UInt64 = 0
  func contentRect(picture: CGSize) -> CGRect {
    if let externalRect { return externalRect }
    let fit = min(bounds.width / max(1, picture.width), bounds.height / max(1, picture.height))
    let size = CGSize(width: picture.width * fit * zoom, height: picture.height * fit * zoom)
    return CGRect(x: (bounds.width - size.width) / 2 + pan.x, y: (bounds.height - size.height) / 2 + pan.y, width: size.width, height: size.height)
  }
}

/// The worker owns display-link callbacks, texture mapping and submission. The UIView only
/// publishes value snapshots and receives occasional main-thread size/failure notifications.
private final class ScreenMetalRenderer {
  let presentation = ScreenShared(ScreenPresentation())
  private let surface: CAMetalLayer
  private let metrics: ScreenMetrics
  private let onPicture: (CGSize) -> Void
  private let onFailure: (String) -> Void
  private let worker = ScreenRenderThread()
  private let lifecycle = ScreenShared((generation: UInt64(0), active: true))
  private let mailbox = ScreenMailbox<ScreenPicture>()
  private let inFlight = DispatchSemaphore(value: 1)
  private let timingLock = NSLock()
  private var gpuSeconds = 0.0005
  private var current: ScreenPicture?
  private var submittedTimestamp: UInt32?
  private var dirty = true
  private var reportedFrame = false
  private var reportedSize = CGSize.zero
  private var reportedFailureGeneration: UInt64?
  private var presentedRevision: UInt64?
  private var queue: MTLCommandQueue?
  private var yuvPipeline: MTLRenderPipelineState?
  private var rgbaPipeline: MTLRenderPipelineState?
  private var cache: CVMetalTextureCache?
  private var driver: ScreenDisplayDriver?
  private var metalLink: AnyObject?
  private var legacyLink: CADisplayLink?

  init(surface: CAMetalLayer, metrics: ScreenMetrics, picture: @escaping (CGSize) -> Void, failure: @escaping (String) -> Void) {
    self.surface = surface; self.metrics = metrics; onPicture = picture; onFailure = failure
    configureMetal()
  }

  private func configureMetal() {
    guard let device = MTLCreateSystemDefaultDevice() else { return fail("这台设备无法使用原生屏幕渲染") }
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
    } catch { fail("原生屏幕渲染初始化失败") }
  }

  func setCursor(_ image: CGImage, size: CGSize, hotspot: CGPoint) {
    guard let device = surface.device else { return }
    let texture = try? MTKTextureLoader(device: device).newTexture(cgImage: image, options: [.SRGB: false])
    presentation.update { $0.cursor = texture; $0.cursorSize = size; $0.cursorHotspot = hotspot; $0.revision &+= 1 }
  }

  func start(fps: Int) {
    let generation = lifecycle.update { state in
      state.generation &+= 1; state.active = true
      return state.generation
    }
    worker.perform { [self] in configureDisplayLink(fps: fps, generation: generation) }
  }

  private func configureDisplayLink(fps: Int, generation: UInt64) {
    let life = lifecycle.read()
    guard life.active, life.generation == generation else { return }
    stopDisplayLink()
    // Starting a new generation can invalidate a size callback still waiting on the UI
    // thread. Redraw the retained picture without waiting for another decoded frame.
    reportedFrame = false
    dirty = true
    applySize(presentation.read())
    let driver = ScreenDisplayDriver(renderer: self)
    self.driver = driver
    let range = CAFrameRateRange(minimum: Float(min(60, fps)), maximum: Float(fps), preferred: Float(fps))
    if #available(iOS 17.0, *) {
      let link = CAMetalDisplayLink(metalLayer: surface)
      link.preferredFrameLatency = 1
      link.preferredFrameRateRange = range
      link.delegate = driver
      link.add(to: .current, forMode: .common)
      metalLink = link
    } else {
      let link = CADisplayLink(target: driver, selector: #selector(ScreenDisplayDriver.tick(_:)))
      link.preferredFrameRateRange = range
      link.add(to: .current, forMode: .common)
      legacyLink = link
    }
  }

  func pause() {
    lifecycle.update { $0.generation &+= 1; $0.active = false }
    worker.perform { [self] in
      stopDisplayLink(); _ = mailbox.take()
    }
  }

  func stop() {
    lifecycle.update { $0.generation &+= 1; $0.active = false }
    worker.perform { [self] in
      stopDisplayLink(); _ = mailbox.take(); current = nil
      submittedTimestamp = nil; reportedFrame = false; presentedRevision = nil; dirty = true
    }
  }

  private func stopDisplayLink() {
    if #available(iOS 17.0, *) { (metalLink as? CAMetalDisplayLink)?.invalidate() }
    metalLink = nil
    legacyLink?.invalidate(); legacyLink = nil; driver = nil
  }

  deinit {
    let metal = metalLink, legacy = legacyLink
    worker.stop {
      if #available(iOS 17.0, *) { (metal as? CAMetalDisplayLink)?.invalidate() }
      legacy?.invalidate()
    }
  }
  func receive(_ frame: RTCVideoFrame) {
    let life = lifecycle.read()
    guard life.active else { return }
    guard let native = frame.buffer as? RTCCVPixelBuffer else {
      worker.perform { [weak self] in self?.fail("当前视频格式无法使用原生屏幕渲染", generation: life.generation) }
      return
    }
    let timestamp = UInt32(bitPattern: frame.timeStamp)
    // Publish under the lifecycle lock so stop/pause cannot clear the mailbox and then
    // receive a frame whose earlier active check belonged to a previous generation.
    lifecycle.update { current in
      guard current == life else { return }
      metrics.received(timestamp)
      mailbox.put(ScreenPicture(frame: frame, buffer: native.pixelBuffer, timestamp: timestamp))
    }
  }

  func takeReplacements() -> Int { mailbox.takeReplacements() }

  fileprivate func draw(drawable supplied: CAMetalDrawable?, deadline: Double) {
    let life = lifecycle.read()
    guard life.active else { return }
    let view = presentation.read()
    defer { applySize(view) }
    timingLock.lock(); let cost = gpuSeconds; timingLock.unlock()
    guard ScreenTiming.canSubmit(now: CACurrentMediaTime(), deadline: deadline, gpuSeconds: cost),
          inFlight.wait(timeout: .now()) == .success else { metrics.missed(); return }
    var committed = false
    defer { if !committed { inFlight.signal() } }
    if let picture = mailbox.take() {
      current = picture
      dirty = true
    }
    dirty = dirty || presentedRevision != view.revision
    guard dirty, let picture = current, let cache, let queue,
          let command = queue.makeCommandBuffer(), let drawable = supplied ?? surface.nextDrawable() else { return }
    let pictureSize = CGSize(width: Int(picture.frame.width), height: Int(picture.frame.height))
    let contentRect = view.contentRect(picture: pictureSize)
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
    guard planar || format == kCVPixelFormatType_32BGRA else { return fail("原生屏幕收到不支持的像素格式", generation: life.generation) }
    guard let first = texture(0, planar ? .r8Unorm : .bgra8Unorm, planar: planar),
          let pipeline = planar ? yuvPipeline : rgbaPipeline else { return fail("屏幕纹理创建失败", generation: life.generation) }
    let uv = planar ? texture(1, .rg8Unorm, planar: true) : nil
    if planar, uv == nil { return fail("屏幕色彩纹理创建失败", generation: life.generation) }
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = drawable.texture
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].storeAction = .store
    pass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 1)
    guard let encoder = command.makeRenderCommandEncoder(descriptor: pass) else { return }
    func viewport(_ rect: CGRect) {
      let scale = view.scale
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
    if view.showsPointer, let cursorTexture = view.cursor, let rgbaPipeline {
      let rect = contentRect
      viewport(CGRect(x: rect.minX + view.pointer.x * rect.width - view.cursorHotspot.x, y: rect.minY + view.pointer.y * rect.height - view.cursorHotspot.y, width: view.cursorSize.width, height: view.cursorSize.height))
      encoder.setRenderPipelineState(rgbaPipeline)
      encoder.setFragmentTexture(cursorTexture, index: 0)
      encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
    }
    encoder.endEncoding()
    guard lifecycle.read() == life else { return }
    // The simulator SDK has no drawable presentation feedback. Substituting GPU completion
    // would produce a plausible but false display-latency result.
    #if !targetEnvironment(simulator)
    if submittedTimestamp != picture.timestamp, metrics.samples(picture.timestamp) {
      let submitted = CACurrentMediaTime()
      drawable.addPresentedHandler { [weak self, metrics] shown in
        guard let self, self.lifecycle.read() == life else { return }
        metrics.shown(picture.timestamp, submitted: submitted, expected: deadline, actual: shown.presentedTime)
      }
    }
    #endif
    command.addCompletedHandler { [weak self, inFlight, heldTextures] buffer in
      _ = heldTextures; _ = picture
      if let self, self.lifecycle.read() == life, buffer.gpuEndTime > buffer.gpuStartTime {
        self.timingLock.lock()
        self.gpuSeconds = self.gpuSeconds * 0.8 + (buffer.gpuEndTime - buffer.gpuStartTime) * 0.2
        self.timingLock.unlock()
      }
      inFlight.signal()
      if buffer.status == .error {
        self?.worker.perform { [weak self] in self?.fail("屏幕渲染失败，请重新连接", generation: life.generation) }
      }
    }
    command.present(drawable)
    command.commit()
    metrics.committed()
    committed = true
    submittedTimestamp = picture.timestamp
    dirty = false
    presentedRevision = view.revision
    if !reportedFrame || reportedSize != pictureSize {
      reportedFrame = true
      reportedSize = pictureSize
      DispatchQueue.main.async { [weak self] in
        guard let self, self.lifecycle.read() == life else { return }
        self.onPicture(pictureSize)
      }
    }
  }

  private func applySize(_ view: ScreenPresentation) {
    let size = CGSize(width: max(1, view.bounds.width * view.scale), height: max(1, view.bounds.height * view.scale))
    if surface.drawableSize != size { surface.drawableSize = size }
    if surface.contentsScale != view.scale { surface.contentsScale = view.scale }
  }

  private func fail(_ message: String, generation: UInt64? = nil) {
    let life = lifecycle.read()
    guard life.active, generation == nil || generation == life.generation,
          reportedFailureGeneration != life.generation else { return }
    reportedFailureGeneration = life.generation
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      let current = self.lifecycle.read()
      guard current.active, life.generation == 0 || current == life else { return }
      self.onFailure(message)
    }
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
  weak var renderer: ScreenMetalRenderer?
  init(renderer: ScreenMetalRenderer) { self.renderer = renderer }
  @objc func tick(_ link: CADisplayLink) { renderer?.draw(drawable: nil, deadline: link.targetTimestamp) }
}

@available(iOS 17.0, *)
extension ScreenDisplayDriver: CAMetalDisplayLinkDelegate {
  func metalDisplayLink(_ link: CAMetalDisplayLink, needsUpdate update: CAMetalDisplayLink.Update) {
    renderer?.draw(drawable: update.drawable, deadline: update.targetPresentationTimestamp)
  }
}
