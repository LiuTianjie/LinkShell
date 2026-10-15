import Foundation

/// Which local addresses are worth offering as ICE host candidates.
///
/// A Mac with OrbStack, Docker or several VPNs has many interfaces, and most of
/// them carry a private `192.168.x` / `10.x` address that looks on paper like a
/// home network but reaches no phone: the bridges those tools make for their own
/// containers, and point-to-point tunnels. libwebrtc gathers a host candidate on
/// every one of them, so the offer carries ten-odd candidates of which one is the
/// real LAN. The phone then pairs its own candidates against all of them, and the
/// useless ones only slow the check down — on this developer's Mac the real path
/// was found, but a run that stalled had the same crowd of candidates in it.
///
/// So host candidates on an interface known to be virtual are dropped before the
/// offer. The real Wi-Fi/Ethernet (`en*`) and Tailscale (`utun*` carrying a CGNAT
/// `100.64/10` address) are kept; reflexive candidates, which already carry the
/// public address, are never touched. The map is read once per session: an
/// interface appearing mid-call is rare and costs only one stale candidate.
enum Networks {
  /// Interface-name prefixes whose addresses never reach a phone: the virtual
  /// bridges container tooling makes, and link-local helpers.
  private static let virtualPrefixes = ["bridge", "awdl", "llw", "anpi", "ap", "vmenet", "vnic"]

  /// address → interface name, for the IPv4 and IPv6 addresses on this host now.
  private static func addressesToInterfaces() -> [String: String] {
    var map: [String: String] = [:]
    var head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0 else { return map }
    defer { freeifaddrs(head) }
    var pointer = head
    while let current = pointer {
      defer { pointer = current.pointee.ifa_next }
      let name = String(cString: current.pointee.ifa_name)
      guard let addr = current.pointee.ifa_addr else { continue }
      let family = addr.pointee.sa_family
      guard family == sa_family_t(AF_INET) || family == sa_family_t(AF_INET6) else { continue }
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      guard getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
      // getnameinfo writes a link-local IPv6 as "fe80::1%en0"; the candidate's SDP has no zone.
      let text = String(cString: host)
      map[text.split(separator: "%").first.map(String.init) ?? text] = name
    }
    return map
  }

  /// The addresses that sit on a virtual interface, so a host candidate on one can be recognised.
  static func virtualAddresses() -> Set<String> {
    var result: Set<String> = []
    for (address, name) in addressesToInterfaces() where isVirtual(name) {
      result.insert(address.lowercased())
    }
    return result
  }

  static func isVirtual(_ interface: String) -> Bool {
    virtualPrefixes.contains { interface.hasPrefix($0) }
  }

  /// The IP in an ICE candidate's SDP (`candidate:<foundation> <component> <transport>
  /// <priority> <ip> <port> typ <type> …`), lowercased; nil if it doesn't parse.
  static func candidateAddress(_ sdp: String) -> String? {
    let fields = sdp.split(separator: " ")
    guard fields.count >= 5 else { return nil }
    return String(fields[4]).lowercased()
  }

  /// Whether this candidate should be dropped: a host candidate whose address is on a virtual
  /// interface. A relayed-through-STUN (`srflx`) or any non-host candidate is always kept.
  static func isUselessHost(_ sdp: String, virtual: Set<String>) -> Bool {
    guard sdp.contains(" typ host"), let address = candidateAddress(sdp) else { return false }
    return virtual.contains(address)
  }
}
