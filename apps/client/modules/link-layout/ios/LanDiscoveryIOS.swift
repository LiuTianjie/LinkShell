import Darwin
import Foundation
import Network

/// Discovers `_linkshell._tcp` LinkShell hosts on the local network via `NWBrowser`
/// (with peer-to-peer mDNS enabled) and resolves host IPs, ports, and TXT metadata (`mid`, `fp`, `name`).
final class LanDiscoveryIOS: NSObject, NetServiceDelegate {
  var onHostsChanged: (([[String: Any]]) -> Void)?

  private let queue = DispatchQueue(label: "com.bd.linkshell.lan-discovery")
  private var browser: NWBrowser?
  private var running = false
  private var recordsByName: [String: HostRecord] = [:]
  private var resolversByName: [String: NetService] = [:]

  private struct HostRecord: Equatable {
    let name: String
    var host: String?
    var port: Int?
    var machineId: String?
    var fingerprint: String?
    var displayName: String?

    var isResolved: Bool {
      guard let host, !host.isEmpty, let port, port > 0 else { return false }
      return true
    }

    func toDictionary() -> [String: Any]? {
      guard let host, !host.isEmpty, let port, port > 0 else { return nil }
      var dict: [String: Any] = [
        "name": name,
        "host": host,
        "port": port,
      ]
      if let machineId, !machineId.isEmpty { dict["machineId"] = machineId }
      if let fingerprint, !fingerprint.isEmpty { dict["fingerprint"] = fingerprint }
      dict["displayName"] = (displayName?.isEmpty == false ? displayName : nil) ?? name
      return dict
    }
  }

  func start() -> Bool {
    queue.sync { () -> Bool in
      guard !running else { return true }
      running = true
      recordsByName.removeAll()
      stopAllResolversLocked()

      let parameters = NWParameters.tcp
      parameters.includePeerToPeer = true
      let descriptor = NWBrowser.Descriptor.bonjourWithTXTRecord(type: "_linkshell._tcp", domain: "local.")
      let browser = NWBrowser(for: descriptor, using: parameters)
      browser.stateUpdateHandler = { [weak self] state in
        guard let self else { return }
        if case .failed = state {
          // Clear browser state synchronously on `queue` and emit an empty snapshot so JS clears
          // stale LAN hosts and can restart discovery cleanly on the next network/foreground transition.
          self.stopLocked()
          self.emitSnapshotLocked()
        }
      }
      browser.browseResultsChangedHandler = { [weak self] results, changes in
        self?.handleBrowseChanges(results: results, changes: changes)
      }
      self.browser = browser
      browser.start(queue: queue)
      return true
    }
  }

  func stop() {
    queue.async { [weak self] in
      self?.stopLocked()
    }
  }

  func currentHosts() -> [[String: Any]] {
    queue.sync {
      snapshotLocked()
    }
  }

  deinit {
    stopLocked()
  }

  private func stopLocked() {
    running = false
    browser?.stateUpdateHandler = nil
    browser?.browseResultsChangedHandler = nil
    browser?.cancel()
    browser = nil
    stopAllResolversLocked()
    recordsByName.removeAll()
  }

  private func stopAllResolversLocked() {
    let services = Array(resolversByName.values)
    resolversByName.removeAll()
    DispatchQueue.main.async {
      for service in services {
        service.delegate = nil
        service.stop()
      }
    }
  }

  private func handleBrowseChanges(results: Set<NWBrowser.Result>, changes: Set<NWBrowser.Result.Change>) {
    guard running else { return }
    var removedNames: [String] = []
    for change in changes {
      if case .removed(let old) = change,
         case .service(let name, _, _, _) = old.endpoint {
        if !results.contains(where: {
          if case .service(let rName, _, _, _) = $0.endpoint { return rName == name }
          return false
        }) {
          removedNames.append(name)
        }
      }
    }

    var changed = false
    for name in removedNames {
      if recordsByName.removeValue(forKey: name) != nil {
        changed = true
      }
      if let service = resolversByName.removeValue(forKey: name) {
        DispatchQueue.main.async {
          service.delegate = nil
          service.stop()
        }
      }
    }

    for result in results {
      guard case .service(let name, let type, let domain, _) = result.endpoint else { continue }
      var txt: [String: String] = [:]
      if case .bonjour(let txtRecord) = result.metadata {
        txt = extractTxt(txtRecord)
      }
      let previous = recordsByName[name]
      var record = previous ?? HostRecord(name: name)
      if let mid = txt["mid"], !mid.isEmpty { record.machineId = mid }
      if let fp = txt["fp"], !fp.isEmpty { record.fingerprint = fp }
      if let display = txt["name"], !display.isEmpty { record.displayName = display }
      if (record.port ?? 0) <= 0, let hp = txt["hostport"].flatMap({ Int($0) }), hp > 0 {
        record.port = hp
      }
      recordsByName[name] = record
      if record != previous && (record.isResolved || previous?.isResolved == true) {
        changed = true
      }

      // Only resolve hosts that do not yet have a resolved IP and port; re-resolving every known
      // host on each browse tick causes redundant mDNS traffic and churn.
      if !record.isResolved && resolversByName[name] == nil {
        let resolver = NetService(domain: domain, type: type, name: name)
        resolver.delegate = self
        resolversByName[name] = resolver
        DispatchQueue.main.async {
          resolver.schedule(in: .main, forMode: .common)
          resolver.resolve(withTimeout: 5.0)
        }
      }
    }

    if changed {
      emitSnapshotLocked()
    }
  }

