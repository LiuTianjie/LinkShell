package expo.modules.linklayout

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.view.OrientationEventListener
import android.view.Surface
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference
import java.util.Locale
import kotlin.math.abs

class LinkLayoutModule : Module() {
  private var speech: SpeechInput? = null
  private var tts: TextToSpeech? = null
  private var ttsReady = false
  private var pendingTts: Pair<String, String?>? = null
  private var listener: OrientationEventListener? = null
  private var requestedActivity: WeakReference<Activity>? = null
  private var previousOrientation: Int? = null
  private var fullscreenActivity: WeakReference<Activity>? = null
  private var fullscreenOrientation: Int? = null

  companion object {
    private const val ATTENTION_CHANNEL_ID = "linkshell_attention"
    private const val PROGRESS_CHANNEL_ID = "linkshell_progress"
    private const val STATUS_NOTIFICATION_ID = 4210
  }

  override fun definition() = ModuleDefinition {
    Name("LinkLayout")
    Events("onSpeechResult", "onSpeechLevel", "onSpeechError")
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
    AsyncFunction("syncStatusNotification") { payload: Map<String, Any?> ->
      syncStatusNotification(payload)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("cancelStatusNotification") {
      cancelStatusNotification()
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("requestLandscape") { requestLandscape() }.runOnQueue(Queues.MAIN)
    AsyncFunction("clearOrientationRequest") { restoreOrientation() }.runOnQueue(Queues.MAIN)
    OnActivityEntersBackground { onMain { clearRequest(); speech?.cancel() } }
    OnDestroy {
      onMain {
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

  private fun ensureNotificationChannels(manager: NotificationManager) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val attentionChannel = NotificationChannel(
      ATTENTION_CHANNEL_ID,
      "LinkShell Attention",
      NotificationManager.IMPORTANCE_HIGH
    ).apply {
      description = "Approvals, questions, and failed agent turns"
    }
    val progressChannel = NotificationChannel(
      PROGRESS_CHANNEL_ID,
      "LinkShell Background Progress",
      NotificationManager.IMPORTANCE_LOW
    ).apply {
      description = "Ongoing remote coding session progress"
      setShowBadge(false)
    }
    manager.createNotificationChannel(attentionChannel)
    manager.createNotificationChannel(progressChannel)
  }

  private fun syncStatusNotification(payload: Map<String, Any?>): Boolean {
    val context = appContext.reactContext ?: return false
    val active = payload["active"] as? Boolean ?: false
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return false
    if (!active) {
      manager.cancel(STATUS_NOTIFICATION_ID)
      return true
    }
    ensureNotificationChannels(manager)
    val urgent = payload["urgent"] as? Boolean ?: false
    val ongoing = payload["ongoing"] as? Boolean ?: false
    val title = (payload["title"] as? String)?.takeIf { it.isNotBlank() } ?: "LinkShell"
    val subtitle = (payload["subtitle"] as? String) ?: ""
    val computerName = (payload["computerName"] as? String)?.takeIf { it.isNotBlank() }
    val deepLink = (payload["deepLink"] as? String)?.takeIf { it.startsWith("linkshell:///") } ?: "linkshell:///"
    val channelId = if (urgent) ATTENTION_CHANNEL_ID else PROGRESS_CHANNEL_ID

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(context, channelId)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(context)
    }
    val iconRes = context.applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.stat_notify_sync
    val launchIntent = Intent(Intent.ACTION_VIEW, Uri.parse(deepLink)).apply {
      setPackage(context.packageName)
      addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or
      (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
    val contentIntent = PendingIntent.getActivity(context, STATUS_NOTIFICATION_ID, launchIntent, pendingFlags)

    builder
      .setSmallIcon(iconRes)
      .setContentTitle(title)
      .setContentText(subtitle)
      .setContentIntent(contentIntent)
      .setOngoing(ongoing)
      .setAutoCancel(!ongoing)
      .setOnlyAlertOnce(!urgent)
    if (computerName != null) {
      builder.setSubText(computerName)
    }
    if (subtitle.length > 48) {
      builder.setStyle(Notification.BigTextStyle().bigText(subtitle))
    }
    manager.notify(STATUS_NOTIFICATION_ID, builder.build())
    return true
  }

  private fun cancelStatusNotification() {
    val context = appContext.reactContext ?: return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    manager.cancel(STATUS_NOTIFICATION_ID)
  }

  private fun onMain(action: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) action()
    else Handler(Looper.getMainLooper()).post { action() }
  }

  private fun requestLandscape() {
    if (fullscreenOrientation != null) return
    clearRequest()
    val activity = appContext.currentActivity ?: throw Exceptions.MissingActivity()
    fullscreenActivity = WeakReference(activity)
    fullscreenOrientation = interfaceOrientation(activity)
    if (activity.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) return
    requestOnce(activity, ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE)
  }

  private fun restoreOrientation() {
    val orientation = fullscreenOrientation ?: return
    val activity = fullscreenActivity?.get()
    fullscreenOrientation = null
    fullscreenActivity = null
    clearRequest()
    if (activity != null && interfaceOrientation(activity) != orientation) requestOnce(activity, orientation)
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

  private fun requestOnce(activity: Activity, orientation: Int) {
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
    if (!tracker.canDetectOrientation()) return
    requestedActivity = WeakReference(activity)
    previousOrientation = activity.requestedOrientation
    listener = tracker
    tracker.enable()
    activity.requestedOrientation = orientation
  }

  private fun clearRequest() {
    listener?.disable()
    listener = null
    val activity = requestedActivity?.get()
    previousOrientation?.let { activity?.requestedOrientation = it }
    previousOrientation = null
    requestedActivity = null
  }
}
