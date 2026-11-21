package expo.modules.linklayout

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * SharedPreferences-backed queue for Android notification button taps so cold-start or
 * backgrounded actions survive process death until JS consumes them.
 */
internal object NotificationActionQueue {
  private const val PREFS_NAME = "linkshell_notification_actions"
  private const val KEY_QUEUE = "queue_json"
  private const val MAX_ITEMS = 32

  const val EXTRA_FROM_NOTIFICATION = "linkshell_from_notification_action"
  const val EXTRA_ACTION_ID = "linkshell_action_id"
  const val EXTRA_KIND = "linkshell_kind"
  const val EXTRA_COMPUTER_KEY = "linkshell_computer_key"
  const val EXTRA_SESSION_ID = "linkshell_session_id"
  const val EXTRA_REQUEST_ID = "linkshell_request_id"
  const val EXTRA_OPTION_ID = "linkshell_option_id"
  const val EXTRA_DEEP_LINK = "linkshell_deep_link"
  const val EXTRA_NOTIFICATION_ID = "linkshell_notification_id"

  private val lock = Any()
  private val mainHandler = Handler(Looper.getMainLooper())

  @Volatile
  var onActionEnqueued: ((id: String) -> Unit)? = null

  fun enqueue(
    context: Context,
    actionId: String,
    kind: String,
    computerKey: String? = null,
    sessionId: String? = null,
    requestId: String? = null,
    optionId: String? = null,
    deepLink: String? = null,
  ): String {
    val appContext = context.applicationContext
    val id = UUID.randomUUID().toString()
    val createdAt = System.currentTimeMillis()
    val item = JSONObject().apply {
      put("id", id)
      put("actionId", actionId)
      put("kind", kind)
      put("createdAt", createdAt)
      if (!computerKey.isNullOrEmpty()) put("computerKey", computerKey)
      if (!sessionId.isNullOrEmpty()) put("sessionId", sessionId)
      if (!requestId.isNullOrEmpty()) put("requestId", requestId)
      if (!optionId.isNullOrEmpty()) put("optionId", optionId)
      if (!deepLink.isNullOrEmpty()) put("deepLink", deepLink)
    }

    synchronized(lock) {
      val existing = readArray(appContext)
      val next = JSONArray()
      val dropCount = maxOf(0, existing.length() - (MAX_ITEMS - 1))
      for (i in dropCount until existing.length()) {
        existing.optJSONObject(i)?.let { next.put(it) }
      }
      next.put(item)
      writeArray(appContext, next)
    }

    mainHandler.post {
      onActionEnqueued?.invoke(id)
    }
    return id
  }

  fun pendingId(context: Context): String? {
    val appContext = context.applicationContext
    synchronized(lock) {
      val array = readArray(appContext)
      if (array.length() == 0) return null
      return array.optJSONObject(0)?.optString("id")?.takeIf { it.isNotEmpty() }
    }
  }

  fun consume(context: Context, id: String): Map<String, Any?>? {
    val appContext = context.applicationContext
    synchronized(lock) {
      val array = readArray(appContext)
      var matched: JSONObject? = null
      val remaining = JSONArray()
      for (i in 0 until array.length()) {
        val obj = array.optJSONObject(i) ?: continue
        if (matched == null && obj.optString("id") == id) {
          matched = obj
        } else {
          remaining.put(obj)
        }
      }
      if (matched == null) return null
      writeArray(appContext, remaining)
      return toMap(matched)
    }
  }

  fun extractFromIntent(context: Context, intent: Intent?): String? {
    if (intent == null || !intent.getBooleanExtra(EXTRA_FROM_NOTIFICATION, false)) return null
    val actionId = intent.getStringExtra(EXTRA_ACTION_ID)?.takeIf { it.isNotEmpty() } ?: return null
    val kind = intent.getStringExtra(EXTRA_KIND)?.takeIf { it.isNotEmpty() } ?: "open"
    val computerKey = intent.getStringExtra(EXTRA_COMPUTER_KEY)
    val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
    val requestId = intent.getStringExtra(EXTRA_REQUEST_ID)
    val optionId = intent.getStringExtra(EXTRA_OPTION_ID)
    val deepLink = intent.getStringExtra(EXTRA_DEEP_LINK) ?: intent.dataString
    intent.removeExtra(EXTRA_FROM_NOTIFICATION)
    return enqueue(
      context = context,
      actionId = actionId,
      kind = kind,
      computerKey = computerKey,
      sessionId = sessionId,
      requestId = requestId,
      optionId = optionId,
      deepLink = deepLink,
    )
  }

  private fun readArray(context: Context): JSONArray {
    val raw = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(KEY_QUEUE, null)
      ?: return JSONArray()
    return runCatching { JSONArray(raw) }.getOrElse { JSONArray() }
  }

  private fun writeArray(context: Context, array: JSONArray) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_QUEUE, array.toString())
      .apply()
  }

  private fun toMap(obj: JSONObject): Map<String, Any?> {
    return mapOf(
      "id" to obj.optString("id"),
      "actionId" to obj.optString("actionId"),
      "kind" to obj.optString("kind"),
      "computerKey" to obj.optString("computerKey").takeIf { it.isNotEmpty() },
      "sessionId" to obj.optString("sessionId").takeIf { it.isNotEmpty() },
      "requestId" to obj.optString("requestId").takeIf { it.isNotEmpty() },
      "optionId" to obj.optString("optionId").takeIf { it.isNotEmpty() },
      "deepLink" to obj.optString("deepLink").takeIf { it.isNotEmpty() },
      "createdAt" to obj.optDouble("createdAt", System.currentTimeMillis().toDouble()),
    )
  }
}
