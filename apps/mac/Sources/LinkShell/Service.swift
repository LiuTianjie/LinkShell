import Foundation

/// What the app does for the host over its socket (`--connect`): says what it may do, lends its
/// hands to any number of viewers, sends one of them a display as a video track, and encodes a
/// display for the host to send on itself.
///
///   → status | displays
///   → open {v, screen} | close {v} | an input event {v, …}        a viewer's hands (`Control`)
///   → rtc.open {v, screen, iceServers, …} | rtc.answer | rtc.ice | rtc.close      (`ScreenSession`)
///   → stream.open {v, screen, socket, width, fps, bitrate, …} | stream.set | stream.key | stream.close   (`StreamSession`)
///   ← status, trusted, displays, ready, cursor, posted, rtc.*, stream.*, log
///
/// Everything here happens on the main queue.
final class Service {
  private let link: Link
  private let options: ScreenSession.Options
  private var controls: [String: Control] = [:]
  private var session: ScreenSession?
  private var streams: [String: StreamSession] = [:]
  private var previews: [String: ComputerPreview] = [:]
  private var watch: Watch?

  init(link: Link, options: ScreenSession.Options) {
    self.link = link
    self.options = options
  }

  func start() {
    link.emit(status())
    watch = Watch(link: link) { [unowned self] in Array(controls.values) }
    link.read(each: { [unowned self] command in handle(command) }, end: { [unowned self] in
      // The host went: nothing stays pressed, the keyboard is the user's own again, and the app
      // goes too. Its captures and encoders end with it.
      for control in controls.values { control.releaseAll() }
      session?.close()
      for preview in previews.values { preview.close() }
      InputSource.restoreNow()
      watch?.cancel()
      exit(0)
    })
  }

  private func status() -> [String: Any] {
    var status = Permissions.status()
    status["preview"] = true
    if options.clock { status["clock"] = ClockStrip.timing }
    return status
  }

  private func handle(_ command: [String: Any]) {
    guard let kind = command["t"] as? String else { return }
    switch kind {
    case "status": return link.emit(status())
    case "displays": return link.emit(["t": "displays", "list": Display.list()])
    default: break
    }
    guard let id = command["v"] as? String else { return }
    switch kind {
    case "preview.open":
      previews.removeValue(forKey: id)?.close()
      guard previews.count < 8, let preview = ComputerPreview(viewer: id, command: command, link: link) else {
        return link.emit(["t": "preview.paused", "v": id, "error": "无法识别预览窗口"])
      }
      previews[id] = preview
      preview.start()
    case "preview.close":
      previews.removeValue(forKey: id)?.close()
    case "open":
      controls[id]?.releaseAll()
      let control = Control(id: id, link: link, screen: (command["screen"] as? Int) ?? 0)
      controls[id] = control
      control.ready()
    case "close":
      controls.removeValue(forKey: id)?.releaseAll()
    case "rtc.open":
      // One viewer of the video track at a time: the latest wins.
      session?.close()
      let opened = ScreenSession(request: ScreenRequest(viewer: id, command), options: options, link: link)
      session = opened
      opened.start()
    case "rtc.answer":
      if let sdp = command["sdp"] as? String { watched(by: id)?.answer(sdp) }
    case "rtc.ice":
      watched(by: id)?.candidate(command)
    case "rtc.close":
      watched(by: id)?.close()
      if session?.viewer == id { session = nil }
    case "rtc.loopback.send":
      guard let events = command["events"] as? [Any], let channel = command["channel"] as? String else { return }
      watched(by: id)?.sendFromLoopback(events, on: channel)
    case "rtc.loopback.limit":
      watched(by: id)?.limitFromLoopback(command["bitrate"] as? Int)
    case "stream.open":
      // One stream an id; streams of different ids run side by side.
      streams.removeValue(forKey: id)?.close()
      guard let request = StreamRequest(viewer: id, command) else { return link.emit(["t": "stream.ended", "v": id, "error": "not a stream: no socket"]) }
      let stream = StreamSession(request: request, options: options, link: link) { [weak self] ended in
        if self?.streams[id] === ended { self?.streams[id] = nil }
      }
      streams[id] = stream
      stream.start()
    case "stream.set":
      streams[id]?.set(command)
    case "stream.key":
      streams[id]?.key()
    case "stream.close":
      streams.removeValue(forKey: id)?.close()
    default:
      controls[id]?.handle(command)
    }
  }

  /// The session, if it is this viewer's: what is said to one since replaced is dropped.
  private func watched(by id: String) -> ScreenSession? {
    session?.viewer == id ? session : nil
  }
}
