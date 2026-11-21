package expo.modules.linklayout

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.annotation.RequiresApi
import java.net.Inet4Address
import java.net.InetAddress
import java.util.concurrent.Executors

/**
 * Discovers `_linkshell._tcp.` hosts on the local network using Android NsdManager, parsing TXT
 * attributes (`mid`, `name`, `fp`, `hostport`) and emitting deduplicated hosts as changes arrive.
 */
internal class LanDiscoveryAndroid(
  context: Context,
  private val onHostsChanged: (List<Map<String, Any?>>) -> Unit,
) {
  companion object {
    private const val SERVICE_TYPE = "_linkshell._tcp."
    private const val LEGACY_RESOLVE_TIMEOUT_MS = 4000L
  }

  private val appContext = context.applicationContext
  private val nsdManager = appContext.getSystemService(Context.NSD_SERVICE) as? NsdManager
  private val wifiManager = appContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
  private val lock = Any()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val callbackExecutor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "LinkShellLanDiscovery")
  }

  private var multicastLock: WifiManager.MulticastLock? = null
  private var discoveryListener: NsdManager.DiscoveryListener? = null
  private var running = false

  private val hosts = LinkedHashMap<String, Map<String, Any?>>()
  private val api34Callbacks = LinkedHashMap<String, Any>()

  // Pre-API 34 NsdManager rejects overlapping resolveService calls, so queue them one by one.
  private val resolveQueue = ArrayDeque<NsdServiceInfo>()
  private var resolving = false
  private var resolveGeneration = 0L

  fun start(): Boolean {
    synchronized(lock) {
      if (running) return nsdManager != null
      val manager = nsdManager ?: return false
      running = true
      hosts.clear()
      acquireMulticastLock()

      val listener = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(regType: String) {}

        override fun onServiceFound(serviceInfo: NsdServiceInfo) {
          if (!isRunning()) return
          if (!serviceInfo.serviceType.contains("_linkshell._tcp")) return
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            registerServiceCallbackApi34(manager, serviceInfo)
          } else {
            enqueueLegacyResolve(serviceInfo)
          }
        }

        override fun onServiceLost(serviceInfo: NsdServiceInfo) {
          removeHost(serviceInfo.serviceName)
        }

        override fun onDiscoveryStopped(serviceType: String) {}

        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
          synchronized(lock) {
            if (discoveryListener === this) {
              discoveryListener = null
            }
            running = false
          }
          releaseMulticastLock()
        }

        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
      }

      discoveryListener = listener
      return runCatching {
        manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        true
      }.getOrElse {
        discoveryListener = null
        running = false
        releaseMulticastLock()
        false
      }
    }
  }

  fun stop() {
    val listener: NsdManager.DiscoveryListener?
    val callbacksToUnregister: List<Any>
    synchronized(lock) {
      running = false
      resolveGeneration += 1L
      resolving = false
      resolveQueue.clear()
      hosts.clear()
      listener = discoveryListener
      discoveryListener = null
      callbacksToUnregister = api34Callbacks.values.toList()
      api34Callbacks.clear()
    }

    val manager = nsdManager
    if (manager != null) {
      if (listener != null) {
        runCatching { manager.stopServiceDiscovery(listener) }
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        for (callback in callbacksToUnregister) {
          runCatching { unregisterServiceCallbackApi34(manager, callback) }
        }
      }
    }
    releaseMulticastLock()
  }

  fun destroy() {
    stop()
    runCatching { callbackExecutor.shutdownNow() }
  }

  fun getHosts(): List<Map<String, Any?>> {
    synchronized(lock) {
      return hosts.values.toList()
    }
  }

  private fun isRunning(): Boolean = synchronized(lock) { running }

  @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
  private fun registerServiceCallbackApi34(manager: NsdManager, serviceInfo: NsdServiceInfo) {
    val name = serviceInfo.serviceName ?: return
    val callback = object : NsdManager.ServiceInfoCallback {
      override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) {}

      override fun onServiceUpdated(updated: NsdServiceInfo) {
        if (!isRunning()) return
        upsertResolvedService(updated)
      }

      override fun onServiceLost() {
        removeHost(name)
      }

      override fun onServiceInfoCallbackUnregistered() {}
    }

    val previous: Any?
    synchronized(lock) {
      if (!running) return
      previous = api34Callbacks.put(name, callback)
    }
    if (previous != null) {
      runCatching { unregisterServiceCallbackApi34(manager, previous) }
    }
    runCatching {
      manager.registerServiceInfoCallback(serviceInfo, callbackExecutor, callback)
    }
  }

  @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
  private fun unregisterServiceCallbackApi34(manager: NsdManager, callback: Any) {
    (callback as? NsdManager.ServiceInfoCallback)?.let {
      manager.unregisterServiceInfoCallback(it)
    }
  }

  private fun enqueueLegacyResolve(serviceInfo: NsdServiceInfo) {
    val shouldStart: Boolean
    synchronized(lock) {
      if (!running) return
      val name = serviceInfo.serviceName
      if (resolveQueue.none { it.serviceName == name }) {
        resolveQueue.addLast(serviceInfo)
      }
      shouldStart = !resolving
      if (shouldStart) {
        resolving = true
      }
    }
    if (shouldStart) {
      pumpLegacyResolveQueue()
    }
  }

  @Suppress("DEPRECATION")
  private fun pumpLegacyResolveQueue() {
    val next: NsdServiceInfo?
    val generation: Long
    synchronized(lock) {
      if (!running || resolveQueue.isEmpty()) {
        resolving = false
        return
      }
      next = resolveQueue.removeFirst()
      resolveGeneration += 1L
      generation = resolveGeneration
    }

    val manager = nsdManager ?: run {
      synchronized(lock) { resolving = false }
      return
    }

    val timeoutTask = Runnable {
      val advance: Boolean
      synchronized(lock) {
        advance = running && resolving && resolveGeneration == generation
      }
      if (advance) {
        pumpLegacyResolveQueue()
      }
    }
    mainHandler.postDelayed(timeoutTask, LEGACY_RESOLVE_TIMEOUT_MS)

    runCatching {
      manager.resolveService(
        next,
        object : NsdManager.ResolveListener {
          override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
            mainHandler.removeCallbacks(timeoutTask)
            val advance: Boolean
            synchronized(lock) {
              advance = running && resolveGeneration == generation
            }
            if (advance) {
              pumpLegacyResolveQueue()
            }
          }

          override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
            mainHandler.removeCallbacks(timeoutTask)
            val current: Boolean
            synchronized(lock) {
              current = running && resolveGeneration == generation
            }
            if (current) {
              upsertResolvedService(serviceInfo)
              pumpLegacyResolveQueue()
            }
          }
        },
      )
    }.onFailure {
      mainHandler.removeCallbacks(timeoutTask)
      if (isRunning()) {
        pumpLegacyResolveQueue()
      }
    }
  }

  private fun upsertResolvedService(serviceInfo: NsdServiceInfo) {
    val name = serviceInfo.serviceName?.takeIf { it.isNotEmpty() } ?: return
    val addresses: List<InetAddress> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      serviceInfo.hostAddresses
    } else {
      @Suppress("DEPRECATION")
      listOfNotNull(serviceInfo.host)
    }
    val preferredHost = selectHostAddress(addresses) ?: return

    val attributes = readTxtAttributes(serviceInfo.attributes)
    val port = if (serviceInfo.port > 0) {
      serviceInfo.port
    } else {
      attributes["hostport"]?.toIntOrNull()?.takeIf { it > 0 } ?: return
    }

    val entry: Map<String, Any?> = mapOf(
      "name" to name,
      "host" to preferredHost,
      "port" to port,
      "machineId" to attributes["mid"]?.takeIf { it.isNotEmpty() },
      "fingerprint" to attributes["fp"]?.takeIf { it.isNotEmpty() },
      "displayName" to (attributes["name"]?.takeIf { it.isNotEmpty() } ?: name),
    )

    val snapshot: List<Map<String, Any?>>
    synchronized(lock) {
      if (!running) return
      hosts[name] = entry
      snapshot = hosts.values.toList()
    }
    emitHosts(snapshot)
  }

  private fun removeHost(serviceName: String?) {
    if (serviceName.isNullOrEmpty()) return
    val callbackToUnregister: Any?
    val snapshot: List<Map<String, Any?>>?
    synchronized(lock) {
      callbackToUnregister = api34Callbacks.remove(serviceName)
      val removed = hosts.remove(serviceName) != null
      snapshot = if (removed) hosts.values.toList() else null
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && callbackToUnregister != null) {
      nsdManager?.let { runCatching { unregisterServiceCallbackApi34(it, callbackToUnregister) } }
    }
    if (snapshot != null) {
      emitHosts(snapshot)
    }
  }

  private fun emitHosts(snapshot: List<Map<String, Any?>>) {
    mainHandler.post {
      onHostsChanged(snapshot)
    }
  }

  private fun selectHostAddress(addresses: List<InetAddress>): String? {
    if (addresses.isEmpty()) return null
    val ipv4 = addresses.firstOrNull { it is Inet4Address && !it.isLoopbackAddress && !it.isLinkLocalAddress }
      ?: addresses.firstOrNull { it is Inet4Address && !it.isLoopbackAddress }
    val chosen = ipv4 ?: addresses.firstOrNull { !it.isLoopbackAddress && !it.isLinkLocalAddress } ?: addresses.firstOrNull()
    return chosen?.hostAddress?.substringBefore('%')?.takeIf { it.isNotEmpty() }
  }

  private fun readTxtAttributes(raw: Map<String, ByteArray?>?): Map<String, String> {
    if (raw.isNullOrEmpty()) return emptyMap()
    val parsed = HashMap<String, String>(raw.size)
    for ((key, value) in raw) {
      if (value != null) {
        parsed[key] = String(value, Charsets.UTF_8)
      }
    }
    return parsed
  }

  private fun acquireMulticastLock() {
    runCatching {
      if (multicastLock == null) {
        multicastLock = wifiManager?.createMulticastLock("LinkShellLanDiscovery")?.apply {
          setReferenceCounted(false)
        }
      }
      if (multicastLock?.isHeld == false) {
        multicastLock?.acquire()
      }
    }
  }

  private fun releaseMulticastLock() {
    runCatching {
      if (multicastLock?.isHeld == true) {
        multicastLock?.release()
      }
    }
  }
}
