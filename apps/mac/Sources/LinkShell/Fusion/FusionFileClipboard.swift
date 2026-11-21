import AppKit
import Foundation
import UniformTypeIdentifiers

struct FusionFileClipboardFile: Equatable {
  let index: Int
  let name: String
  let size: Int
  let mime: String?

  init(index: Int, name: String, size: Int, mime: String? = nil) {
    self.index = index
    self.name = name
    self.size = size
    self.mime = mime
  }

  var dict: [String: Any] {
    var out: [String: Any] = ["index": index, "name": name, "size": size]
    if let mime, !mime.isEmpty { out["mime"] = mime }
    return out
  }

  init?(dict: [String: Any]) {
    guard let index = (dict["index"] as? NSNumber)?.intValue,
          index >= 0,
          let name = dict["name"] as? String,
          !name.isEmpty,
          name.count <= 255,
          let size = (dict["size"] as? NSNumber)?.intValue,
          size >= 0,
          size <= FusionProtocol.maxFileClipboard else {
      return nil
    }
    let mime = dict["mime"] as? String
    if let mime, mime.count > 255 { return nil }
    self.index = index
    self.name = name
    self.size = size
    self.mime = mime
  }
}

struct FusionFileClipboardStart: Equatable {
  let transferId: String
  let files: [FusionFileClipboardFile]
  let totalBytes: Int

  init(transferId: String, files: [FusionFileClipboardFile], totalBytes: Int) {
    self.transferId = transferId
    self.files = files
    self.totalBytes = totalBytes
  }

  var message: [String: Any] {
    [
      "t": "clip.file.start",
      "transferId": transferId,
      "files": files.map(\.dict),
      "totalBytes": totalBytes,
    ]
  }

  init?(message: [String: Any]) {
    guard message["t"] as? String == "clip.file.start",
          let transferId = message["transferId"] as? String,
          !transferId.isEmpty,
          transferId.count <= FusionProtocol.maxFileClipboardTransferIdBytes,
          let rawFiles = message["files"] as? [[String: Any]],
          !rawFiles.isEmpty,
          rawFiles.count <= FusionProtocol.maxFileClipboardFiles,
          let totalBytes = (message["totalBytes"] as? NSNumber)?.intValue,
          totalBytes >= 0,
          totalBytes <= FusionProtocol.maxFileClipboard else {
      return nil
    }
    var parsed: [FusionFileClipboardFile] = []
    parsed.reserveCapacity(rawFiles.count)
    var seenIndices: Set<Int> = []
    var sum = 0
    for item in rawFiles {
      guard let file = FusionFileClipboardFile(dict: item),
            seenIndices.insert(file.index).inserted else {
        return nil
      }
      sum += file.size
      guard sum <= FusionProtocol.maxFileClipboard else { return nil }
      parsed.append(file)
    }
    guard sum <= totalBytes else { return nil }
    self.transferId = transferId
    self.files = parsed
    self.totalBytes = totalBytes
  }
}

struct FusionFileClipboardChunk: Equatable {
  let transferId: String
  let index: Int
  let seq: Int
  let data: String

  init(transferId: String, index: Int, seq: Int, data: String) {
    self.transferId = transferId
    self.index = index
    self.seq = seq
    self.data = data
  }

  var message: [String: Any] {
    [
      "t": "clip.file.chunk",
      "transferId": transferId,
      "index": index,
      "seq": seq,
      "data": data,
    ]
  }

  init?(message: [String: Any]) {
    guard message["t"] as? String == "clip.file.chunk",
          let transferId = message["transferId"] as? String,
          !transferId.isEmpty,
          transferId.count <= FusionProtocol.maxFileClipboardTransferIdBytes,
          let index = (message["index"] as? NSNumber)?.intValue,
          index >= 0,
          let seq = (message["seq"] as? NSNumber)?.intValue,
          seq >= 0,
          let data = message["data"] as? String,
          data.count <= FusionProtocol.maxFileClipboardChunkBase64Bytes else {
      return nil
    }
    self.transferId = transferId
    self.index = index
    self.seq = seq
    self.data = data
  }

