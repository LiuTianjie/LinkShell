package expo.modules.linkterminal

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.fonts.Font
import android.graphics.fonts.FontFamily
import android.os.Build
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.inputmethod.InputMethodManager
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import com.termux.terminal.TextStyle
import com.termux.view.TerminalView
import com.termux.view.TerminalViewClient
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.File
import kotlin.math.roundToInt

/**
 * Termux's terminal view (native rendering, native IME handling) wired to a
 * remote shell: output arrives through `write`, keys leave through `onInput`.
 */
class LinkTerminalView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onInput by EventDispatcher()
  private val onResize by EventDispatcher()

  private val terminal = TerminalView(context, null)
  private var theme: Map<String, String> = emptyMap()
  private var fontSizeSp = 13.0
  private var lastSize = ""

  private val sessionClient = object : TerminalSessionClient {
    override fun onTextChanged(changedSession: TerminalSession) = terminal.onScreenUpdated()
    override fun onTitleChanged(changedSession: TerminalSession) {}
    override fun onSessionFinished(finishedSession: TerminalSession) {}
    override fun onCopyTextToClipboard(session: TerminalSession, text: String?) {
      val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      clipboard.setPrimaryClip(ClipData.newPlainText("", text ?: ""))
    }
    override fun onPasteTextFromClipboard(session: TerminalSession?) {
      val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      val text = clipboard.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString() ?: return
      terminal.mEmulator?.paste(text)
    }
    override fun onBell(session: TerminalSession) {}
    override fun onColorsChanged(session: TerminalSession) {}
    override fun onTerminalCursorStateChange(state: Boolean) {}
    override fun getTerminalCursorStyle(): Int? = null
    override fun logError(tag: String?, message: String?) {}
    override fun logWarn(tag: String?, message: String?) {}
    override fun logInfo(tag: String?, message: String?) {}
    override fun logDebug(tag: String?, message: String?) {}
    override fun logVerbose(tag: String?, message: String?) {}
    override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) {}
    override fun logStackTrace(tag: String?, e: Exception?) {}
  }

  private val session = TerminalSession(
    object : TerminalSession.Remote {
      override fun input(data: ByteArray) {
        onInput(mapOf("data" to String(data, Charsets.UTF_8)))
      }

      override fun resize(columns: Int, rows: Int) {
        val size = "${columns}x$rows"
        if (size == lastSize) return
        lastSize = size
        onResize(mapOf("cols" to columns, "rows" to rows))
      }
    },
    5000,
    sessionClient,
  )

  private val viewClient = object : TerminalViewClient {
    override fun onScale(scale: Float): Float = 1f
    override fun onSingleTapUp(e: MotionEvent?) = showKeyboard()
    override fun shouldBackButtonBeMappedToEscape(): Boolean = false
    // Termux's default: TYPE_NULL input, which lets IMEs (Chinese, Japanese…) compose in place.
    override fun shouldEnforceCharBasedInput(): Boolean = false
    override fun shouldUseCtrlSpaceWorkaround(): Boolean = false
    override fun isTerminalViewSelected(): Boolean = true
    override fun copyModeChanged(copyMode: Boolean) {}
    override fun onKeyDown(keyCode: Int, e: KeyEvent?, session: TerminalSession?): Boolean = false
    override fun onKeyUp(keyCode: Int, e: KeyEvent?): Boolean = false
    override fun onLongPress(event: MotionEvent?): Boolean = false
    override fun readControlKey(): Boolean = false
    override fun readAltKey(): Boolean = false
    override fun readShiftKey(): Boolean = false
    override fun readFnKey(): Boolean = false
    override fun onCodePoint(codePoint: Int, ctrlDown: Boolean, session: TerminalSession?): Boolean = false
    override fun onEmulatorSet() = applyTheme()
    override fun logError(tag: String?, message: String?) {}
    override fun logWarn(tag: String?, message: String?) {}
    override fun logInfo(tag: String?, message: String?) {}
    override fun logDebug(tag: String?, message: String?) {}
    override fun logVerbose(tag: String?, message: String?) {}
    override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) {}
    override fun logStackTrace(tag: String?, e: Exception?) {}
  }

  init {
    terminal.setTerminalViewClient(viewClient)
    terminal.isFocusable = true
    terminal.isFocusableInTouchMode = true
    applyFontSize()
    terminal.setTypeface(terminalTypeface())
    terminal.attachSession(session)
    addView(terminal, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  /** Breathing room on the left, like the iOS terminal. */
  private val inset get() = (8 * resources.displayMetrics.density).roundToInt()

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    terminal.layout(inset, 0, r - l, b - t)
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    val width = (w - inset).coerceAtLeast(0)
    terminal.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
    terminal.layout(inset, 0, w, h)
  }

  fun write(data: String) {
    session.feed(data.toByteArray(Charsets.UTF_8))
  }

  fun reset() {
    session.reset()
    applyTheme()
  }

  fun finish(message: String) = session.finish(message)

  fun setTheme(value: Map<String, String>) {
    theme = value
    applyTheme()
  }

  fun setFontSize(size: Double) {
    fontSizeSp = size
    applyFontSize()
  }

  fun showKeyboard() {
    terminal.requestFocus()
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
    imm.showSoftInput(terminal, 0)
  }

  fun hideKeyboard() {
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
    imm.hideSoftInputFromWindow(terminal.windowToken, 0)
    terminal.clearFocus()
  }

  /**
   * The system monospace face, with the bundled Nerd Font symbols as its
   * fallback so prompt icons (starship, powerlevel10k) draw instead of boxes.
   * The monospace face stays primary: it sets the cell size and line metrics.
   */
  private fun terminalTypeface(): Typeface {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return Typeface.MONOSPACE
    return try {
      val symbols = FontFamily.Builder(Font.Builder(context.assets, "fonts/LinkShellSymbols.ttf").build()).build()
      val mono = File("/system/fonts/DroidSansMono.ttf")
      val builder =
        if (mono.exists()) {
          Typeface.CustomFallbackBuilder(FontFamily.Builder(Font.Builder(mono).build()).build()).addCustomFallback(symbols)
        } else {
          Typeface.CustomFallbackBuilder(symbols)
        }
      builder.setSystemFallback("monospace").build()
    } catch (e: Exception) {
      Typeface.MONOSPACE
    }
  }

  private fun applyFontSize() {
    val px = (fontSizeSp * resources.displayMetrics.scaledDensity).roundToInt()
    terminal.setTextSize(px)
  }

  private val ansiNames = listOf(
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
  )

  private fun parse(value: String?): Int? = try {
    if (value == null) null else Color.parseColor(value)
  } catch (_: IllegalArgumentException) {
    null
  }

  private fun applyTheme() {
    parse(theme["background"])?.let { setBackgroundColor(it); terminal.setBackgroundColor(it) }
    val colors = terminal.mEmulator?.mColors?.mCurrentColors ?: return
    ansiNames.forEachIndexed { index, name -> parse(theme[name])?.let { colors[index] = it } }
    parse(theme["foreground"])?.let { colors[TextStyle.COLOR_INDEX_FOREGROUND] = it }
    parse(theme["background"])?.let { colors[TextStyle.COLOR_INDEX_BACKGROUND] = it }
    parse(theme["cursor"])?.let { colors[TextStyle.COLOR_INDEX_CURSOR] = it }
    terminal.onScreenUpdated()
  }
}
