package expo.modules.linklayout

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * Keeps LinkShell's persistent active-session / pending-approval status notification alive in a
 * `dataSync` foreground service when requested by JS, and shares one notification builder with
 * non-FGS status notifications.
 */
class ActiveSessionForegroundService : Service() {
  companion object {
    const val ATTENTION_CHANNEL_ID = "linkshell_attention"
    const val PROGRESS_CHANNEL_ID = "linkshell_progress"
    const val STATUS_NOTIFICATION_ID = 4210
    // Canonical LinkShell brand indigo (`accentFill` dark in apps/client/src/theme/brand-colors.json).
    private const val BRAND_INDIGO = 0xFF5263E8.toInt()

    const val ACTION_SYNC = "expo.modules.linklayout.FGS_SYNC"
    const val ACTION_STOP = "expo.modules.linklayout.FGS_STOP"

    const val EXTRA_TITLE = "title"
    const val EXTRA_SUBTITLE = "subtitle"
    const val EXTRA_COMPUTER_NAME = "computerName"
    const val EXTRA_URGENT = "urgent"
    const val EXTRA_ONGOING = "ongoing"
    const val EXTRA_DEEP_LINK = "deepLink"
    const val EXTRA_ACTIONS_JSON = "actionsJson"
    const val EXTRA_REMOVE_NOTIFICATION = "removeNotification"
    private const val EXTRA_START_GENERATION = "startGeneration"

    private val stateLock = Any()

    @Volatile
    var isRunning: Boolean = false
      private set

    @Volatile
    private var startPending: Boolean = false

    @Volatile
    private var stopPending: Boolean = false

    @Volatile
    private var stopPendingRemoveNotification: Boolean = true

    @Volatile
    private var startGeneration: Long = 0L

    fun ensureChannels(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      if (manager.getNotificationChannel(ATTENTION_CHANNEL_ID) == null) {
        val attention = NotificationChannel(
          ATTENTION_CHANNEL_ID,
          "LinkShell Attention",
          NotificationManager.IMPORTANCE_HIGH,
        ).apply {
          description = "Approvals, questions, and failed agent turns"
          enableLights(true)
          lightColor = BRAND_INDIGO
          enableVibration(true)
        }
        manager.createNotificationChannel(attention)
      }
      if (manager.getNotificationChannel(PROGRESS_CHANNEL_ID) == null) {
        val progress = NotificationChannel(
          PROGRESS_CHANNEL_ID,
          "LinkShell Background Progress",
          NotificationManager.IMPORTANCE_LOW,
        ).apply {
          description = "Ongoing remote coding session progress"
          setShowBadge(false)
          setSound(null, null)
          enableVibration(false)
        }
        manager.createNotificationChannel(progress)
      }
    }

    fun startOrUpdate(
      context: Context,
      title: String,
      subtitle: String,
      computerName: String?,
      urgent: Boolean,
      ongoing: Boolean,
      deepLink: String,
      actionsJson: String?,
    ): Boolean {
      ensureChannels(context)
      val gen: Long
      synchronized(stateLock) {
        startGeneration += 1L
        gen = startGeneration
        startPending = true
        stopPending = false
      }
      val intent = Intent(context, ActiveSessionForegroundService::class.java).apply {
        action = ACTION_SYNC
        putExtra(EXTRA_TITLE, title)
        putExtra(EXTRA_SUBTITLE, subtitle)
        if (!computerName.isNullOrEmpty()) putExtra(EXTRA_COMPUTER_NAME, computerName)
        putExtra(EXTRA_URGENT, urgent)
        putExtra(EXTRA_ONGOING, ongoing)
        putExtra(EXTRA_DEEP_LINK, deepLink)
        if (!actionsJson.isNullOrEmpty()) putExtra(EXTRA_ACTIONS_JSON, actionsJson)
        putExtra(EXTRA_START_GENERATION, gen)
      }
      return try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
        true
      } catch (_: Throwable) {
        synchronized(stateLock) {
          if (startGeneration == gen) {
            startPending = false
          }
        }
        // Android 12+ throws ForegroundServiceStartNotAllowedException when starting FGS from
        // the background; callers fall back to a regular NotificationManager notification.
        false
      }
    }