  func netServiceDidResolveAddress(_ sender: NetService) {
    let serviceName = sender.name
    let addresses = sender.addresses ?? []
    let servicePort = sender.port
    let txtData = sender.txtRecordData()
    sender.delegate = nil
    sender.stop()

    queue.async { [weak self] in
      guard let self else { return }
      self.resolversByName.removeValue(forKey: serviceName)
      guard self.running else { return }

      let ip = Self.selectBestAddress(addresses)
      let txt = txtData.map(Self.decodeTxtData) ?? [:]
      let previous = self.recordsByName[serviceName]
      var record = previous ?? HostRecord(name: serviceName)
      if let ip { record.host = ip }
      if servicePort > 0 {
        record.port = servicePort
      } else if let hp = txt["hostport"].flatMap({ Int($0) }), hp > 0 {
        record.port = hp
      }
      if let mid = txt["mid"], !mid.isEmpty { record.machineId = mid }
      if let fp = txt["fp"], !fp.isEmpty { record.fingerprint = fp }
      if let display = txt["name"], !display.isEmpty { record.displayName = display }
      self.recordsByName[serviceName] = record
      if record != previous {
        self.emitSnapshotLocked()
      }
    }
  }

  func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
    let serviceName = sender.name
    sender.delegate = nil
    sender.stop()
    queue.async { [weak self] in
      self?.resolversByName.removeValue(forKey: serviceName)
    }
  }

  private func snapshotLocked() -> [[String: Any]] {
    recordsByName.values
      .compactMap { $0.toDictionary() }
      .sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
  }

  private func emitSnapshotLocked() {
    let hosts = snapshotLocked()
    DispatchQueue.main.async { [weak self] in
      self?.onHostsChanged?(hosts)
    }
  }

  private func extractTxt(_ txtRecord: NWTXTRecord) -> [String: String] {
    var result: [String: String] = [:]
    for key in ["mid", "fp", "name", "hostport", "v"] {
      if case .string(let value) = txtRecord.getEntry(for: key) {
        result[key] = value
      }
    }
    return result
  }

  private static func decodeTxtData(_ data: Data) -> [String: String] {
    let raw = NetService.dictionary(fromTXTRecord: data)
    var parsed: [String: String] = [:]
    for (key, valueData) in raw {
      if let text = String(data: valueData, encoding: .utf8) {
        parsed[key] = text
      }
    }
    return parsed
  }

  private static func selectBestAddress(_ addresses: [Data]) -> String? {
    var ipv4Candidate: String?
    var ipv6Candidate: String?

    for addrData in addresses {
      addrData.withUnsafeBytes { rawBuffer in
        guard let base = rawBuffer.baseAddress else { return }
        let sockaddrPtr = base.assumingMemoryBound(to: sockaddr.self)
        let family = Int32(sockaddrPtr.pointee.sa_family)
        if family == AF_INET, rawBuffer.count >= MemoryLayout<sockaddr_in>.size {
          var addr4 = base.assumingMemoryBound(to: sockaddr_in.self).pointee.sin_addr
          var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
          if inet_ntop(AF_INET, &addr4, &buffer, socklen_t(INET_ADDRSTRLEN)) != nil {
            let ip = String(cString: buffer)
            if !ip.hasPrefix("127.") && !ip.hasPrefix("169.254.") {
              ipv4Candidate = ipv4Candidate ?? ip
            }
          }
        } else if family == AF_INET6, rawBuffer.count >= MemoryLayout<sockaddr_in6>.size {
          var addr6 = base.assumingMemoryBound(to: sockaddr_in6.self).pointee.sin6_addr
          var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
          if inet_ntop(AF_INET6, &addr6, &buffer, socklen_t(INET6_ADDRSTRLEN)) != nil {
            let ip = String(cString: buffer)
            if ip != "::1" && !ip.lowercased().hasPrefix("fe80:") {
              ipv6Candidate = ipv6Candidate ?? ip
            }
          }
        }
      }
    }
    return ipv4Candidate ?? ipv6Candidate
  }
}
