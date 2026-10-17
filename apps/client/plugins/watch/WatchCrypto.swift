import Foundation
import CryptoKit

struct WatchLinkError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

extension Data {
  var watchBase64: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
  init(watchBase64: String) throws {
    let value = watchBase64.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    guard let data = Data(base64Encoded: value + String(repeating: "=", count: (4 - value.count % 4) % 4)) else { throw WatchLinkError("连接密钥格式无效") }
    self = data
  }
}

struct WatchPeerIdentity: Codable, Equatable {
  let id: String
  let signKey: String
  let boxKey: String

  func validate() throws {
    let signing = try Data(watchBase64: signKey)
    guard signing.count == 32, try Data(watchBase64: boxKey).count == 32,
          Data(SHA256.hash(data: signing).prefix(16)).watchBase64 == id else { throw WatchLinkError("电脑身份校验失败") }
  }
}

struct WatchIdentity: Codable {
  let signSecret: Data
  let boxSecret: Data

  init() {
    signSecret = Curve25519.Signing.PrivateKey().rawRepresentation
    boxSecret = Curve25519.KeyAgreement.PrivateKey().rawRepresentation
  }
  init(signSecret: Data, boxSecret: Data) { self.signSecret = signSecret; self.boxSecret = boxSecret }

  var peer: WatchPeerIdentity {
    get throws {
      let sign = try Curve25519.Signing.PrivateKey(rawRepresentation: signSecret).publicKey.rawRepresentation
      return WatchPeerIdentity(id: Data(SHA256.hash(data: sign).prefix(16)).watchBase64, signKey: sign.watchBase64,
        boxKey: try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: boxSecret).publicKey.rawRepresentation.watchBase64)
    }
  }
  func sign(_ text: String) throws -> String {
    try Curve25519.Signing.PrivateKey(rawRepresentation: signSecret).signature(for: Data(text.utf8)).watchBase64
  }
  func pairingProof(_ code: String) throws -> String {
    let identity = try peer
    let secret = SHA256.hash(data: Data("linkshell-pair-code:\(code)".utf8))
    return Data(HMAC<SHA256>.authenticationCode(for: Data("\(identity.id).\(identity.boxKey)".utf8), using: SymmetricKey(data: secret))).watchBase64
  }
}

struct WatchTunnelOpening {
  let identity: WatchIdentity
  let machine: WatchPeerIdentity
  let channel: String
  let ephemeral: Curve25519.KeyAgreement.PrivateKey

  init(identity: WatchIdentity, machine: WatchPeerIdentity, channel: String = UUID().uuidString,
       ephemeral: Curve25519.KeyAgreement.PrivateKey = .init()) throws {
    try machine.validate()
    self.identity = identity; self.machine = machine; self.channel = channel; self.ephemeral = ephemeral
  }
  var hello: [String: Any] {
    get throws {
      let pub = ephemeral.publicKey.rawRepresentation.watchBase64
      return ["k": "hello", "ch": channel, "eph": pub,
        "sig": try identity.sign("linkshell-tunnel-v2:hello:\(channel):\(identity.peer.id):\(machine.id):\(pub)")]
    }
  }
  func accept(_ welcome: [String: Any]) throws -> WatchSecureChannel {
    guard welcome["ch"] as? String == channel, let eph = welcome["eph"] as? String, let sig = welcome["sig"] as? String else { throw WatchLinkError("电脑握手响应无效") }
    let text = "linkshell-tunnel-v2:welcome:\(channel):\(machine.id):\(try identity.peer.id):\(eph)"
    let signing = try Curve25519.Signing.PublicKey(rawRepresentation: Data(watchBase64: machine.signKey))
    guard try signing.isValidSignature(Data(watchBase64: sig), for: Data(text.utf8)) else { throw WatchLinkError("电脑签名不匹配，已拒绝连接") }
    return try derive(remoteEphemeral: eph)
  }
  func derive(remoteEphemeral: String) throws -> WatchSecureChannel {
    let remoteEph = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: Data(watchBase64: remoteEphemeral))
    let remoteStatic = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: Data(watchBase64: machine.boxKey))
    let localStatic = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: identity.boxSecret)
    func shared(_ key: Curve25519.KeyAgreement.PrivateKey, _ pub: Curve25519.KeyAgreement.PublicKey) throws -> Data {
      try key.sharedSecretFromKeyAgreement(with: pub).withUnsafeBytes { Data($0) }
    }
    let ee = try shared(ephemeral, remoteEph), es = try shared(ephemeral, remoteStatic)
    let se = try shared(localStatic, remoteEph), ss = try shared(localStatic, remoteStatic)
    let transcript = Data("linkshell/v2/channel".utf8) + ephemeral.publicKey.rawRepresentation + remoteEph.rawRepresentation + localStatic.publicKey.rawRepresentation + remoteStatic.rawRepresentation
    let keys = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ee + es + se + ss),
      salt: Data(SHA256.hash(data: transcript)), info: Data("linkshell/v2/keys".utf8), outputByteCount: 64).withUnsafeBytes { Data($0) }
    return WatchSecureChannel(sendKey: Data(keys.prefix(32)), receiveKey: Data(keys.suffix(32)))
  }
}

