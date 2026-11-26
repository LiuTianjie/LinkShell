package expo.modules.linkscreen

import android.content.Context
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

internal class ScreenSessionStateAndroid {
  var active: Boolean = true
    private set
  var supportsConfiguration: Boolean = false
    private set
  var supportsPause: Boolean = false
    private set
  var latestRequestId: Int? = null
    private set
  private var awaitingConfiguration = false
  private var needsConfiguration = false
  private var requestedPaused = false
  private var requestedDisplay: Int? = null
  private var generation: Int? = null

  val allowsInput: Boolean
    get() = active && !awaitingConfiguration && (!supportsConfiguration || generation != null)

  fun acceptsInput(message: JSONObject): Boolean {
    return allowsInput && (!supportsConfiguration || jsonInt(message, "screenGeneration") == generation)
  }

  fun setActive(value: Boolean) {
    if (active == value) return
    active = value
    if (supportsConfiguration) {
      awaitingConfiguration = true
      if (!value) needsConfiguration = true
    }
  }

  fun receive(session: JSONObject) {
    when (session.optString("t")) {
      "capabilities" -> {
        if (jsonInt(session, "version") != 1) return
        supportsConfiguration = jsonBool(session, "configure") == true
        supportsPause = supportsConfiguration && jsonBool(session, "pause") == true
      }
      "configured" -> {
        if (needsConfiguration) return
        val requestId = jsonInt(session, "requestId") ?: return
        if (requestId != latestRequestId) return
        val display = jsonInt(session, "display") ?: return
        if (display != requestedDisplay) return
        val gen = jsonInt(session, "generation") ?: return
        if (gen < 0) return
        val paused = jsonBool(session, "paused") ?: return
        if (paused != requestedPaused) return
        generation = gen
        awaitingConfiguration = paused || !active
      }
    }
  }

  fun configuration(message: JSONObject, maxFps: Int): JSONObject? {
    if (message.optString("t") != "screen.configure") return null
    val requestId = jsonInt(message, "requestId") ?: return null
    if (requestId < 0 || requestId <= (latestRequestId ?: -1)) return null
    val display = jsonInt(message, "display") ?: return null
    if (display < 0) return null
    val paused = jsonBool(message, "paused") ?: return null

    val widthValue: Any = when (val raw = message.opt("width")) {
      "native" -> "native"
      is Number -> {
        val v = jsonInt(message, "width") ?: return null
        if (v !in 640..3840) return null
        v
      }
      is String -> {
        val v = raw.toIntOrNull() ?: return null
        if (v !in 640..3840) return null
        v
      }
      else -> return null
    }

    val requestedFps = if (!message.has("maxFps") || message.isNull("maxFps")) {
      maxFps
    } else {
      jsonInt(message, "maxFps") ?: return null
    }
    if (requestedFps !in listOf(30, 60, 120) || maxFps !in listOf(30, 60, 120)) return null

    latestRequestId = requestId
    requestedPaused = paused
    requestedDisplay = display
    awaitingConfiguration = true
    needsConfiguration = false

    return JSONObject().apply {
      put("t", "screen.configure")
      put("requestId", requestId)
      put("display", display)
      put("width", widthValue)
      put("maxFps", minOf(requestedFps, maxFps))
      put("paused", requestedPaused)
    }
  }

  companion object {
    fun jsonInt(obj: JSONObject, key: String): Int? {
      if (!obj.has(key) || obj.isNull(key)) return null
      val value = obj.opt(key)
      if (value is Boolean || value !is Number) return null
      val d = value.toDouble()
      if (!d.isFinite() || d % 1.0 != 0.0 || kotlin.math.abs(d) > 9_007_199_254_740_991.0) return null
      return d.toInt()
    }

    fun jsonBool(obj: JSONObject, key: String): Boolean? {
      if (!obj.has(key) || obj.isNull(key)) return null
      return obj.opt(key) as? Boolean
    }
  }
}

/**
 * Owns WebSocket signaling, WebRTC PeerConnection decode into `SurfaceViewRenderer`, reliable/pointer
 * DataChannels, and the binary `"audio"` DataChannel feeding `ScreenAudioPlayerAndroid`.
 */