  func decodedData() -> Data? {
    guard let decoded = Data(base64Encoded: data),
          decoded.count <= FusionProtocol.fileClipboardChunkBytes else {
      return nil
    }
    return decoded
  }
}

struct FusionFileClipboardEnd: Equatable {
  let transferId: String
  let ok: Bool
  let error: String?

  init(transferId: String, ok: Bool, error: String? = nil) {
    self.transferId = transferId
    self.ok = ok
    self.error = error
  }

  var message: [String: Any] {
    var out: [String: Any] = [
      "t": "clip.file.end",
      "transferId": transferId,
      "ok": ok,
    ]
    if let error { out["error"] = error }
    return out
  }

  init?(message: [String: Any]) {
    guard message["t"] as? String == "clip.file.end",
          let transferId = message["transferId"] as? String,
          !transferId.isEmpty,
          transferId.count <= FusionProtocol.maxFileClipboardTransferIdBytes,
          let ok = message["ok"] as? Bool else {
      return nil
    }
    let error = message["error"] as? String
    if let error, error.count > FusionProtocol.maxFileClipboardErrorBytes { return nil }
    self.transferId = transferId
    self.ok = ok
    self.error = error
  }
}

enum FusionFileClipboard {
  struct CopiedFile: Equatable {
    let url: URL
    let name: String
    let size: Int
    let mime: String?
  }

  struct PasteboardSelection: Equatable {
    let files: [CopiedFile]
    let totalBytes: Int
    /// True when the pasteboard holds file URLs (even if skipped for being directories or over budget),
    /// so Finder filename plain-text isn't mistakenly forwarded instead.
    let containsFileURLs: Bool
  }