    fun stop(context: Context, removeNotification: Boolean = true) {
      val wasRunning: Boolean
      val wasPending: Boolean
      synchronized(stateLock) {
        wasRunning = isRunning
        wasPending = startPending
        if (!wasRunning && !wasPending) return
        stopPending = true
        stopPendingRemoveNotification = removeNotification
      }
      if (!wasRunning) {
        // A startForegroundService() is already in flight: let onStartCommand() satisfy the
        // startForeground() contract and immediately stop itself so Android never raises
        // ForegroundServiceDidNotStartInTimeException and no orphan FGS remains.
        return
      }
      val stopIntent = Intent(context, ActiveSessionForegroundService::class.java).apply {
        action = ACTION_STOP
        putExtra(EXTRA_REMOVE_NOTIFICATION, removeNotification)
      }
      runCatching { context.startService(stopIntent) }
        .onFailure {
          runCatching { context.stopService(Intent(context, ActiveSessionForegroundService::class.java)) }
          synchronized(stateLock) {
            isRunning = false
            startPending = false
            stopPending = false
          }
        }
    }

    fun buildNotification(
      context: Context,
      title: String,
      subtitle: String,
      computerName: String?,
      urgent: Boolean,
      ongoing: Boolean,
      deepLink: String,
      actionsJson: String?,
    ): Notification {
      ensureChannels(context)
      val channelId = if (urgent) ATTENTION_CHANNEL_ID else PROGRESS_CHANNEL_ID
      val openPendingIntent = buildOpenPendingIntent(
        context = context,
        requestCode = STATUS_NOTIFICATION_ID,
        deepLink = deepLink,
        actionId = null,
        kind = null,
        computerKey = null,
        sessionId = null,
        requestId = null,
        optionId = null,
      )

      // Use our dedicated monochrome vector icon so Android never renders a solid white square.
      val iconRes = R.drawable.ic_linkshell_notification

      val builder = NotificationCompat.Builder(context, channelId)
        .setSmallIcon(iconRes)
        .setContentTitle(title)
        .setContentText(subtitle)
        .setColor(BRAND_INDIGO)
        .setOngoing(ongoing)
        .setAutoCancel(!ongoing)
        .setOnlyAlertOnce(!urgent)
        .setSilent(!urgent)
        .setCategory(if (urgent) NotificationCompat.CATEGORY_MESSAGE else NotificationCompat.CATEGORY_SERVICE)
        .setPriority(if (urgent) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_LOW)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)

      if (!computerName.isNullOrBlank()) {
        builder.setSubText(computerName)
      }
      if (subtitle.length > 48) {
        builder.setStyle(NotificationCompat.BigTextStyle().bigText(subtitle))
      }
      if (openPendingIntent != null) {
        builder.setContentIntent(openPendingIntent)
      }

      if (!actionsJson.isNullOrEmpty()) {
        val actions = runCatching { JSONArray(actionsJson) }.getOrNull()
        if (actions != null) {
          val count = minOf(actions.length(), 3)
          for (index in 0 until count) {
            val item = actions.optJSONObject(index) ?: continue
            val actionId = item.optString("id").takeIf { it.isNotEmpty() } ?: continue
            val actionTitle = item.optString("label").takeIf { it.isNotEmpty() } ?: continue
            val kind = item.optString("kind").takeIf { it.isNotEmpty() } ?: "open"
            val computerKey = item.optString("computerKey").takeIf { it.isNotEmpty() }
            val sessionId = item.optString("sessionId").takeIf { it.isNotEmpty() }
            val requestId = item.optString("requestId").takeIf { it.isNotEmpty() }
            val optionId = item.optString("optionId").takeIf { it.isNotEmpty() }
            val actionDeepLink = item.optString("deepLink").takeIf { it.startsWith("linkshell") } ?: deepLink

            val pendingIntent = if (kind == "open") {
              buildOpenPendingIntent(
                context = context,
                requestCode = STATUS_NOTIFICATION_ID + 10 + index,
                deepLink = actionDeepLink,
                actionId = actionId,
                kind = kind,
                computerKey = computerKey,
                sessionId = sessionId,
                requestId = requestId,
                optionId = optionId,
              )
            } else {
              buildBroadcastPendingIntent(
                context = context,
                requestCode = STATUS_NOTIFICATION_ID + 10 + index,
                actionId = actionId,
                kind = kind,
                computerKey = computerKey,
                sessionId = sessionId,
                requestId = requestId,
                optionId = optionId,
                deepLink = actionDeepLink,
              )
            }
            if (pendingIntent != null) {
              builder.addAction(0, actionTitle, pendingIntent)
            }
          }
        }
      }

