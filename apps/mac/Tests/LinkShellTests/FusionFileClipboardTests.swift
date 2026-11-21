import AppKit
import Foundation
import XCTest
@testable import LinkShell

final class FusionFileClipboardTests: XCTestCase {
  private func makeTempDir() throws -> URL {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("fusion-fileclip-test-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  func testSanitizeFilenameBlocksTraversalAndDisambiguatesDuplicates() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: dir) }

    XCTAssertEqual(FusionFileClipboard.sanitizeFilename("../../.ssh/authorized_keys", fallbackIndex: 0), "authorized_keys")
    XCTAssertEqual(FusionFileClipboard.sanitizeFilename("C:\\Windows\\System32\\cmd.exe", fallbackIndex: 1), "cmd.exe")
    XCTAssertEqual(FusionFileClipboard.sanitizeFilename("..", fallbackIndex: 2), "file-2")
    XCTAssertEqual(FusionFileClipboard.sanitizeFilename(".", fallbackIndex: 3), "file-3")
    XCTAssertEqual(FusionFileClipboard.sanitizeFilename("a..b/c\0d.txt", fallbackIndex: 4), "cd.txt")
    XCTAssertEqual(FusionFileClipboard.sanitizeFilename(".hidden", fallbackIndex: 5), "hidden")

    var used: Set<String> = []
    let u1 = try XCTUnwrap(FusionFileClipboard.uniqueSafeURL(in: dir, name: "../dirA/report.pdf", usedNames: &used, fallbackIndex: 0))
    let u2 = try XCTUnwrap(FusionFileClipboard.uniqueSafeURL(in: dir, name: "../dirB/report.pdf", usedNames: &used, fallbackIndex: 1))
    XCTAssertEqual(u1.lastPathComponent, "report.pdf")
    XCTAssertEqual(u2.lastPathComponent, "report-1.pdf")
    XCTAssertEqual(u1.deletingLastPathComponent().path, dir.standardizedFileURL.resolvingSymlinksInPath().path)
    XCTAssertEqual(u2.deletingLastPathComponent().path, dir.standardizedFileURL.resolvingSymlinksInPath().path)
  }

  func testFileClipboardMessagesValidateLimits() {
    XCTAssertNil(FusionFileClipboardStart(message: [
      "t": "clip.file.start",
      "transferId": "fc-over",
      "files": [["index": 0, "name": "big.bin", "size": FusionProtocol.maxFileClipboard + 1]],
      "totalBytes": FusionProtocol.maxFileClipboard + 1,
    ]))
    XCTAssertNil(FusionFileClipboardStart(message: [
      "t": "clip.file.start",
      "transferId": "fc-empty",
      "files": [],
      "totalBytes": 0,
    ]))
    XCTAssertNil(FusionFileClipboardChunk(message: [
      "t": "clip.file.chunk",
      "transferId": "fc-neg",
      "index": 0,
      "seq": -1,
      "data": "YQ==",
    ]))
    XCTAssertNil(FusionFileClipboardEnd(message: [
      "t": "clip.file.end",
      "transferId": "",
      "ok": true,
    ]))
  }

  func testPasteboardFileReadWriteRoundTripAndBudget() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: dir) }

    let smallURL = dir.appendingPathComponent("hello.txt")
    let emptyURL = dir.appendingPathComponent("empty.bin")
    let subDir = dir.appendingPathComponent("folder", isDirectory: true)
    try Data("hello file clipboard".utf8).write(to: smallURL)
    try Data().write(to: emptyURL)
    try FileManager.default.createDirectory(at: subDir, withIntermediateDirectories: true)

    let pasteboard = NSPasteboard.withUniqueName()
    defer { pasteboard.releaseGlobally() }

    let count = FusionFileClipboard.writePasteboardFiles([smallURL, emptyURL], to: pasteboard)
    XCTAssertGreaterThan(count, 0)

    let selection = FusionFileClipboard.readPasteboardFiles(pasteboard)
    XCTAssertTrue(selection.containsFileURLs)
    XCTAssertEqual(selection.files.count, 2)
    XCTAssertEqual(selection.files[0].name, "hello.txt")
    XCTAssertEqual(selection.files[0].size, 20)
    XCTAssertEqual(selection.files[1].name, "empty.bin")
    XCTAssertEqual(selection.files[1].size, 0)
    XCTAssertEqual(selection.totalBytes, 20)

    // Budget enforcement
    let rejectedBudget = FusionFileClipboard.readPasteboardFiles(pasteboard, maxTotalBytes: 10)
    XCTAssertTrue(rejectedBudget.containsFileURLs)
    XCTAssertTrue(rejectedBudget.files.isEmpty)

    // Directories must not be treated as regular file transfers
    _ = FusionFileClipboard.writePasteboardFiles([subDir], to: pasteboard)
    let dirSelection = FusionFileClipboard.readPasteboardFiles(pasteboard)
    XCTAssertTrue(dirSelection.containsFileURLs)
    XCTAssertTrue(dirSelection.files.isEmpty)

    // Guard supports 50 MiB limit and 0-byte regular file with allowEmpty: true
    var guardrail = FusionClipboardGuard()
    guardrail.armed = true
    XCTAssertTrue(guardrail.shouldSend(changeCount: 1, types: ["public.file-url"], bytes: 0, maxBytes: FusionProtocol.maxFileClipboard, allowEmpty: true))
    XCTAssertTrue(guardrail.shouldSend(changeCount: 2, types: ["public.file-url"], bytes: 50 << 20, maxBytes: FusionProtocol.maxFileClipboard, allowEmpty: true))
    XCTAssertFalse(guardrail.shouldSend(changeCount: 3, types: ["public.file-url"], bytes: (50 << 20) + 1, maxBytes: FusionProtocol.maxFileClipboard, allowEmpty: true))
  }

  func testChunkedSenderAndReceiverRoundTripAndFailureCleanup() throws {
    let sourceDir = try makeTempDir()
    let recvRoot = try makeTempDir()
    defer {
      try? FileManager.default.removeItem(at: sourceDir)
      try? FileManager.default.removeItem(at: recvRoot)
    }

    let payloadA = Data((0..<(FusionProtocol.fileClipboardChunkBytes + 12_345)).map { UInt8($0 & 0xFF) })
    let payloadB = Data()
    let fileA = sourceDir.appendingPathComponent("binary-a.dat")
    let fileB = sourceDir.appendingPathComponent("zero-b.txt")
    try payloadA.write(to: fileA)
    try payloadB.write(to: fileB)

    let selection = FusionFileClipboard.PasteboardSelection(
      files: [
        .init(url: fileA, name: "../../evil/binary-a.dat", size: payloadA.count, mime: "application/octet-stream"),
        .init(url: fileB, name: "zero-b.txt", size: 0, mime: "text/plain"),
      ],
      totalBytes: payloadA.count,
      containsFileURLs: true
    )

    let finished = expectation(description: "received files written cleanly")
    var receivedURLs: [URL] = []
    let receiver = FusionFileClipboardReceiver(tempRoot: recvRoot) { urls in
      receivedURLs = urls
      finished.fulfill()
    }
    defer { receiver.cleanupAll() }

    let msgLock = NSLock()
    var chunkCount = 0
    var messages: [[String: Any]] = []
    let sender = FusionFileClipboardSender { msg in
      msgLock.lock()
      messages.append(msg)
      if msg["t"] as? String == "clip.file.chunk" {
        chunkCount += 1
      }
      msgLock.unlock()
      DispatchQueue.main.async {
        receiver.handle(msg)
      }
    }

    let transferId = sender.send(files: selection.files)
    XCTAssertNotNil(transferId)
    wait(for: [finished], timeout: 5.0)

    XCTAssertEqual(chunkCount, 2)
    XCTAssertEqual(receivedURLs.count, 2)
    XCTAssertEqual(receivedURLs[0].lastPathComponent, "binary-a.dat")
    XCTAssertEqual(receivedURLs[1].lastPathComponent, "zero-b.txt")
    XCTAssertTrue(receivedURLs[0].path.hasPrefix(recvRoot.standardizedFileURL.resolvingSymlinksInPath().path + "/"))
    XCTAssertEqual(try Data(contentsOf: receivedURLs[0]), payloadA)
    XCTAssertEqual(try Data(contentsOf: receivedURLs[1]), payloadB)

    // Verify failed transfer aborts without triggering ready and removes partial directory
    var failedReady = false
    let receiver2 = FusionFileClipboardReceiver(tempRoot: recvRoot) { _ in
      failedReady = true
    }
    let beforeDirs = try FileManager.default.contentsOfDirectory(atPath: recvRoot.path).count
    receiver2.handle([
      "t": "clip.file.start",
      "transferId": "fc-abort",
      "files": [["index": 0, "name": "part.bin", "size": 100]],
      "totalBytes": 100,
    ])
    XCTAssertGreaterThan(try FileManager.default.contentsOfDirectory(atPath: recvRoot.path).count, beforeDirs)
    receiver2.handle(["t": "clip.file.end", "transferId": "fc-abort", "ok": false, "error": "aborted"])
    XCTAssertFalse(failedReady)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: recvRoot.path).count, beforeDirs)
    receiver2.cleanupAll()
  }
}