  static func readPasteboardFiles(
    _ pasteboard: NSPasteboard,
    maxFiles: Int = FusionProtocol.maxFileClipboardFiles,
    maxTotalBytes: Int = FusionProtocol.maxFileClipboard
  ) -> PasteboardSelection {
    guard let raw = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
          !raw.isEmpty else {
      return PasteboardSelection(files: [], totalBytes: 0, containsFileURLs: false)
    }

    var seenPaths: Set<String> = []
    var files: [CopiedFile] = []
    var totalBytes = 0

    for url in raw {
      guard url.isFileURL else { continue }
      let standardized = url.standardizedFileURL
      guard seenPaths.insert(standardized.path).inserted else { continue }
      guard files.count < maxFiles else {
        return PasteboardSelection(files: [], totalBytes: 0, containsFileURLs: true)
      }
      guard let values = try? standardized.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey, .fileSizeKey, .contentTypeKey]),
            values.isRegularFile == true,
            values.isDirectory != true else {
        return PasteboardSelection(files: [], totalBytes: 0, containsFileURLs: true)
      }
      let size = max(0, values.fileSize ?? 0)
      guard size <= maxTotalBytes, totalBytes + size <= maxTotalBytes else {
        return PasteboardSelection(files: [], totalBytes: 0, containsFileURLs: true)
      }
      totalBytes += size
      let rawName = standardized.lastPathComponent
      let name = rawName.isEmpty ? "file-\(files.count)" : String(rawName.prefix(255))
      var mime = values.contentType?.preferredMIMEType
      if mime == nil, !standardized.pathExtension.isEmpty {
        mime = UTType(filenameExtension: standardized.pathExtension)?.preferredMIMEType
      }
      if let m = mime, m.count > 255 { mime = String(m.prefix(255)) }
      files.append(CopiedFile(url: standardized, name: name, size: size, mime: mime))
    }

    return PasteboardSelection(files: files, totalBytes: totalBytes, containsFileURLs: true)
  }

  @discardableResult
  static func writePasteboardFiles(_ urls: [URL], to pasteboard: NSPasteboard) -> Int {
    guard !urls.isEmpty else { return pasteboard.changeCount }
    pasteboard.clearContents()
    pasteboard.writeObjects(urls.map { $0.standardizedFileURL as NSURL })
    return pasteboard.changeCount
  }

  /// Strips directory prefixes, traversal components (`..`, `.`), NUL/control characters, and
  /// platform-unsafe characters so received filenames can never escape the temp directory.
  static func sanitizeFilename(_ raw: String, fallbackIndex: Int) -> String {
    let withoutControl = String(raw.unicodeScalars.filter { scalar in
      scalar.value >= 0x20 && scalar.value != 0x7F
    })
    let normalizedSlashes = withoutControl.replacingOccurrences(of: "\\", with: "/")
    let segments = normalizedSlashes.split(separator: "/").map(String.init)
    var candidate = ""
    for segment in segments.reversed() {
      if segment.isEmpty || segment == "." || segment == ".." { continue }
      candidate = segment
      break
    }
    for bad in ["/", "\\", ":", "\0"] {
      candidate = candidate.replacingOccurrences(of: bad, with: "_")
    }
    while candidate.contains("..") {
      candidate = candidate.replacingOccurrences(of: "..", with: "_")
    }
    candidate = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
    while candidate.hasPrefix(".") {
      candidate.removeFirst()
    }
    candidate = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
    if candidate.isEmpty || candidate == "." || candidate == ".." {
      candidate = "file-\(fallbackIndex)"
    }
    if candidate.utf8.count > 200 {
      let ext = (candidate as NSString).pathExtension
      if !ext.isEmpty, ext.utf8.count < 32 {
        let stem = (candidate as NSString).deletingPathExtension
        let clippedStem = String(stem.prefix(max(1, 160 - ext.count)))
        candidate = "\(clippedStem).\(ext)"
      } else {
        candidate = String(candidate.prefix(200))
      }
    }
    return candidate
  }

  static func uniqueSafeURL(in directory: URL, name: String, usedNames: inout Set<String>, fallbackIndex: Int) -> URL? {
    let base = sanitizeFilename(name, fallbackIndex: fallbackIndex)
    var unique = base
    if usedNames.contains(unique.lowercased()) {
      let stem = (base as NSString).deletingPathExtension
      let ext = (base as NSString).pathExtension
      var counter = 1
      while true {
        let next = ext.isEmpty ? "\(stem)-\(counter)" : "\(stem)-\(counter).\(ext)"
        if !usedNames.contains(next.lowercased()) {
          unique = next
          break
        }
        counter += 1
      }
    }
    usedNames.insert(unique.lowercased())

    let dirResolved = directory.standardizedFileURL.resolvingSymlinksInPath()
    let target = dirResolved.appendingPathComponent(unique, isDirectory: false).standardizedFileURL
    let parentPrefix = dirResolved.path.hasSuffix("/") ? dirResolved.path : dirResolved.path + "/"
    guard target.path.hasPrefix(parentPrefix), target.deletingLastPathComponent().path == dirResolved.path else {
      return nil
    }
    return target
  }
}

/// Streams local clipboard files in 512 KiB chunks off the main thread.
final class FusionFileClipboardSender {
  private let queue = DispatchQueue(label: "com.bd.linkshell.fusion.fileclip.send", qos: .utility)
  private let lock = NSLock()
  private var generation: UInt64 = 0
  private let sendMessage: ([String: Any]) -> Void

  init(sendMessage: @escaping ([String: Any]) -> Void) {
    self.sendMessage = sendMessage
  }

  func cancel() {
    lock.lock()
    generation &+= 1
    lock.unlock()
  }

