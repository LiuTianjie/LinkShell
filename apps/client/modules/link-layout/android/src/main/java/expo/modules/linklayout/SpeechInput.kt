package expo.modules.linklayout

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import expo.modules.kotlin.Promise
import java.util.Locale

/** One foreground dictation session; the installed system service owns recognition. */
internal class SpeechInput(private val context: Context, private val emit: (String, Map<String, Any>) -> Unit) {
  private val handler = Handler(Looper.getMainLooper())
  private var recognizer: SpeechRecognizer? = null
  private var generation = 0
  private var transcript = ""
  private val waiting = mutableListOf<Promise>()
  private var timeout: Runnable? = null

  fun start(localeId: String?): Map<String, Any> {
    cancel()
    transcript = ""
    if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      return mapOf("ok" to false, "reason" to "请在系统设置中允许 LinkShell 使用麦克风")
    }
    if (!SpeechRecognizer.isRecognitionAvailable(context)) {
      return mapOf("ok" to false, "reason" to "手机未提供系统语音识别服务，请启用语音识别服务，或使用输入法的语音输入")
    }
    val current = ++generation
    return try {
      val service = SpeechRecognizer.createSpeechRecognizer(context)
      recognizer = service
      service.setRecognitionListener(object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEvent(eventType: Int, params: Bundle?) {}
        override fun onRmsChanged(rmsdB: Float) {
          if (current == generation) emit("onSpeechLevel", mapOf("db" to rmsdB, "level" to ((rmsdB + 2f) / 12f).coerceIn(0.08f, 1f)))
        }
        override fun onEndOfSpeech() {
          if (current == generation) armTimeout(current)
        }
        override fun onPartialResults(partialResults: Bundle?) {
          if (current != generation) return
          update(partialResults, false)
        }
        override fun onResults(results: Bundle?) {
          if (current != generation) return
          update(results, true)
          release()
        }
        override fun onError(error: Int) {
          if (current != generation) return
          val message = when (error) {
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "请在系统设置中允许 LinkShell 使用麦克风"
            SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "语音识别网络连接失败，请重试或使用输入法语音输入"
            SpeechRecognizer.ERROR_AUDIO -> "无法使用麦克风，请检查是否被其他应用占用"
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "系统语音识别服务正忙，请稍后重试"
            SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "没有识别到语音，请再试一次"
            else -> "系统语音识别暂不可用，请重试或使用输入法语音输入"
          }
          emit("onSpeechError", mapOf("message" to message))
          release(message)
        }
      })
      service.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, localeId ?: Locale.getDefault().toLanguageTag())
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
      })
      mapOf("ok" to true)
    } catch (_: Exception) {
      release()
      mapOf("ok" to false, "reason" to "无法启动系统语音识别，请检查麦克风权限和语音服务")
    }
  }

  private fun update(results: Bundle?, final: Boolean) {
    results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { transcript = it }
    emit("onSpeechResult", mapOf("text" to transcript, "isFinal" to final))
  }

  fun stop(promise: Promise) {
    val service = recognizer
    if (service == null) { promise.resolve(mapOf("text" to transcript)); return }
    waiting += promise
    if (waiting.size > 1) return
    armTimeout(generation)
    try { service.stopListening() } catch (_: Exception) { release("无法完成语音识别，请重试") }
  }

  private fun armTimeout(current: Int) {
    if (timeout != null) return
    timeout = Runnable {
      if (current != generation) return@Runnable
      // Never leave the microphone or the Finish action waiting indefinitely.
      emit("onSpeechError", mapOf("message" to "语音识别等待超时，已保留识别出的文字，请重试"))
      release("语音识别等待超时，已保留识别出的文字，请重试")
    }.also { handler.postDelayed(it, 5000) }
  }

  fun cancel() { release("语音输入已取消") }

  private fun release(error: String? = null) {
    ++generation
    timeout?.let(handler::removeCallbacks)
    timeout = null
    val service = recognizer
    recognizer = null
    try { service?.cancel() } catch (_: Exception) { }
    try { service?.destroy() } catch (_: Exception) { }
    val promises = waiting.toList()
    waiting.clear()
    // Promise completion can arrive before the error event on the JS thread.
    // Reject failed/cancelled stops so partial text cannot be mistaken for a final send.
    promises.forEach {
      if (error == null) it.resolve(mapOf("text" to transcript))
      else it.reject("ERR_SPEECH_RECOGNITION", error, null)
    }
  }
}