      return builder.build()
    }

    fun actionsToJson(actionsRaw: List<*>?): String? {
      if (actionsRaw.isNullOrEmpty()) return null
      val array = JSONArray()
      for (entry in actionsRaw) {
        val map = entry as? Map<*, *> ?: continue
        val actionId = map["id"] as? String ?: continue
        val label = map["label"] as? String ?: continue
        val obj = JSONObject().apply {
          put("id", actionId)
          put("label", label)
          (map["kind"] as? String)?.let { put("kind", it) }
          (map["computerKey"] as? String)?.let { put("computerKey", it) }
          (map["sessionId"] as? String)?.let { put("sessionId", it) }
          (map["requestId"] as? String)?.let { put("requestId", it) }
          (map["optionId"] as? String)?.let { put("optionId", it) }
          (map["deepLink"] as? String)?.let { put("deepLink", it) }
        }
        array.put(obj)
      }
      return if (array.length() > 0) array.toString() else null
    }

    private fun buildOpenPendingIntent(
      context: Context,
      requestCode: Int,
      deepLink: String,
      actionId: String?,
      kind: String?,
      computerKey: String?,
      sessionId: String?,
      requestId: String?,
      optionId: String?,
    ): PendingIntent? {
      val launchIntent = Intent(Intent.ACTION_VIEW, Uri.parse(deepLink)).apply {
        setPackage(context.packageName)
        addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      }
      // "open" actions navigate solely via the ACTION_VIEW deep link; attaching EXTRA_FROM_NOTIFICATION
      // as well would also enqueue an action and trigger a duplicate router.push().
      if (!actionId.isNullOrEmpty() && !kind.isNullOrEmpty() && kind != "open") {
        launchIntent.putExtra(NotificationActionQueue.EXTRA_FROM_NOTIFICATION, true)
        launchIntent.putExtra(NotificationActionQueue.EXTRA_ACTION_ID, actionId)
        launchIntent.putExtra(NotificationActionQueue.EXTRA_KIND, kind)
        if (!computerKey.isNullOrEmpty()) launchIntent.putExtra(NotificationActionQueue.EXTRA_COMPUTER_KEY, computerKey)
        if (!sessionId.isNullOrEmpty()) launchIntent.putExtra(NotificationActionQueue.EXTRA_SESSION_ID, sessionId)
        if (!requestId.isNullOrEmpty()) launchIntent.putExtra(NotificationActionQueue.EXTRA_REQUEST_ID, requestId)
        if (!optionId.isNullOrEmpty()) launchIntent.putExtra(NotificationActionQueue.EXTRA_OPTION_ID, optionId)
        launchIntent.putExtra(NotificationActionQueue.EXTRA_DEEP_LINK, deepLink)
      }
      return PendingIntent.getActivity(
        context,
        requestCode,
        launchIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    private fun buildBroadcastPendingIntent(
      context: Context,
      requestCode: Int,
      actionId: String,
      kind: String,
      computerKey: String?,
      sessionId: String?,
      requestId: String?,
      optionId: String?,
      deepLink: String?,
    ): PendingIntent {
      val intent = Intent(context, NotificationActionReceiver::class.java).apply {
        action = NotificationActionReceiver.ACTION_NOTIFICATION_BUTTON
        putExtra(NotificationActionQueue.EXTRA_ACTION_ID, actionId)
        putExtra(NotificationActionQueue.EXTRA_KIND, kind)
        putExtra(NotificationActionQueue.EXTRA_NOTIFICATION_ID, STATUS_NOTIFICATION_ID)
        if (!computerKey.isNullOrEmpty()) putExtra(NotificationActionQueue.EXTRA_COMPUTER_KEY, computerKey)
        if (!sessionId.isNullOrEmpty()) putExtra(NotificationActionQueue.EXTRA_SESSION_ID, sessionId)
        if (!requestId.isNullOrEmpty()) putExtra(NotificationActionQueue.EXTRA_REQUEST_ID, requestId)
        if (!optionId.isNullOrEmpty()) putExtra(NotificationActionQueue.EXTRA_OPTION_ID, optionId)
        if (!deepLink.isNullOrEmpty()) putExtra(NotificationActionQueue.EXTRA_DEEP_LINK, deepLink)
      }
      return PendingIntent.getBroadcast(
        context,
        requestCode,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      val remove = intent.getBooleanExtra(EXTRA_REMOVE_NOTIFICATION, true)
      synchronized(stateLock) {
        isRunning = false
        startPending = false
        stopPending = false
      }
      stopForegroundCompat(remove)
      if (remove) {
        runCatching { getSystemService(NotificationManager::class.java)?.cancel(STATUS_NOTIFICATION_ID) }
      }
      stopSelf(startId)
      return START_NOT_STICKY
    }

    val title = intent?.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotBlank() } ?: "LinkShell"
    val subtitle = intent?.getStringExtra(EXTRA_SUBTITLE) ?: ""
    val computerName = intent?.getStringExtra(EXTRA_COMPUTER_NAME)
    val urgent = intent?.getBooleanExtra(EXTRA_URGENT, false) ?: false
    val ongoing = intent?.getBooleanExtra(EXTRA_ONGOING, true) ?: true
    val deepLink = intent?.getStringExtra(EXTRA_DEEP_LINK)?.takeIf { it.startsWith("linkshell") } ?: "linkshell:///"
    val actionsJson = intent?.getStringExtra(EXTRA_ACTIONS_JSON)
    val intentGen = intent?.getLongExtra(EXTRA_START_GENERATION, 0L) ?: 0L

    val notification = buildNotification(
      context = this,
      title = title,
      subtitle = subtitle,
      computerName = computerName,
      urgent = urgent,
      ongoing = ongoing,
      deepLink = deepLink,
      actionsJson = actionsJson,
    )

    val shouldAbort: Boolean
    val removeOnAbort: Boolean
    synchronized(stateLock) {
      shouldAbort = stopPending || (intentGen != 0L && intentGen < startGeneration)
      removeOnAbort = stopPendingRemoveNotification
    }

    val promoted = try {
      // Always fulfill startForeground() when launched via startForegroundService(), even if
      // stop() raced before onStartCommand(), to prevent ForegroundServiceDidNotStartInTimeException.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          STATUS_NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
      } else {
        startForeground(STATUS_NOTIFICATION_ID, notification)
      }
      true
    } catch (_: Throwable) {
      false
    }

    if (shouldAbort) {
      synchronized(stateLock) {
        isRunning = false
        if (intentGen == 0L || intentGen >= startGeneration) {
          startPending = false
          stopPending = false
        }
      }
      if (promoted) {
        stopForegroundCompat(removeOnAbort)
      }
      if (removeOnAbort) {
        runCatching { getSystemService(NotificationManager::class.java)?.cancel(STATUS_NOTIFICATION_ID) }
      }
      stopSelf(startId)
      return START_NOT_STICKY
    }

    if (promoted) {
      synchronized(stateLock) {
        isRunning = true
        if (intentGen == 0L || intentGen >= startGeneration) {
          startPending = false
        }
      }
    } else {
      synchronized(stateLock) {
        isRunning = false
        if (intentGen == 0L || intentGen >= startGeneration) {
          startPending = false
        }
      }
      runCatching {
        val manager = getSystemService(NotificationManager::class.java)
        manager?.notify(STATUS_NOTIFICATION_ID, notification)
      }
      stopSelf(startId)
    }
    return START_NOT_STICKY
  }

  // Required on Android 15+ (targetSdk 35/36) for dataSync foreground services to avoid RemoteServiceException.
  override fun onTimeout(startId: Int, fgsType: Int) {
    synchronized(stateLock) {
      isRunning = false
      startPending = false
      stopPending = false
    }
    runCatching { stopForegroundCompat(removeNotification = false) }
    stopSelf(startId)
  }

  override fun onDestroy() {
    synchronized(stateLock) {
      isRunning = false
      startPending = false
      stopPending = false
    }
    super.onDestroy()
  }

  @Suppress("DEPRECATION")
  private fun stopForegroundCompat(removeNotification: Boolean) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(if (removeNotification) STOP_FOREGROUND_REMOVE else STOP_FOREGROUND_DETACH)
    } else {
      stopForeground(removeNotification)
    }
  }
}