  @discardableResult
  func send(files: [FusionFileClipboard.CopiedFile], chunkBytes: Int = FusionProtocol.fileClipboardChunkBytes) -> String? {
    guard !files.isEmpty, files.count <= FusionProtocol.maxFileClipboardFiles else { return nil }
    let totalBytes = files.reduce(0) { $0 + $1.size }
    guard totalBytes >= 0, totalBytes <= FusionProtocol.maxFileClipboard else { return nil }

    let transferId = "fc-\(UUID().uuidString.lowercased())"
    lock.lock()
    generation &+= 1
    let myGeneration = generation
    lock.unlock()

    let entries = files.enumerated().map { idx, file in
      FusionFileClipboardFile(index: idx, name: file.name, size: file.size, mime: file.mime)
    }
    let start = FusionFileClipboardStart(transferId: transferId, files: entries, totalBytes: totalBytes)
    let send = self.sendMessage

    queue.async { [weak self] in
      let isCancelled = { () -> Bool in
        guard let self else { return true }
        self.lock.lock()
        let active = self.generation == myGeneration
        self.lock.unlock()
        return !active
      }

      guard !isCancelled() else { return }
      send(start.message)

      for (index, file) in files.enumerated() {
        guard !isCancelled() else { return }
        guard let handle = try? FileHandle(forReadingFrom: file.url) else {
          send(FusionFileClipboardEnd(transferId: transferId, ok: false, error: "无法读取文件：\(file.name)").message)
          return
        }
        defer { try? handle.close() }

        var remaining = file.size
        var seq = 0
        while remaining > 0 {
          guard !isCancelled() else { return }
          let toRead = min(chunkBytes, remaining)
          let chunkData: Data
          do {
            chunkData = try handle.read(upToCount: toRead) ?? Data()
          } catch {
            send(FusionFileClipboardEnd(transferId: transferId, ok: false, error: error.localizedDescription).message)
            return
          }
          if chunkData.isEmpty {
            send(FusionFileClipboardEnd(transferId: transferId, ok: false, error: "文件在传输过程中已变化：\(file.name)").message)
            return
          }
          let chunk = FusionFileClipboardChunk(
            transferId: transferId,
            index: index,
            seq: seq,
            data: chunkData.base64EncodedString()
          )
          send(chunk.message)
          remaining -= chunkData.count
          seq += 1
        }
      }

      guard !isCancelled() else { return }
      send(FusionFileClipboardEnd(transferId: transferId, ok: true).message)
    }

    return transferId
  }
}

/// Receives chunked remote file transfers into an isolated `0700` temp directory with traversal protection.
final class FusionFileClipboardReceiver {
  private struct ActiveTransfer {
    let id: String
    let dir: URL
    let filesByIndex: [Int: FusionFileClipboardFile]
    let orderedIndices: [Int]
    let urlsByIndex: [Int: URL]
    let declaredTotalBytes: Int
    var handlesByIndex: [Int: FileHandle] = [:]
    var nextSeqByIndex: [Int: Int] = [:]
    var bytesByIndex: [Int: Int] = [:]
    var totalReceivedBytes = 0
  }

  private let fileManager = FileManager.default
  private let tempRoot: URL
  private var active: ActiveTransfer?
  private var completedDirs: [URL] = []
  private let onFilesReady: ([URL]) -> Void

  init(tempRoot: URL? = nil, onFilesReady: @escaping ([URL]) -> Void) {
    self.tempRoot = tempRoot ?? fileManager.temporaryDirectory
      .appendingPathComponent("linkshell-fusion-file-clipboard-\(ProcessInfo.processInfo.processIdentifier)", isDirectory: true)
    self.onFilesReady = onFilesReady
  }

  deinit {
    cleanupAll()
  }

  func handle(_ message: [String: Any]) {
    switch message["t"] as? String {
    case "clip.file.start":
      if let start = FusionFileClipboardStart(message: message) {
        begin(start)
      }
    case "clip.file.chunk":
      if let chunk = FusionFileClipboardChunk(message: message) {
        receive(chunk)
      }
    case "clip.file.end":
      if let end = FusionFileClipboardEnd(message: message) {
        finish(end)
      }
    default:
      break
    }
  }

  func cancelPending() {
    guard let transfer = active else { return }
    active = nil
    closeHandles(transfer)
    try? fileManager.removeItem(at: transfer.dir)
  }

  func cleanupAll() {
    cancelPending()
    for dir in completedDirs {
      try? fileManager.removeItem(at: dir)
    }
    completedDirs.removeAll()
    try? fileManager.removeItem(at: tempRoot)
  }

