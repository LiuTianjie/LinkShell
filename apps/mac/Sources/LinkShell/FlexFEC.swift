import Foundation

/// SDP evidence for the single video stream we send. Advertising a codec alone does not make
/// M154 send FlexFEC: the answer must accept it and the offer must bind a repair SSRC with FEC-FR.
enum FlexFEC {
  struct Negotiation {
    let state: String
    let payloadType: Int?
    let mediaSSRC: UInt32?
    let repairSSRC: UInt32?

    var json: [String: Any] {
      ["state": state, "payloadType": payloadType as Any? ?? NSNull(),
       "mediaSSRC": mediaSSRC as Any? ?? NSNull(), "repairSSRC": repairSSRC as Any? ?? NSNull()]
    }
  }

  static func negotiation(offer: String?, answer: String?) -> Negotiation {
    let sent = VideoSection(offer ?? "")
    let received = VideoSection(answer ?? "")
    let payloadType = sent.payloads.first { sent.flexfec.contains($0) && received.flexfec.contains($0) && received.payloads.contains($0) }
    let group = sent.group
    let state: String
    if !sent.payloads.contains(where: { sent.flexfec.contains($0) }) {
      state = "not-offered"
    } else if answer == nil {
      state = "awaiting-answer"
    } else if !received.active || payloadType == nil {
      state = "declined"
    } else if group == nil {
      state = "missing-ssrc"
    } else {
      state = "negotiated"
    }
    return Negotiation(state: state, payloadType: payloadType, mediaSSRC: group?.0, repairSSRC: group?.1)
  }

  private struct VideoSection {
    var active = false
    var payloads: [Int] = []
    var flexfec: Set<Int> = []
    var group: (UInt32, UInt32)?

    init(_ sdp: String) {
      var video = false
      for line in sdp.split(whereSeparator: \.isNewline).map(String.init) {
        if line.hasPrefix("m=") {
          if video { break }
          video = line.hasPrefix("m=video ")
          if video {
            let fields = line.split(separator: " ")
            active = fields.count > 3 && fields[1] != "0"
            payloads = fields.dropFirst(3).compactMap { Int($0) }
          }
        }
        guard video else { continue }
        if line == "a=inactive" || line == "a=sendonly" { active = false }
        if line.hasPrefix("a=rtpmap:") {
          let fields = line.dropFirst(9).split(separator: " ")
          if fields.count == 2, fields[1].lowercased() == "flexfec-03/90000", let payload = Int(fields[0]) {
            flexfec.insert(payload)
          }
        }
        if line.hasPrefix("a=ssrc-group:FEC-FR ") {
          let values = line.dropFirst(20).split(separator: " ").compactMap { UInt32($0) }
          if values.count == 2, values[0] != 0, values[1] != 0, values[0] != values[1] { group = (values[0], values[1]) }
        }
      }
    }
  }
}
