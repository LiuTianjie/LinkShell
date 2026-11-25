package expo.modules.linklayout

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Rect
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.view.OrientationEventListener
import android.view.Surface
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo
import androidx.window.layout.WindowMetricsCalculator
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.lang.ref.WeakReference
import java.util.Locale
import kotlin.math.abs

class LinkLayoutModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val moduleScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

  private var speech: SpeechInput? = null
  private var tts: TextToSpeech? = null
  private var ttsReady = false
  private var pendingTts: Pair<String, String?>? = null
  private var listener: OrientationEventListener? = null
  private var requestedActivity: WeakReference<Activity>? = null
  private var previousOrientation: Int? = null
  private var orientationReleaseTask: Runnable? = null
  private var fullscreenActivity: WeakReference<Activity>? = null
  private var fullscreenOrientation: Int? = null
  private var lanDiscovery: LanDiscoveryAndroid? = null

  private var connectivityManager: ConnectivityManager? = null
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private var lastNetworkSignature: String? = null
  private var pendingNetworkEmit: Runnable? = null

  private var windowInfoJob: Job? = null
  private var windowInfoActivity: WeakReference<Activity>? = null
  private var lastWindowLayoutInfo: WindowLayoutInfo? = null
  private var lastLayoutMetrics: Map<String, Any>? = null

  companion object {
    private const val STATUS_NOTIFICATION_ID = ActiveSessionForegroundService.STATUS_NOTIFICATION_ID
    private const val NOTIFICATION_PERMISSION_REQUEST_CODE = 4211
    private const val NOTIFICATION_PREFS = "linkshell_notification_prefs"
    private const val KEY_PERMISSION_REQUESTED = "post_notifications_requested"
    private const val NETWORK_DEBOUNCE_MS = 300L
    private const val RESTORE_ORIENTATION_RELEASE_MS = 1500L
  }

  override fun definition() = ModuleDefinition {
    Name("LinkLayout")
    Events(
      "onSpeechResult",
      "onSpeechLevel",
      "onSpeechError",
      "onNotificationAction",
      "onLanHosts",
      "onNetworkPathChange",
      "onAndroidLayoutMetrics",
    )
    OnCreate {
      NotificationActionQueue.onActionEnqueued = { id ->
        sendEvent("onNotificationAction", mapOf("id" to id))
      }
      val context = appContext.reactContext
      val initialIntent = appContext.currentActivity?.intent
      if (context != null && initialIntent != null) {
        NotificationActionQueue.extractFromIntent(context, initialIntent)
      }
      if (context != null) {
        registerNetworkPathMonitor(context)
      }
      appContext.currentActivity?.let { activity ->
        onMain { ensureWindowInfoCollector(activity) }
      }
    }
    OnActivityEntersForeground {
      appContext.currentActivity?.let { activity ->
        onMain { ensureWindowInfoCollector(activity) }
      }
    }
    OnNewIntent { intent ->
      val context = appContext.reactContext ?: return@OnNewIntent
      NotificationActionQueue.extractFromIntent(context, intent)
    }
    AsyncFunction("startSpeech") { localeId: String? ->
      val input = speech ?: SpeechInput(appContext.reactContext ?: throw Exceptions.ReactContextLost()) { event, body -> sendEvent(event, body) }.also { speech = it }
      input.start(localeId)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("stopSpeech") { promise: Promise ->
      val input = speech
      if (input == null) promise.resolve(mapOf("text" to "")) else input.stop(promise)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("cancelSpeech") { speech?.cancel() }.runOnQueue(Queues.MAIN)
    AsyncFunction("speakText") { text: String, localeId: String? ->
      speakText(text, localeId)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("stopSpeaking") {
      pendingTts = null
      tts?.stop()
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("areNotificationsEnabled") {
      val context = appContext.reactContext ?: return@AsyncFunction false
      NotificationManagerCompat.from(context).areNotificationsEnabled()
    }
    AsyncFunction("ensureNotificationPermission") {
      ensureNotificationPermission()
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("syncStatusNotification") { payload: Map<String, Any?> ->
      syncStatusNotification(payload)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("cancelStatusNotification") {
      cancelStatusNotification()
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("pendingNotificationActionId") {
      val context = appContext.reactContext ?: return@AsyncFunction null
      NotificationActionQueue.pendingId(context)
    }
    AsyncFunction("consumeNotificationAction") { id: String ->
      val context = appContext.reactContext ?: return@AsyncFunction null
      NotificationActionQueue.consume(context, id)
    }
    AsyncFunction("startLanDiscovery") {
      startLanDiscovery()
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("stopLanDiscovery") {
      lanDiscovery?.stop()
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("getLanHosts") {
      lanDiscovery?.getHosts() ?: emptyList<Map<String, Any?>>()
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("requestAndroidLayoutMetrics") {
      requestAndroidLayoutMetrics()
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("requestLandscape") { requestLandscape() }.runOnQueue(Queues.MAIN)
    AsyncFunction("clearOrientationRequest") { restoreOrientation() }.runOnQueue(Queues.MAIN)
    OnActivityEntersBackground {
      onMain {
        fullscreenOrientation = null
        fullscreenActivity = null
        clearRequest()
        speech?.cancel()
      }
    }
    OnActivityDestroys {
      onMain {
        stopWindowInfoCollector()
      }
    }
    OnDestroy {
      NotificationActionQueue.onActionEnqueued = null
      unregisterNetworkPathMonitor()
      lanDiscovery?.destroy()
      lanDiscovery = null
      moduleScope.cancel()
      onMain {
        stopWindowInfoCollector()
        fullscreenOrientation = null
        fullscreenActivity = null
        clearRequest()
        speech?.cancel()
        speech = null
        pendingTts = null
        tts?.stop()
        tts?.shutdown()
        tts = null
        ttsReady = false
      }
    }
  }

  private fun speakText(text: String, localeId: String?) {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return
    val context = appContext.reactContext ?: return
    if (tts == null) {
      pendingTts = Pair(trimmed, localeId)
      tts = TextToSpeech(context.applicationContext) { status ->
        onMain {
          ttsReady = status == TextToSpeech.SUCCESS
          val queued = pendingTts
          pendingTts = null
          if (ttsReady && queued != null) {
            dispatchTts(queued.first, queued.second)
          }
        }
      }
      return
    }
    if (!ttsReady) {
      pendingTts = Pair(trimmed, localeId)
      return
    }
    dispatchTts(trimmed, localeId)
  }

  private fun dispatchTts(text: String, localeId: String?) {
    val engine = tts ?: return
    val locale = if (!localeId.isNullOrBlank()) Locale.forLanguageTag(localeId) else Locale.getDefault()
    engine.language = locale
    engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "linkshell-summary")
  }

  private fun startLanDiscovery(): Boolean {
    val context = appContext.reactContext ?: return false
    val discovery = lanDiscovery ?: LanDiscoveryAndroid(context) { hosts ->
      sendEvent("onLanHosts", mapOf("hosts" to hosts))
    }.also { lanDiscovery = it }
    return discovery.start()
  }

  private fun ensureNotificationPermission(): Boolean {
    val context = appContext.reactContext ?: return false
    val enabled = NotificationManagerCompat.from(context).areNotificationsEnabled()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      return enabled
    }
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
      return enabled
    }
    val prefs = context.applicationContext.getSharedPreferences(NOTIFICATION_PREFS, Context.MODE_PRIVATE)
    if (prefs.getBoolean(KEY_PERMISSION_REQUESTED, false)) {
      return false
    }
    val activity = appContext.currentActivity ?: return false
    prefs.edit().putBoolean(KEY_PERMISSION_REQUESTED, true).apply()
    runCatching {
      ActivityCompat.requestPermissions(
        activity,
        arrayOf(Manifest.permission.POST_NOTIFICATIONS),
        NOTIFICATION_PERMISSION_REQUEST_CODE,
      )
    }
    return false
  }

  private fun registerNetworkPathMonitor(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
    val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
    if (networkCallback != null) return
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        val caps = runCatching { cm.getNetworkCapabilities(network) }.getOrNull()
        scheduleNetworkPathUpdate(network.toString(), caps)
      }

      override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
        scheduleNetworkPathUpdate(network.toString(), networkCapabilities)
      }

      override fun onLost(network: Network) {
        val active = runCatching { cm.activeNetwork }.getOrNull()
        val caps = active?.let { runCatching { cm.getNetworkCapabilities(it) }.getOrNull() }
        scheduleNetworkPathUpdate(active?.toString() ?: "none", caps)
      }
    }
    runCatching {
      cm.registerDefaultNetworkCallback(callback)
      connectivityManager = cm
      networkCallback = callback
    }
  }

  private fun unregisterNetworkPathMonitor() {
    pendingNetworkEmit?.let { mainHandler.removeCallbacks(it) }
    pendingNetworkEmit = null
    val cm = connectivityManager
    val cb = networkCallback
    connectivityManager = null
    networkCallback = null
    lastNetworkSignature = null
    if (cm != null && cb != null) {
      runCatching { cm.unregisterNetworkCallback(cb) }
    }
  }

  private fun scheduleNetworkPathUpdate(networkId: String, caps: NetworkCapabilities?) {
    val hasInternet = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    val status = if (hasInternet) "satisfied" else "unsatisfied"
    val iface = when {
      !hasInternet -> "none"
      caps!!.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
      caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "wired"
      caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
      else -> "other"
    }
    val isExpensive = caps != null && !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    val signature = "$status|$iface|$isExpensive|$networkId"

    onMain {
      if (networkCallback == null) return@onMain
      // Record the initial active network without firing a redundant reconnect on cold start.
      if (lastNetworkSignature == null) {
        lastNetworkSignature = signature
        return@onMain
      }
      if (signature == lastNetworkSignature) return@onMain
      lastNetworkSignature = signature

      pendingNetworkEmit?.let { mainHandler.removeCallbacks(it) }
      val payload = mapOf(
        "status" to status,
        "interface" to iface,
        "isExpensive" to isExpensive,
        "isConstrained" to false,
      )
      val task = Runnable {
        pendingNetworkEmit = null
        if (networkCallback != null) {
          sendEvent("onNetworkPathChange", payload)
        }
      }
      pendingNetworkEmit = task
      mainHandler.postDelayed(task, NETWORK_DEBOUNCE_MS)
    }
  }

  private fun ensureWindowInfoCollector(activity: Activity) {
    if (windowInfoActivity?.get() === activity && windowInfoJob?.isActive == true) return
    stopWindowInfoCollector()
    windowInfoActivity = WeakReference(activity)
    windowInfoJob = moduleScope.launch {
      runCatching {
        WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity).collect { info ->
          lastWindowLayoutInfo = info
          emitAndroidLayoutMetrics(activity, info, force = false)
        }
      }
    }
  }

  private fun stopWindowInfoCollector() {
    windowInfoJob?.cancel()
    windowInfoJob = null
    windowInfoActivity = null
    lastWindowLayoutInfo = null
    lastLayoutMetrics = null
  }

  private fun requestAndroidLayoutMetrics(): Map<String, Any>? {
    val activity = appContext.currentActivity ?: return lastLayoutMetrics
    ensureWindowInfoCollector(activity)
    return emitAndroidLayoutMetrics(activity, lastWindowLayoutInfo, force = true)
  }

  private fun emitAndroidLayoutMetrics(
    activity: Activity,
    info: WindowLayoutInfo?,
    force: Boolean,
  ): Map<String, Any>? {
    val metrics = buildAndroidLayoutMetrics(activity, info) ?: return null
    if (!force && metrics == lastLayoutMetrics) return metrics
    lastLayoutMetrics = metrics
    sendEvent("onAndroidLayoutMetrics", metrics)
    return metrics
  }

  private fun buildAndroidLayoutMetrics(activity: Activity, info: WindowLayoutInfo?): Map<String, Any>? {
    val density = activity.resources.displayMetrics.density.coerceAtLeast(1f)
    val bounds = runCatching {
      WindowMetricsCalculator.getOrCreate().computeCurrentWindowMetrics(activity).bounds
    }.getOrElse {
      val decor = activity.window?.decorView ?: return null
      Rect(0, 0, decor.width, decor.height)
    }
    if (bounds.width() <= 0 || bounds.height() <= 0) return null

    val rawInsets = activity.window?.decorView?.let { ViewCompat.getRootWindowInsets(it) }
    val systemInsets = rawInsets?.getInsets(
      WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
    )
    val insetsMap = mapOf(
      "top" to ((systemInsets?.top ?: 0) / density).toDouble(),
      "right" to ((systemInsets?.right ?: 0) / density).toDouble(),
      "bottom" to ((systemInsets?.bottom ?: 0) / density).toDouble(),
      "left" to ((systemInsets?.left ?: 0) / density).toDouble(),
    )

    val divisions = (info?.displayFeatures ?: emptyList()).mapNotNull { feature ->
      val fold = feature as? FoldingFeature ?: return@mapNotNull null
      val rect = fold.bounds
      mapOf(
        "x" to (rect.left / density).toDouble(),
        "y" to (rect.top / density).toDouble(),
        "width" to (rect.width() / density).toDouble(),
        "height" to (rect.height() / density).toDouble(),
        "active" to (fold.isSeparating || fold.state == FoldingFeature.State.HALF_OPENED),
      )
    }

    return mapOf(
      "width" to (bounds.width() / density).toDouble(),
      "height" to (bounds.height() / density).toDouble(),
      "insets" to insetsMap,
      "divisions" to divisions,
      "occlusions" to emptyList<Map<String, Any>>(),
    )
  }

  private fun syncStatusNotification(payload: Map<String, Any?>): Boolean {
    val context = appContext.reactContext ?: return false
    val active = payload["active"] as? Boolean ?: false
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return false
    if (!active) {
      ActiveSessionForegroundService.stop(context, removeNotification = true)
      manager.cancel(STATUS_NOTIFICATION_ID)
      return true
    }
    ActiveSessionForegroundService.ensureChannels(context)
    val urgent = payload["urgent"] as? Boolean ?: false
    val ongoing = payload["ongoing"] as? Boolean ?: false
    val foregroundService = payload["foregroundService"] as? Boolean ?: false
    val title = (payload["title"] as? String)?.takeIf { it.isNotBlank() } ?: "LinkShell"
    val subtitle = (payload["subtitle"] as? String) ?: ""
    val computerName = (payload["computerName"] as? String)?.takeIf { it.isNotBlank() }
    val deepLink = (payload["deepLink"] as? String)?.takeIf { it.startsWith("linkshell") } ?: "linkshell:///"
    val actionsJson = ActiveSessionForegroundService.actionsToJson(payload["actions"] as? List<*>)

    if (foregroundService) {
      if (ActiveSessionForegroundService.startOrUpdate(
          context = context,
          title = title,
          subtitle = subtitle,
          computerName = computerName,
          urgent = urgent,
          ongoing = ongoing,
          deepLink = deepLink,
          actionsJson = actionsJson,
        )
      ) {
        return true
      }
    } else if (ActiveSessionForegroundService.isRunning) {
      // Detach rather than remove so the replacement regular notification appears seamlessly.
      ActiveSessionForegroundService.stop(context, removeNotification = false)
    }

    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) {
      return false
    }

    val notification = ActiveSessionForegroundService.buildNotification(
      context = context,
      title = title,
      subtitle = subtitle,
      computerName = computerName,
      urgent = urgent,
      ongoing = ongoing,
      deepLink = deepLink,
      actionsJson = actionsJson,
    )
    runCatching { manager.notify(STATUS_NOTIFICATION_ID, notification) }
    return true
  }

  private fun cancelStatusNotification() {
    val context = appContext.reactContext ?: return
    ActiveSessionForegroundService.stop(context, removeNotification = true)
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    manager.cancel(STATUS_NOTIFICATION_ID)
  }

  private fun onMain(action: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) action()
    else mainHandler.post { action() }
  }

  private fun requestLandscape() {
    if (fullscreenOrientation != null) return
    clearRequest()
    val activity = appContext.currentActivity ?: throw Exceptions.MissingActivity()
    fullscreenActivity = WeakReference(activity)
    fullscreenOrientation = interfaceOrientation(activity)
    if (activity.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) return
    requestOnce(activity, ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, autoReleaseMs = 0L)
  }

  private fun restoreOrientation() {
    val orientation = fullscreenOrientation ?: return
    val activity = fullscreenActivity?.get()
    fullscreenOrientation = null
    fullscreenActivity = null
    clearRequest()
    if (activity != null && interfaceOrientation(activity) != orientation) {
      // One-shot restore: release back to the previous (unspecified/sensor) policy after settling
      // so devices lying flat or without an accelerometer never stay locked in portrait.
      requestOnce(activity, orientation, autoReleaseMs = RESTORE_ORIENTATION_RELEASE_MS)
    }
  }

  @Suppress("DEPRECATION")
  private fun interfaceOrientation(activity: Activity): Int {
    val rotation = activity.windowManager.defaultDisplay.rotation
    val portrait = activity.resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT
    val naturalPortrait = if (rotation == Surface.ROTATION_0 || rotation == Surface.ROTATION_180) portrait else !portrait
    val orientations = if (naturalPortrait) intArrayOf(
      ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE,
      ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT, ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE
    ) else intArrayOf(
      ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE, ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT,
      ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE, ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    )
    return orientations[rotation]
  }

  private fun requestOnce(activity: Activity, orientation: Int, autoReleaseMs: Long) {
    requestedActivity = WeakReference(activity)
    previousOrientation = activity.requestedOrientation
    var initialQuadrant: Int? = null
    val tracker = object : OrientationEventListener(activity) {
      override fun onOrientationChanged(angle: Int) {
        if (listener !== this || angle == ORIENTATION_UNKNOWN) return
        val quadrant = ((angle + 45) / 90) % 4
        val distance = abs(angle - quadrant * 90).let { minOf(it, 360 - it) }
        if (distance > 20) return
        if (initialQuadrant == null) initialQuadrant = quadrant
        // Android has no one-shot scene request. Hand control back to the system
        // on the next physical turn, including a return to portrait.
        else if (quadrant != initialQuadrant) clearRequest()
      }
    }
    if (tracker.canDetectOrientation()) {
      listener = tracker
      tracker.enable()
    }
    activity.requestedOrientation = orientation
    if (autoReleaseMs > 0L) {
      val release = Runnable { clearRequest() }
      orientationReleaseTask = release
      mainHandler.postDelayed(release, autoReleaseMs)
    }
  }

  private fun clearRequest() {
    orientationReleaseTask?.let { mainHandler.removeCallbacks(it) }
    orientationReleaseTask = null
    listener?.disable()
    listener = null
    val activity = requestedActivity?.get()
    previousOrientation?.let { activity?.requestedOrientation = it }
    previousOrientation = null
    requestedActivity = null
  }
}
