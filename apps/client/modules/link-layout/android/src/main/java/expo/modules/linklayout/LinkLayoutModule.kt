package expo.modules.linklayout

import android.app.Activity
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.Handler
import android.os.Looper
import android.view.OrientationEventListener
import android.view.Surface
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference
import kotlin.math.abs

class LinkLayoutModule : Module() {
  private var speech: SpeechInput? = null
  private var listener: OrientationEventListener? = null
  private var requestedActivity: WeakReference<Activity>? = null
  private var previousOrientation: Int? = null
  private var fullscreenActivity: WeakReference<Activity>? = null
  private var fullscreenOrientation: Int? = null

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
    AsyncFunction("requestLandscape") { requestLandscape() }.runOnQueue(Queues.MAIN)
    AsyncFunction("clearOrientationRequest") { restoreOrientation() }.runOnQueue(Queues.MAIN)
    OnActivityEntersBackground { onMain { clearRequest(); speech?.cancel() } }
    OnDestroy { onMain { clearRequest(); speech?.cancel(); speech = null } }
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