final class WatchSecureChannel {
  private let sendKey: SymmetricKey
  private let receiveKey: SymmetricKey
  private var sent: UInt64 = 0
  private var received: UInt64 = 0

  init(sendKey: Data, receiveKey: Data) {
    // The protocol's XChaCha nonce starts with 16 zero bytes. HChaCha derives
    // an IETF ChaCha key once; CryptoKit performs all AEAD encryption/tag checks.
    self.sendKey = SymmetricKey(data: Self.hchachaZeroNonce(sendKey))
    self.receiveKey = SymmetricKey(data: Self.hchachaZeroNonce(receiveKey))
  }
  private func nonce(_ counter: UInt64) throws -> ChaChaPoly.Nonce {
    var big = counter.bigEndian
    return try ChaChaPoly.Nonce(data: Data(repeating: 0, count: 4) + withUnsafeBytes(of: &big) { Data($0) })
  }
  func seal(_ text: String) throws -> String {
    guard sent < 9_007_199_254_740_991 else { throw WatchLinkError("连接已到期，请重连") }
    sent += 1
    let box = try ChaChaPoly.seal(Data(text.utf8), using: sendKey, nonce: nonce(sent))
    return "\(sent).\((box.ciphertext + box.tag).watchBase64)"
  }
  func open(_ text: String) throws -> String {
    let parts = text.split(separator: ".", maxSplits: 1)
    guard parts.count == 2, let counter = UInt64(parts[0]), counter > received, counter <= 9_007_199_254_740_991 else { throw WatchLinkError("拒绝重复或乱序数据") }
    let data = try Data(watchBase64: String(parts[1]))
    guard data.count >= 16 else { throw WatchLinkError("加密消息无效") }
    let box = try ChaChaPoly.SealedBox(nonce: nonce(counter), ciphertext: data.dropLast(16), tag: data.suffix(16))
    let plain = try ChaChaPoly.open(box, using: receiveKey)
    guard let result = String(data: plain, encoding: .utf8) else { throw WatchLinkError("消息编码无效") }
    received = counter
    return result
  }
  private static func hchachaZeroNonce(_ key: Data) -> Data {
    precondition(key.count == 32)
    let bytes = Array(key)
    var x: [UInt32] = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]
    for i in stride(from: 0, to: 32, by: 4) {
      x.append(UInt32(bytes[i]) | UInt32(bytes[i+1]) << 8 | UInt32(bytes[i+2]) << 16 | UInt32(bytes[i+3]) << 24)
    }
    x += [0, 0, 0, 0]
    func rot(_ value: UInt32, _ n: UInt32) -> UInt32 { (value << n) | (value >> (32 - n)) }
    func quarter(_ a: Int, _ b: Int, _ c: Int, _ d: Int) {
      x[a] = x[a] &+ x[b]; x[d] = rot(x[d] ^ x[a], 16)
      x[c] = x[c] &+ x[d]; x[b] = rot(x[b] ^ x[c], 12)
      x[a] = x[a] &+ x[b]; x[d] = rot(x[d] ^ x[a], 8)
      x[c] = x[c] &+ x[d]; x[b] = rot(x[b] ^ x[c], 7)
    }
    for _ in 0..<10 {
      quarter(0,4,8,12); quarter(1,5,9,13); quarter(2,6,10,14); quarter(3,7,11,15)
      quarter(0,5,10,15); quarter(1,6,11,12); quarter(2,7,8,13); quarter(3,4,9,14)
    }
    var result = Data()
    for index in [0,1,2,3,12,13,14,15] {
      var word = x[index].littleEndian
      result.append(withUnsafeBytes(of: &word) { Data($0) })
    }
    return result
  }
}