  private func begin(_ start: FusionFileClipboardStart) {
    cancelPending()

    do {
      try fileManager.createDirectory(at: tempRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    } catch {
      return
    }

    let transferDir = tempRoot.appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
    do {
      try fileManager.createDirectory(at: transferDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    } catch {
      return
    }

    var usedNames: Set<String> = []
    var filesByIndex: [Int: FusionFileClipboardFile] = [:]
    var orderedIndices: [Int] = []
    var urlsByIndex: [Int: URL] = [:]

    for file in start.files {
      guard let destination = FusionFileClipboard.uniqueSafeURL(
        in: transferDir,
        name: file.name,
        usedNames: &usedNames,
        fallbackIndex: file.index
      ) else {
        try? fileManager.removeItem(at: transferDir)
        return
      }
      guard fileManager.createFile(atPath: destination.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
        try? fileManager.removeItem(at: transferDir)
        return
      }
      filesByIndex[file.index] = file
      orderedIndices.append(file.index)
      urlsByIndex[file.index] = destination
    }

    active = ActiveTransfer(
      id: start.transferId,
      dir: transferDir,
      filesByIndex: filesByIndex,
      orderedIndices: orderedIndices,
      urlsByIndex: urlsByIndex,
      declaredTotalBytes: start.totalBytes
    )
  }

  private func receive(_ chunk: FusionFileClipboardChunk) {
    guard var transfer = active, transfer.id == chunk.transferId else { return }
    guard let meta = transfer.filesByIndex[chunk.index],
          let url = transfer.urlsByIndex[chunk.index] else {
      abortActive("unexpected file index")
      return
    }
    let expectedSeq = transfer.nextSeqByIndex[chunk.index] ?? 0
    guard chunk.seq == expectedSeq else {
      abortActive("chunk out of sequence")
      return
    }
    guard let bytes = chunk.decodedData() else {
      abortActive("invalid chunk payload")
      return
    }
    let fileReceived = transfer.bytesByIndex[chunk.index] ?? 0
    guard fileReceived + bytes.count <= meta.size,
          transfer.totalReceivedBytes + bytes.count <= transfer.declaredTotalBytes,
          transfer.totalReceivedBytes + bytes.count <= FusionProtocol.maxFileClipboard else {
      abortActive("file clipboard size exceeded")
      return
    }

    let handle: FileHandle
    if let existing = transfer.handlesByIndex[chunk.index] {
      handle = existing
    } else {
      guard let opened = try? FileHandle(forWritingTo: url) else {
        abortActive("failed to open destination file")
        return
      }
      transfer.handlesByIndex[chunk.index] = opened
      handle = opened
    }

    do {
      try handle.write(contentsOf: bytes)
    } catch {
      abortActive("failed writing chunk")
      return
    }

    transfer.nextSeqByIndex[chunk.index] = expectedSeq + 1
    transfer.bytesByIndex[chunk.index] = fileReceived + bytes.count
    transfer.totalReceivedBytes += bytes.count
    active = transfer
  }

  private func finish(_ end: FusionFileClipboardEnd) {
    guard let transfer = active, transfer.id == end.transferId else { return }
    active = nil
    closeHandles(transfer)

    guard end.ok else {
      try? fileManager.removeItem(at: transfer.dir)
      return
    }

    var orderedURLs: [URL] = []
    orderedURLs.reserveCapacity(transfer.orderedIndices.count)
    for index in transfer.orderedIndices {
      guard let meta = transfer.filesByIndex[index],
            let url = transfer.urlsByIndex[index],
            (transfer.bytesByIndex[index] ?? 0) == meta.size else {
        try? fileManager.removeItem(at: transfer.dir)
        return
      }
      orderedURLs.append(url)
    }

    // Keep at most the most recent completed batch so superseded temp files are reclaimed while ⌘V remains valid.
    completedDirs.append(transfer.dir)
    while completedDirs.count > 2 {
      let oldest = completedDirs.removeFirst()
      try? fileManager.removeItem(at: oldest)
    }

    onFilesReady(orderedURLs)
  }

  private func abortActive(_ reason: String) {
    _ = reason
    cancelPending()
  }

  private func closeHandles(_ transfer: ActiveTransfer) {
    for handle in transfer.handlesByIndex.values {
      try? handle.close()
    }
  }
}
