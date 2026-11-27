package expo.modules.linkscreen

import android.app.Activity
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.json.JSONObject
import org.webrtc.EglBase
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Hosts Android hardware WebRTC video (`SurfaceViewRenderer`) underneath the transparent React
 * Native viewer `WebView`, bridging viewer pointer/keyboard controls directly to `ScreenConnectionAndroid`.
 */
class LinkScreenView(
  context: Context,
  appContext: AppContext,
) : ExpoView(context, appContext) {

  val onState by EventDispatcher()

  private val mainHandler = Handler(Looper.getMainLooper())
  private val rendererContainer = FrameLayout(context)

  private var eglBase: EglBase? = null
  private var renderer: SurfaceViewRenderer? = null
  private var connection: ScreenConnectionAndroid? = null

  private var url: String = ""
  private var expectedPort: Int = -1
  private var maxFps: Int = 120
  private var active: Boolean = true
  private var audio: Boolean = false
  private var audioAvailable: Boolean = false
  private var applicationActive: Boolean = true
  private var supportsConfiguration: Boolean = false
  private var supportsPause: Boolean = false
  private var controlsReady: Boolean = false
  private val pendingMessages = ArrayList<JSONObject>()
  private var latestStats: JSONObject? = null
  private var disposed: Boolean = false

  private var lastPictureWidth: Int = 0
  private var lastPictureHeight: Int = 0
  private var firstFrameSeen: Boolean = false
  private var reportedPictureWidth: Int = 0
  private var reportedPictureHeight: Int = 0
  private var pictureRectCss: PictureRect? = null

  private var attachedWebView: WebView? = null
  private var documentStartScript: ScriptHandler? = null
  private var reloadedForBridge: Boolean = false
  private var attachStartMs: Long = 0L
  private var attachRunnable: Runnable? = null

  private data class PictureRect(val x: Double, val y: Double, val w: Double, val h: Double)

  private inner class AndroidScreenBridge {
    @JavascriptInterface
    fun postMessage(rawJson: String) {
      mainHandler.post {
        if (disposed) return@post
        val webView = attachedWebView ?: return@post
        if (!isExpectedOrigin(webView.url)) return@post
        val message = runCatching { JSONObject(rawJson) }.getOrNull() ?: return@post
        handleControlMessage(message)
      }
    }
  }

  init {
    clipChildren = true
    clipToPadding = false
    // Keep index 0 dedicated to the native video container so RN child indices offset cleanly by +1.
    addView(rendererContainer, 0, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  fun setUrl(value: String) {
    if (url == value) return
    disconnect()
    detachControls()
    url = value
    expectedPort = parseExpectedLoopbackPort(value)
    controlsReady = false
    pendingMessages.clear()
    latestStats = null
    pictureRectCss = null
    audioAvailable = false
    reloadedForBridge = false
    attachStartMs = SystemClock.elapsedRealtime()
    requestLayout()
    attachControls()
    // Start native WebRTC signaling & ICE immediately in parallel with WebView HTML/JS load.
    connect()
  }

  fun setMaxFps(value: Int) {
    if (value != 60 && value != 120) return
    if (maxFps == value) return
    maxFps = value
    updateReceiverRate()
  }

  fun setActive(value: Boolean) {
    if (active == value) return
    active = value
    if (!value) {
      if (!supportsPause) {
        disconnect()
        return
      }
      connection?.setActive(false)
      renderer?.pauseVideo()
      // Hide SurfaceViewRenderer so its hardware Surface never punches a frozen hole through other screens during the 120s reuse window.
      renderer?.visibility = View.GONE
      rendererContainer.visibility = View.GONE
      controlsSession(JSONObject().put("active", false).put("maxFps", receiverRate()))
    } else if (connection != null && applicationActive && isAttachedToWindow) {
      rendererContainer.visibility = View.VISIBLE
      renderer?.visibility = View.VISIBLE
      connection?.setActive(true)
      renderer?.disableFpsReduction()
      controlsSession(JSONObject().put("active", true).put("maxFps", receiverRate()))
    } else {
      disconnect()
      connect()
    }
  }

  fun setAudio(value: Boolean) {
    if (audio == value) return
    audio = value
    connection?.setAudio(value)
  }

  fun setApplicationActive(activeState: Boolean) {
    if (applicationActive == activeState) return
    applicationActive = activeState
    if (!activeState) {
      disconnect()
    } else {
      attachStartMs = SystemClock.elapsedRealtime()
      attachControls()
      connect()
    }
  }

  fun dispose() {
    if (disposed) return
    disposed = true
    disconnect()
    detachControls()
    runCatching { eglBase?.release() }
    eglBase = null
  }

  // GroupView child bridging around index-0 rendererContainer
  fun addRnChild(child: View, index: Int) {
    val targetIndex = (index + 1).coerceIn(1, childCount)
    addView(child, targetIndex)
    attachStartMs = SystemClock.elapsedRealtime()
    post { attachControls() }
  }

  fun getRnChildCount(): Int = (childCount - 1).coerceAtLeast(0)

  fun getRnChildAt(index: Int): View? {
    val physical = index + 1
    return if (physical in 1 until childCount) getChildAt(physical) else null
  }

  fun removeRnChildAt(index: Int) {
    val physical = index + 1
    if (physical !in 1 until childCount) return
    val removing = getChildAt(physical)
    if (removing != null && attachedWebView != null && isAncestorOf(removing, attachedWebView!!)) {
      detachControls()
    }
    removeViewAt(physical)
  }

  fun removeRnChild(child: View) {
    if (child === rendererContainer) return
    if (attachedWebView != null && isAncestorOf(child, attachedWebView!!)) {
      detachControls()
    }
    removeView(child)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    attachStartMs = SystemClock.elapsedRealtime()
    attachControls()
    connect()
  }

  override fun onDetachedFromWindow() {
    cancelAttachPolling()
    detachControls()
    if (!active && supportsPause && applicationActive) {
      renderer?.pauseVideo()
      renderer?.visibility = View.GONE
      rendererContainer.visibility = View.GONE
    } else {
      disconnect()
    }
    super.onDetachedFromWindow()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val width = MeasureSpec.getSize(widthMeasureSpec)
    val height = MeasureSpec.getSize(heightMeasureSpec)
    val rect = resolveRendererPixels(width, height)
    val rW = MeasureSpec.makeMeasureSpec((rect.right - rect.left).coerceAtLeast(0), MeasureSpec.EXACTLY)
    val rH = MeasureSpec.makeMeasureSpec((rect.bottom - rect.top).coerceAtLeast(0), MeasureSpec.EXACTLY)
    rendererContainer.measure(rW, rH)

    val fullW = MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY)
    val fullH = MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY)
    for (i in 1 until childCount) {
      getChildAt(i).measure(fullW, fullH)
    }
    setMeasuredDimension(width, height)
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val width = right - left
    val height = bottom - top
    val rect = resolveRendererPixels(width, height)
    rendererContainer.layout(rect.left, rect.top, rect.right, rect.bottom)
    for (i in 1 until childCount) {
      getChildAt(i).layout(0, 0, width, height)
    }
    attachControls()
  }

  private fun resolveRendererPixels(width: Int, height: Int): android.graphics.Rect {
    val rect = pictureRectCss ?: return android.graphics.Rect(0, 0, width, height)
    val density = resources.displayMetrics.density
    val l = (rect.x * density).roundToInt().coerceIn(0, width)
    val t = (rect.y * density).roundToInt().coerceIn(0, height)
    val r = ((rect.x + rect.w) * density).roundToInt().coerceIn(l, width)
    val b = ((rect.y + rect.h) * density).roundToInt().coerceIn(t, height)
    return android.graphics.Rect(l, t, r, b)
  }

  private fun updateReceiverRate() {
    if (connection == null || !supportsConfiguration) {
      disconnect()
      connect()
      return
    }
    if (active && applicationActive) {
      renderer?.disableFpsReduction()
    }
    controlsSession(JSONObject().put("maxFps", receiverRate()))
  }

  private fun receiverRate(): Int {
    val displayHz = currentDisplayRefreshRate()
    val constrained = isPowerConstrained()
    return minOf(maxFps, if (!constrained && displayHz >= 119f) 120 else 60)
  }

  private fun currentDisplayRefreshRate(): Float {
    return runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        context.display?.refreshRate ?: 60f
      } else {
        @Suppress("DEPRECATION")
        (appContext.currentActivity ?: context as? Activity)?.windowManager?.defaultDisplay?.refreshRate ?: 60f
      }
    }.getOrDefault(60f)
  }

  private fun isPowerConstrained(): Boolean {
    val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
    if (pm.isPowerSaveMode) return true
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val thermal = pm.currentThermalStatus
      if (thermal >= PowerManager.THERMAL_STATUS_SEVERE) return true
    }
    return false
  }

  private fun connect() {
    if (disposed || !active || !applicationActive || !isAttachedToWindow || connection != null || url.isEmpty()) {
      return
    }
    val sharedEgl = eglBase ?: EglBase.create().also { eglBase = it }
    val surfaceRenderer = SurfaceViewRenderer(context)
    renderer = surfaceRenderer
    firstFrameSeen = false
    lastPictureWidth = 0
    lastPictureHeight = 0
    reportedPictureWidth = 0
    reportedPictureHeight = 0

    surfaceRenderer.setZOrderMediaOverlay(false)
    surfaceRenderer.setZOrderOnTop(false)
    surfaceRenderer.setEnableHardwareScaler(true)
    surfaceRenderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)

    val rate = receiverRate()
    val conn = ScreenConnectionAndroid.create(
      context = context,
      url = url,
      maxFps = rate,
      eglContext = sharedEgl.eglBaseContext,
      renderer = surfaceRenderer,
      audio = audio,
    )
    if (conn == null) {
      renderer = null
      onState(mapOf("state" to "failed", "message" to "屏幕地址无效，请重新连接"))
      return
    }
    connection = conn

    surfaceRenderer.init(
      sharedEgl.eglBaseContext,
      object : RendererCommon.RendererEvents {
        override fun onFirstFrameRendered() {
          mainHandler.post {
            if (disposed || connection !== conn) return@post
            firstFrameSeen = true
            conn.pictureArrived()
            maybeNotifyPicture(conn)
          }
        }

        override fun onFrameResolutionChanged(videoWidth: Int, videoHeight: Int, rotation: Int) {
          val rotated = rotation == 90 || rotation == 270
          val w = if (rotated) videoHeight else videoWidth
          val h = if (rotated) videoWidth else videoHeight
          mainHandler.post {
            if (disposed || connection !== conn || w <= 0 || h <= 0) return@post
            lastPictureWidth = w
            lastPictureHeight = h
            maybeNotifyPicture(conn)
          }
        }
      },
    )

    val surfaceVisibility = if (active) View.VISIBLE else View.GONE
    rendererContainer.visibility = surfaceVisibility
    surfaceRenderer.visibility = surfaceVisibility
    rendererContainer.removeAllViews()
    rendererContainer.addView(
      surfaceRenderer,
      FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
    )

    conn.onReceiving = {
      mainHandler.post {
        if (disposed || connection !== conn || !active || reportedPictureWidth > 0) return@post
        onState(mapOf("state" to "receiving", "maxFps" to receiverRate()))
      }
    }

    conn.onAudioAvailable = { available ->
      mainHandler.post {
        if (disposed || connection !== conn || audioAvailable == available) return@post
        audioAvailable = available
        if (active && reportedPictureWidth > 0 && reportedPictureHeight > 0) {
          onState(
            mapOf(
              "state" to "ready",
              "width" to reportedPictureWidth,
              "height" to reportedPictureHeight,
              "maxFps" to receiverRate(),
              "audioAvailable" to available,
            )
          )
        }
      }
    }

    conn.onFailure = { message ->
      mainHandler.post {
        if (disposed || connection !== conn) return@post
        disconnect()
        if (active) {
          onState(mapOf("state" to "failed", "message" to message))
        }
      }
    }

    conn.onMessage = { message ->
      mainHandler.post {
        if (disposed || connection !== conn) return@post
        val sess = message.optJSONObject("session")
        if (sess != null && sess.optString("t") == "capabilities" && sess.optInt("version", -1) == 1) {
          supportsConfiguration = sess.optBoolean("configure", false)
          supportsPause = supportsConfiguration && sess.optBoolean("pause", false)
        }
        if (controlsReady) {
          controlsCall("message", message)
        } else if (pendingMessages.size < 128) {
          pendingMessages.add(message)
        }
      }
    }

    conn.onStats = { stats ->
      mainHandler.post {
        if (disposed || connection !== conn) return@post
        latestStats = stats
        if (controlsReady) {
          controlsCall("stats", stats)
        }
      }
    }

    onState(mapOf("state" to "connecting", "maxFps" to rate))
    conn.start()
    if (controlsReady) {
      controlsCall("connecting", JSONObject())
      controlsSession(JSONObject().put("active", active).put("maxFps", rate))
    }
  }

  private fun maybeNotifyPicture(conn: ScreenConnectionAndroid) {
    if (!firstFrameSeen || lastPictureWidth <= 0 || lastPictureHeight <= 0 || connection !== conn) return
    val changed = lastPictureWidth != reportedPictureWidth || lastPictureHeight != reportedPictureHeight
    if (!changed) return
    reportedPictureWidth = lastPictureWidth
    reportedPictureHeight = lastPictureHeight
    if (controlsReady) {
      controlsCall("picture", JSONObject().put("width", reportedPictureWidth).put("height", reportedPictureHeight))
    }
    if (active) {
      onState(
        mapOf(
          "state" to "ready",
          "width" to reportedPictureWidth,
          "height" to reportedPictureHeight,
          "maxFps" to receiverRate(),
          "audioAvailable" to audioAvailable,
        )
      )
    }
  }

  private fun disconnect() {
    connection?.stop()
    connection = null
    supportsConfiguration = false
    supportsPause = false
    audioAvailable = false
    firstFrameSeen = false
    lastPictureWidth = 0
    lastPictureHeight = 0
    reportedPictureWidth = 0
    reportedPictureHeight = 0
    pendingMessages.clear()
    latestStats = null
    rendererContainer.removeAllViews()
    runCatching { renderer?.clearImage() }
    runCatching { renderer?.release() }
    renderer = null
  }

  private fun handleControlMessage(message: JSONObject) {
    when (message.optString("kind")) {
      "ready" -> {
        if (ScreenSessionStateAndroid.jsonInt(message, "version") != 1) return
        controlsReady = true
        cancelAttachPolling()
        if (connection == null) {
          connect()
        } else {
          if (reportedPictureWidth <= 0) {
            controlsCall("connecting", JSONObject())
          }
          controlsSession(JSONObject().put("active", active).put("maxFps", receiverRate()))
          val buffered = ArrayList(pendingMessages)
          pendingMessages.clear()
          for (item in buffered) controlsCall("message", item)
          if (reportedPictureWidth > 0 && reportedPictureHeight > 0) {
            controlsCall("picture", JSONObject().put("width", reportedPictureWidth).put("height", reportedPictureHeight))
          }
          latestStats?.let { controlsCall("stats", it) }
        }
      }
      "frame" -> {
        val rect = message.optJSONObject("rect") ?: return
        val x = rect.optDouble("x", Double.NaN)
        val y = rect.optDouble("y", Double.NaN)
        val w = rect.optDouble("w", Double.NaN)
        val h = rect.optDouble("h", Double.NaN)
        if (!x.isFinite() || !y.isFinite() || !w.isFinite() || !h.isFinite()) return
        if (abs(x) >= 100_000 || abs(y) >= 100_000 || w <= 0 || h <= 0 || w >= 100_000 || h >= 100_000) return
        pictureRectCss = PictureRect(x, y, w, h)
        requestLayout()
      }
      "input" -> {
        if (!active || !applicationActive) return
        val input = message.optJSONObject("message") ?: return
        val kind = input.optString("t")
        if (kind !in listOf("move", "scroll", "down", "up", "key", "text", "prompt")) return
        val replaceable = message.optBoolean("replaceable", false) && kind in listOf("move", "scroll")
        connection?.input(input, replaceable)
      }
      "signal" -> {
        val signal = message.optJSONObject("message") ?: return
        when (signal.optString("t")) {
          "screen.configure" -> connection?.configure(signal, receiverRate())
          "audio" -> if (signal.has("enabled") && !signal.isNull("enabled")) {
            setAudio(signal.optBoolean("enabled", audio))
          }
          "control" -> if (active && applicationActive) connection?.requestControl(signal)
          "prompt" -> if (active && applicationActive) connection?.input(signal, replaceable = false)
          "activity" -> if (active && applicationActive) connection?.activity()
          "clipboard.read", "clipboard.write" -> if (active && applicationActive) connection?.clipboard(signal)
        }
      }
      "stats" -> connection?.requestStats()
    }
  }

  private fun attachControls() {
    if (disposed || !isAttachedToWindow || url.isEmpty()) return
    val webView = findWebView(this)
    if (webView != null) {
      if (attachedWebView !== webView) {
        detachControls()
        attachedWebView = webView
        webView.settings.javaScriptEnabled = true
        webView.addJavascriptInterface(AndroidScreenBridge(), BRIDGE_NAME)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
          runCatching {
            documentStartScript = WebViewCompat.addDocumentStartJavaScript(webView, SHIM_SCRIPT, setOf("*"))
          }
        }
      }
      ensureBridgeActiveInPage(webView)
      if (controlsReady) {
        cancelAttachPolling()
        return
      }
    }

    if (attachRunnable != null) return
    if (SystemClock.elapsedRealtime() - attachStartMs > 5_000L) {
      if (active && !controlsReady) {
        onState(mapOf("state" to "failed", "message" to "屏幕控制界面未能加载"))
      }
      return
    }
    val next = Runnable {
      attachRunnable = null
      attachControls()
    }
    attachRunnable = next
    mainHandler.postDelayed(next, 50L)
  }

  private fun ensureBridgeActiveInPage(webView: WebView) {
    if (!isExpectedOrigin(webView.url)) return
    webView.evaluateJavascript(ENSURE_SHIM_SCRIPT) { result ->
      if (disposed || attachedWebView !== webView) return@evaluateJavascript
      val status = result?.trim('"')
      if (status == "need-reload" && !reloadedForBridge && isExpectedOrigin(webView.url)) {
        reloadedForBridge = true
        webView.reload()
      }
    }
  }

  private fun detachControls() {
    cancelAttachPolling()
    runCatching { documentStartScript?.remove() }
    documentStartScript = null
    attachedWebView?.let { wv ->
      runCatching { wv.removeJavascriptInterface(BRIDGE_NAME) }
    }
    attachedWebView = null
  }

  private fun cancelAttachPolling() {
    attachRunnable?.let { mainHandler.removeCallbacks(it) }
    attachRunnable = null
  }

  private fun controlsCall(method: String, payload: JSONObject) {
    val webView = attachedWebView ?: return
    if (!isExpectedOrigin(webView.url)) return
    val methodLiteral = JSONObject.quote(method)
    val script =
      "(function(){try{var n=window.linkshellNative;if(n&&typeof n[$methodLiteral]==='function'){n[$methodLiteral](${payload});}}catch(e){}})();"
    webView.evaluateJavascript(script, null)
  }

  private fun controlsSession(payload: JSONObject) {
    val webView = attachedWebView ?: return
    if (!isExpectedOrigin(webView.url)) return
    val script =
      "(function(){try{var p=${payload};if(typeof window.linkshellSession==='function'){window.linkshellSession(p);}var n=window.linkshellNative;if(n&&typeof n.session==='function'){n.session(p);}}catch(e){}})();"
    webView.evaluateJavascript(script, null)
  }

  private fun isExpectedOrigin(candidateUrl: String?): Boolean {
    if (expectedPort <= 0 || candidateUrl.isNullOrEmpty()) return false
    val uri = runCatching { Uri.parse(candidateUrl) }.getOrNull() ?: return false
    return uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port == expectedPort
  }

  private fun parseExpectedLoopbackPort(value: String): Int {
    val uri = runCatching { Uri.parse(value) }.getOrNull() ?: return -1
    if (uri.scheme != "http" || uri.host != "127.0.0.1") return -1
    return uri.port
  }

  private fun findWebView(root: ViewGroup): WebView? {
    for (i in 0 until root.childCount) {
      val child = root.getChildAt(i)
      if (child === rendererContainer) continue
      if (child is WebView) return child
      if (child is ViewGroup) {
        val nested = findWebView(child)
        if (nested != null) return nested
      }
    }
    return null
  }

  private fun isAncestorOf(parent: View, child: View): Boolean {
    if (parent === child) return true
    if (parent !is ViewGroup) return false
    for (i in 0 until parent.childCount) {
      if (isAncestorOf(parent.getChildAt(i), child)) return true
    }
    return false
  }

  companion object {
    private const val BRIDGE_NAME = "linkshellAndroidScreen"

    private const val SHIM_SCRIPT = """
      (function() {
        try {
          if (!window.linkshellAndroidScreen) return;
          if (!window.webkit) window.webkit = {};
          if (!window.webkit.messageHandlers) window.webkit.messageHandlers = {};
          if (!window.webkit.messageHandlers.linkshellScreen) {
            window.webkit.messageHandlers.linkshellScreen = {
              postMessage: function(msg) {
                window.linkshellAndroidScreen.postMessage(JSON.stringify(msg));
              }
            };
          }
          window.__linkshellScreenAndroidReady = true;
        } catch (e) {}
      })();
    """

    private const val ENSURE_SHIM_SCRIPT = """
      (function() {
        try {
          if (!window.linkshellAndroidScreen) return 'need-reload';
          if (window.__linkshellScreenAndroidReady && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.linkshellScreen) {
            return 'ready';
          }
          if (!window.webkit) window.webkit = {};
          if (!window.webkit.messageHandlers) window.webkit.messageHandlers = {};
          if (!window.webkit.messageHandlers.linkshellScreen) {
            window.webkit.messageHandlers.linkshellScreen = {
              postMessage: function(msg) {
                window.linkshellAndroidScreen.postMessage(JSON.stringify(msg));
              }
            };
          }
          return window.__linkshellScreenAndroidReady ? 'ready' : 'need-reload';
        } catch (e) {
          return 'error';
        }
      })();
    """
  }
}
