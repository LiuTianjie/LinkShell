package expo.modules.linklayout

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * Receives background notification action button taps (`approve`, `deny`, `cancel`) and queues
 * them into `NotificationActionQueue` so JS can act whether the app is live or cold-starting.
 */
class NotificationActionReceiver : BroadcastReceiver() {
  companion object {
    const val ACTION_NOTIFICATION_BUTTON = "expo.modules.linklayout.NOTIFICATION_ACTION"
  }

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_NOTIFICATION_BUTTON) return
    val actionId = intent.getStringExtra(NotificationActionQueue.EXTRA_ACTION_ID)?.takeIf { it.isNotEmpty() }
      ?: return
    val kind = intent.getStringExtra(NotificationActionQueue.EXTRA_KIND)?.takeIf { it.isNotEmpty() }
      ?: "open"
    val computerKey = intent.getStringExtra(NotificationActionQueue.EXTRA_COMPUTER_KEY)
    val sessionId = intent.getStringExtra(NotificationActionQueue.EXTRA_SESSION_ID)
    val requestId = intent.getStringExtra(NotificationActionQueue.EXTRA_REQUEST_ID)
    val optionId = intent.getStringExtra(NotificationActionQueue.EXTRA_OPTION_ID)
    val deepLink = intent.getStringExtra(NotificationActionQueue.EXTRA_DEEP_LINK)

    NotificationActionQueue.enqueue(
      context = context,
      actionId = actionId,
      kind = kind,
      computerKey = computerKey,
      sessionId = sessionId,
      requestId = requestId,
      optionId = optionId,
      deepLink = deepLink,
    )

    if (kind == "open") {
      // Fallback launch path only; primary "open" actions bind PendingIntent.getActivity directly
      // to respect Android 12+ notification trampoline restrictions.
      val launch = if (!deepLink.isNullOrEmpty()) {
        Intent(Intent.ACTION_VIEW, Uri.parse(deepLink)).apply {
          `package` = context.packageName
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
      } else {
        context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
      }
      if (launch != null) {
        runCatching { context.startActivity(launch) }
      }
      return
    }

    // Dismiss regular non-FGS attention notifications immediately for responsive feedback;
    // foreground service notifications stay synced through JS's next status sync.
    val notificationId = intent.getIntExtra(NotificationActionQueue.EXTRA_NOTIFICATION_ID, -1)
    if (notificationId > 0 && !ActiveSessionForegroundService.isRunning) {
      val manager = context.getSystemService(NotificationManager::class.java)
      runCatching { manager?.cancel(notificationId) }
    }
  }
}
