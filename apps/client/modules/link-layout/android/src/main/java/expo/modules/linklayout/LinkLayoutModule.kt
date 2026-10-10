package expo.modules.linklayout

import android.app.Activity
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.Handler
import android.os.Looper
import android.view.OrientationEventListener
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference
import kotlin.math.abs

class LinkLayoutModule : Module() {
  private var listener: OrientationEventListener? = null
  private var requestedActivity: WeakReference<Activity>? = null
  private var previousOrientation: Int? = null

  override fun definition() = ModuleDefinition {
    Name("LinkLayout")
    AsyncFunction("requestLandscape") { requestLandscape() }.runOnQueue(Queues.MAIN)
    AsyncFunction("clearOrientationRequest") { clearRequest() }.runOnQueue(Queues.MAIN)
    OnActivityEntersBackground { onMain { clearRequest() } }
    OnDestroy { onMain { clearRequest() } }
  }

  private fun onMain(action: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) action()
    else Handler(Looper.getMainLooper()).post { action() }
  }

  private fun requestLandscape() {
    if (listener != null) return
    clearRequest()
    val activity = appContext.currentActivity ?: throw Exceptions.MissingActivity()
    if (activity.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) return
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
    activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
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