internal class ScreenConnectionAndroid private constructor(
  private val appContext: Context,
  private val wsUrl: String,
  private var maxFps: Int,
  private val diagnosticsEnabled: Boolean,
  private val smooth: Boolean,
  private val eglContext: EglBase.Context,
  private val renderer: SurfaceViewRenderer,
  initialAudio: Boolean,
) : PeerConnection.Observer {

  companion object {
    private const val PATIENCE_SECONDS = 25L
    private const val MAX_ICE_CANDIDATES = 256
    private const val PLAYOUT_DELAY_URI = "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay"
    private val STRIPPED_QUERY_KEYS = setOf("video", "maxFps", "diagnostics", "codec", "turn", "audio")

    private val webrtcInitialized = AtomicBoolean(false)
    private val sharedHttpClient: OkHttpClient by lazy {
      OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    }

    private fun ensureWebRtcInitialized(context: Context) {
      if (webrtcInitialized.compareAndSet(false, true)) {
        PeerConnectionFactory.initialize(
          PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
            .createInitializationOptions()
        )
      }
    }

    private fun hasHardwareHevcDecoder(context: Context, eglContext: EglBase.Context): Boolean {
      return runCatching {
        ensureWebRtcInitialized(context)
        val webrtcSupportsHevc = DefaultVideoDecoderFactory(eglContext).supportedCodecs.any {
          it.name.equals("H265", ignoreCase = true) || it.name.equals("HEVC", ignoreCase = true)
        }
        if (!webrtcSupportsHevc) return@runCatching false
        val list = MediaCodecList(MediaCodecList.REGULAR_CODECS)
        list.codecInfos.any { info ->
          if (info.isEncoder) return@any false
          if (!info.supportedTypes.any { it.equals("video/hevc", ignoreCase = true) }) return@any false
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            info.isHardwareAccelerated
          } else {
            !info.name.startsWith("OMX.google.", ignoreCase = true) &&
              !info.name.startsWith("c2.android.", ignoreCase = true)
          }
        }
      }.getOrDefault(false)
    }

    /** Strips FlexFEC-03 (and playout-delay when smooth pacing is selected) from remote video offers. */
    private fun filterOfferSdp(sdp: String, stripPlayoutDelay: Boolean): String {
      val lines = sdp.split("\r\n")
      val flexFecPts = HashSet<String>()
      val rtpmapRegex = Regex("^a=rtpmap:(\\d+)\\s+flexfec-03/", RegexOption.IGNORE_CASE)
      for (line in lines) {
        rtpmapRegex.find(line)?.groupValues?.getOrNull(1)?.let { flexFecPts.add(it) }
      }
      val out = ArrayList<String>(lines.size)
      var inVideo = false
      for (line in lines) {
        if (line.startsWith("m=")) {
          inVideo = line.startsWith("m=video ")
          if (inVideo && flexFecPts.isNotEmpty()) {
            val parts = line.split(" ")
            if (parts.size > 3) {
              val kept = parts.subList(0, 3) + parts.subList(3, parts.size).filter { it !in flexFecPts }
              out.add(kept.joinToString(" "))
              continue
            }
          }
        }
        if (inVideo) {
          if (stripPlayoutDelay && line.contains(PLAYOUT_DELAY_URI)) continue
          if (flexFecPts.isNotEmpty()) {
            if (line.startsWith("a=ssrc-group:FEC-FR ")) continue
            val isFlexLine = flexFecPts.any { pt ->
              line.startsWith("a=rtpmap:$pt ") || line.startsWith("a=fmtp:$pt ") || line.startsWith("a=rtcp-fb:$pt ")
            }
            if (isFlexLine) continue
          }
        }
        out.add(line)
      }
      return out.joinToString("\r\n")
    }

    fun create(
      context: Context,
      url: String,
      maxFps: Int,
      eglContext: EglBase.Context,
      renderer: SurfaceViewRenderer,
      audio: Boolean = false,
    ): ScreenConnectionAndroid? {
      val parsed = runCatching { Uri.parse(url) }.getOrNull() ?: return null
      if (parsed.scheme != "http" || parsed.host != "127.0.0.1" || parsed.port <= 0) return null

      val diagnostics = parsed.getQueryParameter("diagnostics") == "1"
      val smooth = parsed.getQueryParameter("pacing") == "smooth"
      val builder = Uri.Builder()
        .scheme("ws")
        .encodedAuthority("127.0.0.1:${parsed.port}")
        .path("/stream")

      for (name in parsed.queryParameterNames) {
        if (name in STRIPPED_QUERY_KEYS) continue
        for (value in parsed.getQueryParameters(name)) {
          builder.appendQueryParameter(name, value)
        }
      }
      builder.appendQueryParameter("video", "1")
      builder.appendQueryParameter("maxFps", maxFps.toString())
      builder.appendQueryParameter("diagnostics", if (diagnostics) "1" else "0")
      builder.appendQueryParameter("audio", if (audio) "1" else "0")
      builder.appendQueryParameter("turn", "1")
      if (hasHardwareHevcDecoder(context.applicationContext, eglContext)) {
        builder.appendQueryParameter("codec", "hevc")
      }

      return ScreenConnectionAndroid(
        appContext = context.applicationContext,
        wsUrl = builder.build().toString(),
        maxFps = maxFps,
        diagnosticsEnabled = diagnostics,
        smooth = smooth,
        eglContext = eglContext,
        renderer = renderer,
        initialAudio = audio,
      )
    }
  }

  var onMessage: ((JSONObject) -> Unit)? = null
  var onReceiving: (() -> Unit)? = null
  var onFailure: ((String) -> Unit)? = null
  var onStats: ((JSONObject) -> Unit)? = null
  var onAudioAvailable: ((Boolean) -> Unit)? = null

  private val executor = Executors.newSingleThreadScheduledExecutor { runnable ->
    Thread(runnable, "LinkShellScreenConn")
  }
  private val audioPlayer = ScreenAudioPlayerAndroid(initialMuted = !initialAudio)
  private val session = ScreenSessionStateAndroid()

  private var webSocket: WebSocket? = null
  private var factory: PeerConnectionFactory? = null
  private var peer: PeerConnection? = null
  private var videoTrack: VideoTrack? = null
  private var monitorFuture: ScheduledFuture<*>? = null

  private val channels = HashMap<String, DataChannel>()
  private val pendingCandidates = ArrayList<IceCandidate>()

  private var closed = false
  private var ready = false
  private var diagnosing = false
  private var trusted = false
  private var controlRequested = false
  private var controlMessage = JSONObject().put("t", "control")
  private var pendingConfiguration: JSONObject? = null
  private var receivedPicture = false
  private var audioEnabled = initialAudio
  private var audioAvailable = false
  private var audioSyncPending = false
  private var startedAtMs = 0L
  private var disconnectedAtMs: Long? = null
  private var previousStatsAtMs = 0L
  private var statsPending = false
  private var senderStats: JSONObject? = null
  private var eventNumber = 0L

  fun start() {
    executor.execute {
      if (closed || webSocket != null) return@execute
      ensureWebRtcInitialized(appContext)
      startedAtMs = SystemClock.elapsedRealtime()
      previousStatsAtMs = startedAtMs
      monitorFuture = executor.scheduleWithFixedDelay(
        { checkHealthAndStats(requested = false) },
        500L,
        500L,
        TimeUnit.MILLISECONDS,
      )

      val request = Request.Builder().url(wsUrl).build()
      webSocket = sharedHttpClient.newWebSocket(
        request,
        object : WebSocketListener() {
          override fun onOpen(ws: WebSocket, response: Response) {
            executor.execute {
              if (closed || webSocket !== ws) return@execute
              ready = true
              if (controlRequested) signal(controlMessage)
              if (audioSyncPending) {
                audioSyncPending = false
                signal(JSONObject().put("t", "audio").put("enabled", audioEnabled))
              }
              flushConfiguration()
            }
          }

          override fun onMessage(ws: WebSocket, text: String) {
            executor.execute {
              if (closed || webSocket !== ws) return@execute
              val parsed = runCatching { JSONObject(text) }.getOrNull() ?: return@execute
              handleSignalingMessage(parsed)
            }
          }

          override fun onMessage(ws: WebSocket, bytes: ByteString) {
            executor.execute {
              if (closed || webSocket !== ws) return@execute
              fail("当前链路不支持原生视频")
            }
          }

          override fun onClosing(ws: WebSocket, code: Int, reason: String) {
            ws.close(1000, null)
            executor.execute {
              if (closed || webSocket !== ws) return@execute
              fail("屏幕连接已结束")
            }
          }

          override fun onClosed(ws: WebSocket, code: Int, reason: String) {
            executor.execute {
              if (closed || webSocket !== ws) return@execute
              fail("屏幕连接已结束")
            }
          }

          override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
            executor.execute {
              if (closed || webSocket !== ws) return@execute
              fail("屏幕连接已中断")
            }
          }
        },
      )
    }
  }

  fun stop() {
    executor.execute { close() }
    runCatching { executor.shutdown() }
  }

  fun pictureArrived() {
    executor.execute {
      if (!closed) {
        receivedPicture = true
      }
    }
  }

  fun setAudio(enabled: Boolean) {
    executor.execute {
      if (closed) return@execute
      val changed = audioEnabled != enabled
      audioEnabled = enabled
      audioPlayer.setMuted(!(enabled && session.active))
      if (ready) {
        if (changed || audioSyncPending) {
          audioSyncPending = false
          signal(JSONObject().put("t", "audio").put("enabled", enabled))
        }
      } else if (changed) {
        audioSyncPending = true
      }
    }
  }

  fun setActive(active: Boolean) {
    executor.execute {
      if (closed || session.active == active) return@execute
      session.setActive(active)
      audioPlayer.setMuted(!(active && audioEnabled))
      if (!active) {
        trusted = false
        controlRequested = false
        if (session.supportsPause) {
          signal(JSONObject().put("t", "hidden"))
        }
      } else {
        startedAtMs = SystemClock.elapsedRealtime()
        flushConfiguration()
      }
    }
  }

  fun configure(message: JSONObject, maxFps: Int) {
    executor.execute {
      if (closed) return@execute
      val configuration = session.configuration(message, maxFps) ?: return@execute
      this.maxFps = configuration.optInt("maxFps", maxFps)
      pendingConfiguration = configuration
      flushConfiguration()
    }
  }

  fun activity() {
    executor.execute {
      if (closed || !ready || !session.active) return@execute
      signal(JSONObject().put("t", "activity"))
    }
  }

  fun requestControl(message: JSONObject) {
    executor.execute {
      if (closed || !session.active || message.optString("t") != "control") return@execute
      val nextGen = ScreenSessionStateAndroid.jsonInt(message, "screenGeneration")
      val prevGen = ScreenSessionStateAndroid.jsonInt(controlMessage, "screenGeneration")
      if (controlRequested && nextGen == prevGen) return@execute
      controlRequested = true
      controlMessage = message
      if (ready) signal(message)
    }
  }

  fun requestStats() {
    executor.execute { checkHealthAndStats(requested = true) }
  }

  fun input(message: JSONObject, replaceable: Boolean) {
    executor.execute {
      if (closed || !session.acceptsInput(message)) return@execute
      if (!trusted && message.optString("t") != "prompt") return@execute
      val channel = channels[if (replaceable) "pointer" else "input"] ?: return@execute
      if (channel.state() != DataChannel.State.OPEN) return@execute
      val limit = if (replaceable) 16_384L else 262_144L
      if (channel.bufferedAmount() > limit) {
        if (!replaceable) fail("控制连接拥堵，请重新连接")
        return@execute
      }
      eventNumber += 1L
      val event = JSONObject(message.toString())
      event.put("i", eventNumber)
      val payload = event.toString().toByteArray(Charsets.UTF_8)
      if (payload.size > 64_000) return@execute
      val buffer = DataChannel.Buffer(ByteBuffer.wrap(payload), false)
      if (!channel.send(buffer) && !replaceable) {
        fail("控制连接已中断，请重新连接")
      }
    }
  }

  private fun flushConfiguration() {
    if (!ready || !session.supportsConfiguration) return
    val configuration = pendingConfiguration ?: return
    if (!session.active && !configuration.optBoolean("paused", false)) return
    pendingConfiguration = null
    signal(configuration)
  }

  private fun signal(message: JSONObject) {
    if (closed) return
    val ws = webSocket ?: return
    if (!ws.send(message.toString())) {
      fail("屏幕信令连接已中断")
    }
  }

  private fun handleSignalingMessage(message: JSONObject) {
    val error = message.optString("error").takeIf { message.has("error") && !message.isNull("error") && it.isNotEmpty() }
    if (error != null) {
      fail(error)
      return
    }
    message.optJSONObject("session")?.let { state ->
      session.receive(state)
      flushConfiguration()
      onMessage?.invoke(JSONObject().put("session", state))
    }
    message.optJSONObject("control")?.let { state ->
      trusted = state.optBoolean("available", false) && state.optBoolean("trusted", false)
      onMessage?.invoke(JSONObject().put("control", state))
    }
    val rtc = message.optJSONObject("rtc") ?: return
    when (rtc.optString("t")) {
      "config" -> {
        if (peer != null) return
        val iceServers = parseIceServers(rtc.optJSONArray("iceServers"))
        val configuration = PeerConnection.RTCConfiguration(iceServers).apply {
          sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
          bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
          rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
          continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
          enableImplicitRollback = true
        }
        val pcFactory = PeerConnectionFactory.builder()
          .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglContext))
          .createPeerConnectionFactory()
        factory = pcFactory
        val created = pcFactory.createPeerConnection(configuration, this)
        if (created == null) {
          fail("原生视频连接无法启动")
          return
        }
        peer = created
      }
      "offer" -> {
        val currentPeer = peer ?: return
        val sdp = rtc.optString("sdp")
        if (sdp.isEmpty() || sdp.toByteArray(Charsets.UTF_8).size >= 128_000) {
          fail("电脑返回了无效的视频协商信息")
          return
        }
        val filteredSdp = filterOfferSdp(sdp, stripPlayoutDelay = smooth)
        currentPeer.setRemoteDescription(
          object : SdpObserverAdapter() {
            override fun onSetSuccess() {
              executor.execute {
                if (closed || peer !== currentPeer) return@execute
                for (candidate in pendingCandidates) {
                  currentPeer.addIceCandidate(candidate)
                }
                pendingCandidates.clear()
                attachVideoTrack(currentPeer)
                currentPeer.createAnswer(
                  object : SdpObserverAdapter() {
                    override fun onCreateSuccess(answer: SessionDescription) {
                      executor.execute {
                        if (closed || peer !== currentPeer) return@execute
                        currentPeer.setLocalDescription(
                          object : SdpObserverAdapter() {
                            override fun onSetSuccess() {
                              executor.execute {
                                if (closed || peer !== currentPeer) return@execute
                                attachVideoTrack(currentPeer)
                                signal(JSONObject().put("t", "rtc.answer").put("sdp", answer.description))
                              }
                            }

                            override fun onSetFailure(msg: String?) {
                              executor.execute {
                                if (closed || peer !== currentPeer) return@execute
                                fail("视频连接应答失败")
                              }
                            }
                          },
                          answer,
                        )
                      }
                    }

                    override fun onCreateFailure(msg: String?) {
                      executor.execute {
                        if (closed || peer !== currentPeer) return@execute
                        fail("无法应答电脑的视频连接")
                      }
                    }
                  },
                  MediaConstraints(),
                )
              }
            }

            override fun onSetFailure(msg: String?) {
              executor.execute {
                if (closed || peer !== currentPeer) return@execute
                fail("视频格式协商失败")
              }
            }
          },
          SessionDescription(SessionDescription.Type.OFFER, filteredSdp),
        )
      }
      "ice" -> {
        val line = rtc.optString("candidate")
        if (line.isEmpty() || line.toByteArray(Charsets.UTF_8).size >= 8192) return
        val sdpMid = rtc.optString("sdpMid").takeIf { rtc.has("sdpMid") && !rtc.isNull("sdpMid") }
        val sdpMLineIndex = rtc.optInt("sdpMLineIndex", 0)
        val candidate = IceCandidate(sdpMid, sdpMLineIndex, line)
        val currentPeer = peer
        if (currentPeer != null && currentPeer.remoteDescription != null) {
          currentPeer.addIceCandidate(candidate)
        } else if (pendingCandidates.size < MAX_ICE_CANDIDATES) {
          pendingCandidates.add(candidate)
        }
      }
      "stats" -> senderStats = rtc
      "off" -> fail("当前网络无法建立视频直连")
    }
  }

  private fun parseIceServers(array: JSONArray?): List<PeerConnection.IceServer> {
    if (array == null) return emptyList()
    val servers = ArrayList<PeerConnection.IceServer>()
    for (i in 0 until array.length()) {
      val server = array.optJSONObject(i) ?: continue
      val urls = ArrayList<String>()
      val urlsArr = server.optJSONArray("urls")
      if (urlsArr != null) {
        for (j in 0 until urlsArr.length()) {
          urlsArr.optString(j).takeIf { it.isNotEmpty() }?.let { urls.add(it) }
        }
      } else {
        server.optString("urls").takeIf { it.isNotEmpty() }?.let { urls.add(it) }
        server.optString("url").takeIf { it.isNotEmpty() }?.let { urls.add(it) }
      }
      if (urls.isEmpty()) continue
      val builder = PeerConnection.IceServer.builder(urls)
      server.optString("username").takeIf { server.has("username") && !server.isNull("username") && it.isNotEmpty() }?.let {
        builder.setUsername(it)
      }
      server.optString("credential").takeIf { server.has("credential") && !server.isNull("credential") && it.isNotEmpty() }?.let {
        builder.setPassword(it)
      }
      servers.add(builder.createIceServer())
    }
    return servers
  }

  private fun attachVideoTrack(currentPeer: PeerConnection) {
    val incoming = currentPeer.transceivers
      .firstOrNull { it.mediaType == MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO }
      ?.receiver
      ?.track() as? VideoTrack
      ?: return
    if (incoming === videoTrack) return
    videoTrack?.removeSink(renderer)
    videoTrack = incoming
    incoming.addSink(renderer)
  }

  private fun updateAudioAvailabilityIfNeeded() {
    val available = channels["audio"]?.state() == DataChannel.State.OPEN
    if (available == audioAvailable) return
    audioAvailable = available
    onAudioAvailable?.invoke(available)
  }

  private fun checkHealthAndStats(requested: Boolean) {
    if (closed) return
    val nowMs = SystemClock.elapsedRealtime()
    if (session.active && !receivedPicture && nowMs - startedAtMs > PATIENCE_SECONDS * 1000L) {
      diagnoseThenFail("视频直连超时", "no picture within $PATIENCE_SECONDS s")
      return
    }
    val disconnected = disconnectedAtMs
    if (disconnected != null && nowMs - disconnected > 4_000L) {
      fail("视频直连已中断，请重新连接")
      return
    }
    val currentPeer = peer ?: return
    if (!session.active || (!diagnosticsEnabled && !requested) || statsPending) return
    val minIntervalMs = if (requested) 1_000L else 5_000L
    if (nowMs - previousStatsAtMs < minIntervalMs) return
    statsPending = true
    currentPeer.getStats { report ->
      executor.execute {
        if (closed || peer !== currentPeer) return@execute
        statsPending = false
        previousStatsAtMs = nowMs
        val stats = JSONObject().put("requestedFps", maxFps)
        senderStats?.let { stats.put("sender", it) }
        for (record in report.statsMap.values) {
          if (record.type == "inbound-rtp") {
            val kind = (record.members["kind"] ?: record.members["mediaType"]) as? String
            if (kind == "video") {
              (record.members["frameWidth"] as? Number)?.let { stats.put("width", it.toInt()) }
              (record.members["frameHeight"] as? Number)?.let { stats.put("height", it.toInt()) }
              (record.members["framesPerSecond"] as? Number)?.let { stats.put("decodedFps", it.toDouble()) }
              (record.members["framesDropped"] as? Number)?.let { stats.put("framesDropped", it.toLong()) }
              (record.members["packetsLost"] as? Number)?.let { stats.put("packetsLost", it.toLong()) }
            }
          } else if (record.type == "candidate-pair" && record.members["state"] == "succeeded") {
            (record.members["currentRoundTripTime"] as? Number)?.let { stats.put("rttMs", it.toDouble() * 1000.0) }
          }
        }
        onStats?.invoke(stats)
      }
    }
  }

  private fun diagnoseThenFail(message: String, reason: String) {
    if (closed || diagnosing) return
    val currentPeer = peer ?: run {
      fail(message)
      return
    }
    diagnosing = true
    executor.schedule({ fail(message) }, 1_000L, TimeUnit.MILLISECONDS)
    currentPeer.getStats { report ->
      executor.execute {
        if (closed) return@execute
        signal(
          JSONObject()
            .put("t", "rtc.diagnosis")
            .put("reason", reason)
            .put("ice", "ice ${currentPeer.iceConnectionState()}/${currentPeer.iceGatheringState()} (${report.statsMap.size} records, android)")
        )
        executor.schedule({ fail(message) }, 300L, TimeUnit.MILLISECONDS)
      }
    }
  }

  private fun fail(message: String) {
    if (closed) return
    close()
    onFailure?.invoke(message)
  }

  private fun close() {
    if (closed) return
    closed = true
    audioAvailable = false
    audioPlayer.stop()
    monitorFuture?.cancel(false)
    monitorFuture = null
    runCatching { videoTrack?.removeSink(renderer) }
    videoTrack = null
    for (channel in channels.values) {
      runCatching { channel.unregisterObserver() }
    }
    channels.clear()
    runCatching { peer?.close() }
    runCatching { peer?.dispose() }
    peer = null
    runCatching { factory?.dispose() }
    factory = null
    pendingCandidates.clear()
    runCatching { webSocket?.close(1000, null) }
    webSocket = null
  }

  // PeerConnection.Observer
  override fun onSignalingChange(state: PeerConnection.SignalingState?) {}

  override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState?) {
    executor.execute {
      if (closed) return@execute
      when (newState) {
        PeerConnection.IceConnectionState.CONNECTED,
        PeerConnection.IceConnectionState.COMPLETED -> {
          disconnectedAtMs = null
          peer?.let { attachVideoTrack(it) }
          if (!receivedPicture) onReceiving?.invoke()
        }
        PeerConnection.IceConnectionState.DISCONNECTED -> {
          if (disconnectedAtMs == null) disconnectedAtMs = SystemClock.elapsedRealtime()
        }
        PeerConnection.IceConnectionState.FAILED -> {
          diagnoseThenFail("当前网络无法建立视频直连", "ICE failed")
        }
        else -> {}
      }
    }
  }

  override fun onIceConnectionReceivingChange(receiving: Boolean) {}

  override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}

  override fun onIceCandidate(candidate: IceCandidate) {
    executor.execute {
      if (closed) return@execute
      signal(
        JSONObject()
          .put("t", "rtc.ice")
          .put("candidate", candidate.sdp)
          .put("sdpMid", candidate.sdpMid ?: JSONObject.NULL)
          .put("sdpMLineIndex", candidate.sdpMLineIndex)
      )
    }
  }

  override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}

  override fun onAddStream(stream: MediaStream?) {}

  override fun onRemoveStream(stream: MediaStream?) {}

  override fun onDataChannel(dataChannel: DataChannel) {
    executor.execute {
      if (closed) return@execute
      val label = dataChannel.label()
      channels[label] = dataChannel
      dataChannel.registerObserver(
        object : DataChannel.Observer {
          override fun onBufferedAmountChange(previousAmount: Long) {}

          override fun onStateChange() {
            if (label != "audio") return
            executor.execute {
              if (closed || channels[label] !== dataChannel) return@execute
              updateAudioAvailabilityIfNeeded()
            }
          }

          override fun onMessage(buffer: DataChannel.Buffer) {
            val remaining = buffer.data.remaining()
            if (label == "audio") {
              if (!buffer.binary || remaining < ScreenAudioSpec.HEADER_BYTES || remaining > ScreenAudioSpec.MAX_PACKET_BYTES) {
                return
              }
              // WebRTC native memory backing buffer.data is invalidated once onMessage returns.
              val packetBytes = ByteArray(remaining)
              buffer.data.get(packetBytes)
              executor.execute {
                if (closed || !session.active || !audioEnabled || channels["audio"] !== dataChannel) return@execute
                audioPlayer.enqueue(packetBytes)
              }
              return
            }
            if (buffer.binary || remaining > 256_000) return
            val jsonBytes = ByteArray(remaining)
            buffer.data.get(jsonBytes)
            executor.execute {
              if (closed || channels[label] !== dataChannel) return@execute
              val message = runCatching { JSONObject(String(jsonBytes, Charsets.UTF_8)) }.getOrNull() ?: return@execute
              onMessage?.invoke(message)
            }
          }
        },
      )
      if (label == "audio") {
        updateAudioAvailabilityIfNeeded()
      }
    }
  }

  override fun onRenegotiationNeeded() {}

  override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {
    executor.execute {
      if (!closed) peer?.let { attachVideoTrack(it) }
    }
  }

  override fun onTrack(transceiver: RtpTransceiver?) {
    executor.execute {
      if (!closed) peer?.let { attachVideoTrack(it) }
    }
  }

  private open class SdpObserverAdapter : SdpObserver {
    override fun onCreateSuccess(sdp: SessionDescription) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(msg: String?) {}
    override fun onSetFailure(msg: String?) {}
  }
}
