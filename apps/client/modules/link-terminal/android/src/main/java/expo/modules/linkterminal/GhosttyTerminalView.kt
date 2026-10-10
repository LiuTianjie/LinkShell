package expo.modules.linkterminal

import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.Typeface
import android.provider.Settings
import android.text.InputType
import android.view.ActionMode
import android.view.Choreographer
import android.view.GestureDetector
import android.view.HapticFeedbackConstants
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.OverScroller
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Ghostty terminal grid rendered through hardware display lists.
 *
 * Owns a libghostty-vt session via [GhosttyVt]. PTY output is fed in with
 * [write]; user input (IME text, key escape sequences, VT query responses)
 * comes back through [onInputBytes]. Rendering pulls flattened dirty-row
 * snapshots from JNI once per Choreographer frame and records dirty rows.
 * [onDraw] reuses those GPU commands and overlays images, selection and IME text.
 */
internal class GhosttyTerminalView(context: Context) : View(context) {
  var onFontSizeChanged: ((Float) -> Unit)? = null
  var onInputBytes: ((ByteArray) -> Unit)? = null
  var onGridResize: ((cols: Int, rows: Int) -> Unit)? = null
  var onBell: (() -> Unit)? = null
  var onTitleChange: ((title: String) -> Unit)? = null
  var onDirectoryChange: ((path: String) -> Unit)? = null

  private val pressedSticky = mutableMapOf<Int, Int>()

  private var handle: Long = GhosttyVt.nativeCreate(INITIAL_COLS, INITIAL_ROWS, MAX_SCROLLBACK)
  private var finished = false

  // ── Cell metrics ──
  private var fontSizeDp = FONT_SIZE_DP
  private val textPaint = newTextPaint(Typeface.MONOSPACE)
  private val boldPaint = newTextPaint(Typeface.create(Typeface.MONOSPACE, Typeface.BOLD))
  private val italicPaint = newTextPaint(Typeface.create(Typeface.MONOSPACE, Typeface.ITALIC))
  private val boldItalicPaint =
    newTextPaint(Typeface.create(Typeface.MONOSPACE, Typeface.BOLD_ITALIC))

  // Nerd Font private-use glyphs (powerline, devicons, …) are absent from the
  // system fallback chain; route those cells to the bundled symbols-only font.
  private val symbolsPaint: Paint? = try {
    newTextPaint(Typeface.createFromAsset(context.assets, SYMBOLS_FONT_ASSET))
  } catch (e: RuntimeException) {
    null
  }
  private val fillPaint = Paint()
  private val cursorPaint = Paint()
  private var cellWidth = textPaint.measureText("M")
  private var cellHeight = ceil(
    textPaint.fontMetrics.descent - textPaint.fontMetrics.ascent
  ).toInt()
  private var baseline = -textPaint.fontMetrics.ascent
  private val underlineThickness = max(1f, resources.displayMetrics.density)

  // ── Grid state ──
  private var cols = INITIAL_COLS
  private var rows = INITIAL_ROWS
  private var backgroundRows = emptyArray<TerminalRowLayer>()
  private var textRows = emptyArray<TerminalRowLayer>()
  private val graphics = TerminalGraphics()
  var restoring = false
  var ctrlArmed = false
  var onCtrlChanged: ((Boolean) -> Unit)? = null
  var onImportUri: ((android.net.Uri, (() -> Unit)?) -> Unit)? = null
  private var replaySize: Pair<Int, Int>? = null
  private var snapshotBuf: ByteBuffer? = null
  private var rowChars = CharArray(0)
  private var cellFg = IntArray(0)
  private var cellBg = IntArray(0)
  private var cellTextOff = IntArray(0)
  private var cellTextLen = IntArray(0)
  private var cellFlags = IntArray(0)
  private var rowSelStart = IntArray(0)
  private var rowSelEnd = IntArray(0)
  private var rowSelEndWide = BooleanArray(0)

  // ── Selection state ──
  private var selectionMode = false
  private var actionMode: ActionMode? = null
  private var draggingHandle = HANDLE_NONE
  private var dragAnchorCol = 0
  private var dragAnchorRow = 0
  private var dragBiasRows = 0
  private var lastPressCol = 0
  private var lastPressRow = 0
  private val handlePaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val handleRadius = HANDLE_RADIUS_DP * resources.displayMetrics.density
  private val magnifier =
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
      android.widget.Magnifier(this)
    } else {
      null
    }

  private var defaultBg = 0xFF000000.toInt()
  private var defaultFg = 0xFFFFFFFF.toInt()
  // Themed selection colors; when unset, selected cells keep the classic
  // fg/bg swap. Cursor color rides the snapshot header (0 = unconfigured).
  private var selectionBg: Int? = null
  private var selectionFg: Int? = null
  private var cursorColor = 0
  private var cursorX = -1
  private var cursorY = -1
  private var cursorStyle = CURSOR_STYLE_BLOCK
  private var cursorVisible = false
  private var cursorBlinks = false

  // Cursor blinking only reuses cached display lists; glyphs are not rasterized again.
  private var blinkPhaseOn = true
  private var blinkScheduled = false
  private val blinkRunnable = object : Runnable {
    override fun run() {
      if (!blinkScheduled) return
      blinkPhaseOn = !blinkPhaseOn
      invalidate()
      postDelayed(this, BLINK_INTERVAL_MS)
    }
  }

  private var composition = ""
  private val synchronizedFrame = Runnable { scheduleFrame() }
  private var framePending = false
  private val frameCallback = Choreographer.FrameCallback {
    framePending = false
    renderFrame()
  }

  private var scrollAccum = 0f
  private var mouseScrollAccum = 0f
  private var scrollX = 0f
  private var scrollY = 0f
  private var scrollingProgram = false

  // ── Scrollback state ──
  private val scroller = OverScroller(context)
  private var flingLastY = 0
  internal fun scrollByPixels(delta: Float) {
    if (handle == 0L) return
    val captured = GhosttyVt.nativeMouseCaptured(handle)
    if (captured != scrollingProgram) {
      scrollAccum = 0f
      mouseScrollAccum = 0f
      scrollingProgram = captured
    }
    if (captured) {
      // TUI history belongs to the application. Retain fractional motion,
      // but never translate its fixed header/prompt as local scrollback.
      mouseScrollAccum += delta
      val whole = (mouseScrollAccum / cellHeight).toInt()
      mouseScrollAccum -= whole * cellHeight
      if (whole != 0 && !restoring) {
        GhosttyVt.nativeMouseScroll(handle, whole, scrollX, scrollY)?.let { onInputBytes?.invoke(it) }
      }
      return
    }
    val before = GhosttyVt.nativeScrollbar(handle) ?: return
    scrollAccum += delta
    val whole = (scrollAccum / cellHeight).toInt()
    if (whole != 0) GhosttyVt.nativeScroll(handle, whole)
    val after = GhosttyVt.nativeScrollbar(handle) ?: return
    scrollAccum -= (after[1] - before[1]) * cellHeight
    if ((after[1] == 0L && scrollAccum < 0) || (after[1] + after[2] >= after[0] && scrollAccum > 0)) scrollAccum = 0f
    markScrollActivity()
    if (whole != 0) scheduleFrame() else invalidate()
  }
  private var scrollbarTotal = 0L
  private var scrollbarOffset = 0L
  private var scrollbarLen = 0L
  private var lastScrollActivityAt = 0L
  private val scrollbarPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val jumpChipPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val jumpChipArrow = Path()
  private val flingRunnable = object : Runnable {
    override fun run() {
      if (handle == 0L || !scroller.computeScrollOffset()) return
      val y = scroller.currY
      scrollByPixels((y - flingLastY).toFloat())
      flingLastY = y
      postOnAnimation(this)
    }
  }

  private val gestureDetector = GestureDetector(
    context,
    object : GestureDetector.SimpleOnGestureListener() {
      override fun onDown(e: MotionEvent) = true

      override fun onSingleTapUp(e: MotionEvent): Boolean {
        if (scrollbarTotal > 0 && scrollbarOffset + scrollbarLen < scrollbarTotal) {
          val (cx, cy) = jumpChipCenter()
          val slop = JUMP_CHIP_RADIUS_DP * 1.5f * resources.displayMetrics.density
          if (hypot(e.x - cx, e.y - cy) <= slop) {
            GhosttyVt.nativeScrollToBottom(handle)
            scrollAccum = 0f
            scheduleFrame()
            return true
          }
        }
        if (selectionMode || actionMode != null) {
          clearSelection()
          return true
        }
        requestFocus()
        context.getSystemService(InputMethodManager::class.java)
          ?.showSoftInput(this@GhosttyTerminalView, 0)
        return true
      }

      override fun onLongPress(e: MotionEvent) {
        if (handle == 0L || finished || scaleDetector.isInProgress) return
        lastPressCol = (e.x / cellWidth).toInt().coerceIn(0, cols - 1)
        lastPressRow = ((e.y + scrollAccum) / cellHeight).toInt().coerceIn(0, rows - 1)
        performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        selectionMode = GhosttyVt.nativeSelectWord(handle, lastPressCol, lastPressRow)
        scheduleFrame()
        if (selectionMode) {
          // Keep dragging without lifting: extend from the pressed cell.
          draggingHandle = HANDLE_END
          dragAnchorCol = lastPressCol
          dragAnchorRow = lastPressRow
          dragBiasRows = 0
        } else {
          // Even without a word under the finger, offer Paste / Select all.
          startTerminalActionMode()
        }
      }

      override fun onScroll(
        e1: MotionEvent?,
        e2: MotionEvent,
        distanceX: Float,
        distanceY: Float
      ): Boolean {
        if (handle == 0L || scaleDetector.isInProgress) return false
        scrollX = e2.x
        scrollY = e2.y
        scrollByPixels(distanceY)
        return true
      }

      override fun onFling(
        e1: MotionEvent?,
        e2: MotionEvent,
        velocityX: Float,
        velocityY: Float
      ): Boolean {
        if (handle == 0L || scaleDetector.isInProgress) return false
        // Finger up (negative velocity) scrolls content down: invert.
        flingLastY = 0
        scroller.fling(0, 0, 0, -velocityY.toInt(), 0, 0, Int.MIN_VALUE, Int.MAX_VALUE)
        postOnAnimation(flingRunnable)
        return true
      }
    }
  )

  // Mirrors the iOS pinch-zoom: every 0.1 of accumulated scale steps the
  // font size by ±1dp through the same path as the fontSize prop.
  private var pinchScale = 1f
  private var pinchLastScale = 1f
  private val scaleDetector = ScaleGestureDetector(
    context,
    object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
      override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
        pinchScale = 1f
        pinchLastScale = 1f
        return true
      }

      override fun onScale(detector: ScaleGestureDetector): Boolean {
        pinchScale *= detector.scaleFactor
        val steps = ((pinchScale - pinchLastScale) / PINCH_SCALE_STEP).toInt()
        if (steps != 0) {
          pinchLastScale += steps * PINCH_SCALE_STEP
          setFontSize(fontSizeDp + steps)
        }
        return true
      }
    }
  )

  init {
    isFocusable = true
    isFocusableInTouchMode = true
    // Consumers can override via the standard accessibilityLabel view prop.
    contentDescription = "Terminal"
  }

  private fun newTextPaint(typeface: Typeface) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    this.typeface = typeface
    textSize = fontSizeDp * resources.displayMetrics.density
  }

  /**
   * Base font size in dp (default 9, clamped to 6–32 like iOS); pinch-to-zoom
   * steps from the current value. Content reflows in place — libghostty-vt
   * owns the grid state, so no output is lost.
   */
  fun setFontSize(dp: Float) {
    val clamped = dp.coerceIn(MIN_FONT_SIZE_DP, MAX_FONT_SIZE_DP)
    if (clamped == fontSizeDp) return
    fontSizeDp = clamped
    onFontSizeChanged?.invoke(clamped)
    val px = clamped * resources.displayMetrics.density
    for (paint in arrayOf(textPaint, boldPaint, italicPaint, boldItalicPaint, symbolsPaint)) {
      paint?.textSize = px
    }
    cellWidth = textPaint.measureText("M")
    cellHeight = ceil(textPaint.fontMetrics.descent - textPaint.fontMetrics.ascent).toInt()
    baseline = -textPaint.fontMetrics.ascent
    // Cell geometry moved under any active selection handles.
    if (selectionMode || actionMode != null) clearSelection()
    updateGridGeometry(force = true)
  }

  /**
   * Apply theme colors. Foreground/background/cursor/palette go into the
   * terminal itself (so OSC 4/10/11/12 queries and resets stay truthful);
   * selection colors are a renderer concern and stay here. Null fields
   * clear back to the defaults.
   */
  fun setTheme(
    foreground: String?,
    background: String?,
    cursorColor: String?,
    selectionBackground: String?,
    selectionForeground: String?,
    palette: Array<String?>?
  ) {
    if (handle == 0L) return
    selectionBg = selectionBackground
      ?.let { GhosttyVt.nativeParseColor(it) }
      ?.takeIf { it != 0 }
    selectionFg = selectionForeground
      ?.let { GhosttyVt.nativeParseColor(it) }
      ?.takeIf { it != 0 }
    GhosttyVt.nativeSetTheme(handle, foreground, background, cursorColor, palette)
    scheduleFrame()
  }

  // ── Session I/O ──

  /** Feed PTY output into the grid. */
  fun write(data: ByteArray) {
    if (handle == 0L) return
    val response = GhosttyVt.nativeWrite(handle, data)
    if (response != null && response.isNotEmpty() && !finished && !restoring) {
      onInputBytes?.invoke(response)
    }
    drainTerminalEvents()
    holdBlinkSolid()
    scheduleFrame()
  }

  private fun drainTerminalEvents() {
    val flags = GhosttyVt.nativeTakeEventFlags(handle)
    if (flags == 0) return
    if (flags and GhosttyVt.EVENT_BELL != 0) onBell?.invoke()
    if (flags and GhosttyVt.EVENT_TITLE != 0) {
      onTitleChange?.invoke(GhosttyVt.nativeGetTitle(handle)?.toString(Charsets.UTF_8).orEmpty())
    }
    if (flags and GhosttyVt.EVENT_PWD != 0) {
      onDirectoryChange?.invoke(GhosttyVt.nativeGetPwd(handle)?.toString(Charsets.UTF_8).orEmpty())
    }
  }

  /** Mark the underlying PTY as exited: stop forwarding input. */
  fun finish(@Suppress("UNUSED_PARAMETER") exitCode: Int) {
    finished = true
  }

  fun destroy() {
    removeCallbacks(synchronizedFrame)
    graphics.clear()
    if (framePending) {
      Choreographer.getInstance().removeFrameCallback(frameCallback)
      framePending = false
    }
    blinkScheduled = false
    removeCallbacks(blinkRunnable)
    scroller.abortAnimation()
    removeCallbacks(flingRunnable)
    actionMode?.finish()
    if (handle != 0L) {
      GhosttyVt.nativeFree(handle)
      handle = 0
    }
  }

  private fun sendBytes(bytes: ByteArray) {
    if (!finished && !restoring && bytes.isNotEmpty()) {
      if (selectionMode) clearSelection()
      // Typing while scrolled into history jumps back to the live view.
      if (handle != 0L && scrollbarOffset + scrollbarLen < scrollbarTotal) {
        GhosttyVt.nativeScrollToBottom(handle)
        scrollAccum = 0f
        scheduleFrame()
      }
      holdBlinkSolid()
      onInputBytes?.invoke(bytes)
    }
  }

  private fun markScrollActivity() {
    lastScrollActivityAt = android.os.SystemClock.uptimeMillis()
  }

  private fun sendText(text: CharSequence) {
    if (text.isEmpty()) return
    if (text.length == 1 && text[0].code in 32..126) {
      key(text.toString(), text[0].isUpperCase(), false, false)
    } else {
      // An IME commit is text, not a fabricated sequence of physical keys.
      sendBytes(text.toString().toByteArray(Charsets.UTF_8))
    }
  }

  fun toggleCtrl() { ctrlArmed = !ctrlArmed; onCtrlChanged?.invoke(ctrlArmed) }
  fun key(name: String, shift: Boolean, ctrl: Boolean, alt: Boolean) {
    val named = mapOf("enter" to KeyEvent.KEYCODE_ENTER, "escape" to KeyEvent.KEYCODE_ESCAPE,
      "tab" to KeyEvent.KEYCODE_TAB, "backspace" to KeyEvent.KEYCODE_DEL,
      "up" to KeyEvent.KEYCODE_DPAD_UP, "down" to KeyEvent.KEYCODE_DPAD_DOWN,
      "left" to KeyEvent.KEYCODE_DPAD_LEFT, "right" to KeyEvent.KEYCODE_DPAD_RIGHT,
      "home" to KeyEvent.KEYCODE_MOVE_HOME, "end" to KeyEvent.KEYCODE_MOVE_END,
      "pageUp" to KeyEvent.KEYCODE_PAGE_UP, "pageDown" to KeyEvent.KEYCODE_PAGE_DOWN)
    val char = name.singleOrNull()
    val shifted = mapOf('!' to '1', '@' to '2', '#' to '3', '$' to '4', '%' to '5', '^' to '6', '&' to '7', '*' to '8', '(' to '9', ')' to '0', '{' to '[', '}' to ']', '<' to ',', '>' to '.', '~' to '`', '|' to '\\', '?' to '/', '_' to '-', '+' to '=', ':' to ';', '"' to '\'')
    val unshiftedChar = char?.let { shifted[it] ?: it }
    val code = named[name] ?: unshiftedChar?.let { charToKeyCode(it) } ?: return
    val meta = (if (shift || shifted.containsKey(char)) KeyEvent.META_SHIFT_ON else 0) or
      (if (ctrl || ctrlArmed) KeyEvent.META_CTRL_ON else 0) or (if (alt) KeyEvent.META_ALT_ON else 0)
    ctrlArmed = false; onCtrlChanged?.invoke(false)
    for (action in intArrayOf(1, 0)) GhosttyVt.nativeEncodeKey(handle, code, action, meta,
      unshiftedChar?.lowercaseChar()?.code ?: 0, if (action == 1 && char != null) name.toByteArray(Charsets.UTF_8) else null)?.let { sendBytes(it) }
  }
  fun paste(text: String) { sendPaste(text.toByteArray(Charsets.UTF_8)) }
  fun beginReplay(reset: Boolean) { restoring = true; if (reset) { graphics.clear(); write("\u001bc\u001b[3J".toByteArray()) } }
  fun replay(data: String, columns: Int, lines: Int) {
    replaySize = columns to lines
    GhosttyVt.nativeResize(handle, columns, lines, cellWidth.roundToInt(), cellHeight)
    write(data.toByteArray(Charsets.UTF_8))
  }
  fun endReplay() { replaySize = null; restoring = false; updateGridGeometry(true) }

  /** Paste the clipboard, same confirmation flow as the selection menu. */
  fun requestPaste() = pasteFromClipboard()

  private fun charToKeyCode(char: Char): Int {
    val lower = char.lowercaseChar()
    return when (lower) {
      in 'a'..'z' -> KeyEvent.KEYCODE_A + (lower - 'a')
      in '0'..'9' -> KeyEvent.KEYCODE_0 + (lower - '0')
      ' ' -> KeyEvent.KEYCODE_SPACE
      '[' -> KeyEvent.KEYCODE_LEFT_BRACKET
      ']' -> KeyEvent.KEYCODE_RIGHT_BRACKET
      '-' -> KeyEvent.KEYCODE_MINUS
      '=' -> KeyEvent.KEYCODE_EQUALS
      '\\' -> KeyEvent.KEYCODE_BACKSLASH
      '/' -> KeyEvent.KEYCODE_SLASH
      '.' -> KeyEvent.KEYCODE_PERIOD
      ',' -> KeyEvent.KEYCODE_COMMA
      ';' -> KeyEvent.KEYCODE_SEMICOLON
      '\'' -> KeyEvent.KEYCODE_APOSTROPHE
      '`' -> KeyEvent.KEYCODE_GRAVE
      else -> KeyEvent.KEYCODE_UNKNOWN
    }
  }

  // ── Layout / resize ──

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    updateGridGeometry(force = false)
  }

  private fun updateGridGeometry(force: Boolean) {
    if (width <= 0 || height <= 0 || handle == 0L || restoring) return
    val newCols = max(2, floor(width / cellWidth).toInt())
    val newRows = max(2, height / cellHeight)
    val changed = newCols != cols || newRows != rows
    cols = newCols
    rows = newRows
    if (changed || force || backgroundRows.isEmpty()) {
      GhosttyVt.nativeResize(handle, cols, rows, cellWidth.roundToInt(), cellHeight)
      allocateGridBuffers()
      onGridResize?.invoke(cols, rows)
    }
    scheduleFrame()
  }

  private fun allocateGridBuffers() {
    val widthPx = max(1, ceil(cols * cellWidth).toInt())
    backgroundRows = Array(rows + 2) { TerminalRowLayer(widthPx, cellHeight) }
    textRows = Array(rows + 2) { TerminalRowLayer(widthPx, cellHeight) }
    val capacity = HEADER_BYTES +
      (rows + 2) * (ROW_HEADER_BYTES + cols * CELL_RECORD_BYTES + cols * MAX_CELL_TEXT_UNITS * 2 + 4)
    snapshotBuf = ByteBuffer.allocateDirect(capacity).order(ByteOrder.LITTLE_ENDIAN)
    rowChars = CharArray(cols * MAX_CELL_TEXT_UNITS)
    cellFg = IntArray(cols)
    cellBg = IntArray(cols)
    cellTextOff = IntArray(cols)
    cellTextLen = IntArray(cols)
    cellFlags = IntArray(cols)
    rowSelStart = IntArray(rows) { -1 }
    rowSelEnd = IntArray(rows) { -1 }
    rowSelEndWide = BooleanArray(rows)
  }

  // ── Rendering ──

  private fun scheduleFrame() {
    if (framePending || !isAttachedToWindow || windowVisibility != VISIBLE) return
    framePending = true
    Choreographer.getInstance().postFrameCallback(frameCallback)
  }

  private fun renderFrame() {
    val buf = snapshotBuf ?: return
    if (restoring || backgroundRows.isEmpty()) return
    if (handle == 0L) return

    val rowCount = GhosttyVt.nativeSnapshot(handle, buf)
    if (rowCount == -2) { removeCallbacks(synchronizedFrame); postDelayed(synchronizedFrame, 16); return }
    removeCallbacks(synchronizedFrame)
    if (rowCount < 0) return
    GhosttyVt.nativeScrollbar(handle)?.let { scrollbar ->
      scrollbarTotal = scrollbar[0]
      scrollbarOffset = scrollbar[1]
      scrollbarLen = scrollbar[2]
    }

    buf.position(0)
    val header = SnapshotHeader.read(buf)
    defaultBg = header.background
    defaultFg = header.foreground
    cursorX = header.cursorX
    cursorY = header.cursorY
    cursorStyle = header.cursorStyle
    cursorVisible = header.cursorVisible
    cursorBlinks = header.cursorBlinks
    cursorColor = header.cursorColor
    syncBlinkTimer()

    repeat(rowCount) {
      val start = buf.position()
      val row = buf.getInt(start)
      if (row + 1 !in backgroundRows.indices) return@repeat
      backgroundRows[row + 1].record { canvas ->
        buf.position(start)
        canvas.translate(0f, -row * cellHeight.toFloat())
        drawRowRecord(buf, canvas, header.cols, true)
      }
      buf.position(start)
      textRows[row + 1].record { canvas ->
        buf.position(start)
        canvas.translate(0f, -row * cellHeight.toFloat())
        drawRowRecord(buf, canvas, header.cols, false)
      }
    }
    graphics.update(handle)
    syncSelectionUi()
    invalidate()
  }

  // ── Selection ──

  /** Top-left / bottom-right cells of the rendered selection, or null. */
  private fun selectionBounds(): IntArray? {
    var top = -1
    var bottom = -1
    for (row in rowSelStart.indices) {
      if (rowSelStart[row] >= 0) {
        if (top < 0) top = row
        bottom = row
      }
    }
    if (top < 0) return null
    return intArrayOf(top, rowSelStart[top], bottom, rowSelEnd[bottom])
  }

  /** Extra columns the end handle shifts right when the last cell is wide. */
  private fun selEndExtraCols(row: Int): Int =
    if (row < rowSelEndWide.size && rowSelEndWide[row]) 1 else 0

  private fun syncSelectionUi() {
    if (!selectionMode) return
    if (selectionBounds() == null) {
      // Scrolled out of the viewport (or collapsed): drop the whole selection
      // so the UI and terminal state never disagree.
      clearSelection()
    } else {
      actionMode?.invalidateContentRect()
    }
  }

  private fun clearSelection() {
    if (handle != 0L) GhosttyVt.nativeClearSelection(handle)
    selectionMode = false
    draggingHandle = HANDLE_NONE
    actionMode?.finish()
    scheduleFrame()
  }

  private fun selectAllContent() {
    if (handle == 0L) return
    if (GhosttyVt.nativeSelectAll(handle)) {
      selectionMode = true
      scheduleFrame()
      actionMode?.invalidate()
    }
  }

  private fun copySelection() {
    if (handle == 0L) return
    val bytes = GhosttyVt.nativeSelectionText(handle) ?: return
    val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
    clipboard.setPrimaryClip(
      ClipData.newPlainText("terminal", String(bytes, Charsets.UTF_8))
    )
    clearSelection()
  }

  private fun pasteFromClipboard() {
    if (handle == 0L || finished) return
    val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
    val clip = clipboard.primaryClip?.takeIf { it.itemCount > 0 } ?: return
    val item = clip.getItemAt(0)
    if (item.uri != null) { onImportUri?.invoke(item.uri, null); return }
    val text = item.coerceToText(context)?.toString()
    if (text.isNullOrEmpty()) return
    val bytes = text.toByteArray(Charsets.UTF_8)
    if (GhosttyVt.nativeIsPasteSafe(bytes)) {
      sendPaste(bytes)
      return
    }
    AlertDialog.Builder(context)
      .setTitle("粘贴多行文字？")
      .setMessage("内容包含换行或控制字符，终端程序可能会将它们作为命令执行。")
      .setPositiveButton("粘贴") { _, _ -> sendPaste(bytes) }
      .setNegativeButton(android.R.string.cancel, null)
      .show()
  }

  private fun sendPaste(bytes: ByteArray) {
    val encoded = GhosttyVt.nativeEncodePaste(handle, bytes) ?: return
    if (selectionMode) clearSelection() else actionMode?.finish()
    sendBytes(encoded)
  }

  private fun startTerminalActionMode() {
    val current = actionMode
    if (current != null) {
      current.invalidate()
      current.invalidateContentRect()
      return
    }
    actionMode = startActionMode(
      object : ActionMode.Callback2() {
        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
          menu.add(Menu.NONE, MENU_COPY, 0, android.R.string.copy)
          menu.add(Menu.NONE, MENU_PASTE, 1, android.R.string.paste)
          menu.add(Menu.NONE, MENU_SELECT_ALL, 2, android.R.string.selectAll)
          return true
        }

        override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
          menu.findItem(MENU_COPY)?.isVisible = selectionMode
          return true
        }

        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
          when (item.itemId) {
            MENU_COPY -> copySelection()
            MENU_PASTE -> pasteFromClipboard()
            MENU_SELECT_ALL -> selectAllContent()
            else -> return false
          }
          return true
        }

        override fun onDestroyActionMode(mode: ActionMode) {
          actionMode = null
        }

        override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
          outRect.set(selectionContentRect())
        }
      },
      ActionMode.TYPE_FLOATING
    )
  }

  private fun selectionContentRect(): Rect {
    val bounds = selectionBounds()
    return if (bounds != null) {
      val (top, topCol, bottom, bottomCol) = bounds
      val singleRow = top == bottom
      Rect(
        if (singleRow) (topCol * cellWidth).toInt() else 0,
        top * cellHeight,
        if (singleRow) ((bottomCol + 1 + selEndExtraCols(bottom)) * cellWidth).toInt() else width,
        (bottom + 1) * cellHeight
      )
    } else {
      Rect(
        (lastPressCol * cellWidth).toInt(),
        lastPressRow * cellHeight,
        ((lastPressCol + 1) * cellWidth).toInt(),
        (lastPressRow + 1) * cellHeight
      )
    }
  }

  /** Returns which handle (start/end) is under the touch, arming the drag anchor. */
  private fun hitTestHandle(x: Float, y: Float): Int {
    val bounds = selectionBounds() ?: return HANDLE_NONE
    val (top, topCol, bottom, bottomCol) = bounds
    val slop = HANDLE_HIT_SLOP_DP * resources.displayMetrics.density
    val startX = topCol * cellWidth
    val startY = (top + 1) * cellHeight + handleRadius - scrollAccum
    val endX = (bottomCol + 1 + selEndExtraCols(bottom)) * cellWidth
    val endY = (bottom + 1) * cellHeight + handleRadius - scrollAccum
    val distStart = hypot(x - startX, y - startY)
    val distEnd = hypot(x - endX, y - endY)
    return when {
      distEnd <= slop && distEnd <= distStart -> {
        dragAnchorCol = topCol
        dragAnchorRow = top
        dragBiasRows = 1
        HANDLE_END
      }
      distStart <= slop -> {
        dragAnchorCol = bottomCol
        dragAnchorRow = bottom
        dragBiasRows = 1
        HANDLE_START
      }
      else -> HANDLE_NONE
    }
  }

  private fun dragSelection(x: Float, y: Float) {
    if (handle == 0L) return
    val col = (x / cellWidth).toInt().coerceIn(0, cols - 1)
    val row = (((y + scrollAccum) / cellHeight).toInt() - dragBiasRows).coerceIn(0, rows - 1)
    GhosttyVt.nativeSetSelection(handle, dragAnchorCol, dragAnchorRow, col, row)
    magnifier?.show(x, y)
    scheduleFrame()
  }

  private fun drawSelectionHandles(canvas: Canvas) {
    if (!selectionMode) return
    val bounds = selectionBounds() ?: return
    val (top, topCol, bottom, bottomCol) = bounds
    handlePaint.color = HANDLE_COLOR
    val stem = max(2f, resources.displayMetrics.density * 2)
    val startX = topCol * cellWidth
    val startTop = ((top + 1) * cellHeight).toFloat()
    canvas.drawRect(startX - stem / 2, startTop - cellHeight / 3f, startX + stem / 2, startTop + handleRadius, handlePaint)
    canvas.drawCircle(startX, startTop + handleRadius, handleRadius, handlePaint)
    val endX = (bottomCol + 1 + selEndExtraCols(bottom)) * cellWidth
    val endTop = ((bottom + 1) * cellHeight).toFloat()
    canvas.drawRect(endX - stem / 2, endTop - cellHeight / 3f, endX + stem / 2, endTop + handleRadius, handlePaint)
    canvas.drawCircle(endX, endTop + handleRadius, handleRadius, handlePaint)
  }

  // ── Cursor blink ──

  private fun wantsBlink(): Boolean {
    return cursorBlinks && cursorVisible && isAttachedToWindow && windowVisibility == VISIBLE && hasWindowFocus() &&
      Settings.Global.getFloat(
        context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f
      ) != 0f
  }

  private fun syncBlinkTimer() {
    val wants = wantsBlink()
    if (wants && !blinkScheduled) {
      blinkScheduled = true
      postDelayed(blinkRunnable, BLINK_INTERVAL_MS)
    } else if (!wants && blinkScheduled) {
      blinkScheduled = false
      removeCallbacks(blinkRunnable)
      if (!blinkPhaseOn) {
        blinkPhaseOn = true
        invalidate()
      }
    }
  }

  /** Show a solid cursor and restart the blink interval (any input/output). */
  private fun holdBlinkSolid() {
    if (!blinkPhaseOn) {
      blinkPhaseOn = true
      invalidate()
    }
    if (blinkScheduled) {
      removeCallbacks(blinkRunnable)
      postDelayed(blinkRunnable, BLINK_INTERVAL_MS)
    }
  }

  override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
    super.onWindowFocusChanged(hasWindowFocus)
    syncBlinkTimer()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    syncBlinkTimer()
    scheduleFrame()
  }

  override fun onDetachedFromWindow() {
    if (framePending) { Choreographer.getInstance().removeFrameCallback(frameCallback); framePending = false }
    scroller.abortAnimation(); removeCallbacks(flingRunnable)
    super.onDetachedFromWindow()
    syncBlinkTimer()
  }

  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    syncBlinkTimer()
    if (visibility == VISIBLE) scheduleFrame()
    else {
      if (framePending) { Choreographer.getInstance().removeFrameCallback(frameCallback); framePending = false }
      scroller.abortAnimation(); removeCallbacks(flingRunnable)
    }
  }

  private fun drawComposition(canvas: Canvas) {
    if (composition.isEmpty() || cursorX < 0 || cursorY < 0) return
    val x = cursorX * cellWidth; val y = cursorY * cellHeight.toFloat()
    val w = textPaint.measureText(composition).coerceAtMost(width - x)
    fillPaint.color = defaultBg; canvas.drawRect(x, y, x + w, y + cellHeight, fillPaint)
    textPaint.color = defaultFg
    canvas.drawText(composition, x, y + baseline, textPaint)
    canvas.drawRect(x, y + cellHeight - underlineThickness, x + w, y + cellHeight, textPaint)
  }

  private fun drawRowRecord(buf: ByteBuffer, canvas: Canvas, snapCols: Int, background: Boolean) {
    val rowIndex = buf.int
    val selStart = buf.int
    val selEnd = buf.int
    val textUnits = buf.int
    if (rowIndex in rowSelStart.indices) {
      rowSelStart[rowIndex] = selStart
      rowSelEnd[rowIndex] = selEnd
      rowSelEndWide[rowIndex] = false
    }
    val cellsPos = buf.position()
    val textPos = cellsPos + snapCols * CELL_RECORD_BYTES

    buf.position(textPos)
    if (textUnits > rowChars.size) rowChars = CharArray(textUnits)
    for (i in 0 until textUnits) rowChars[i] = buf.char
    val nextRecord = textPos + textUnits * 2 + if (textUnits % 2 != 0) 2 else 0

    buf.position(cellsPos)
    val colCount = minOf(snapCols, cellFg.size)
    for (col in 0 until snapCols) {
      val fg = buf.int
      val bg = buf.int
      val textOff = buf.short.toInt() and 0xFFFF
      val textLen = buf.short.toInt() and 0xFFFF
      val flags = buf.short.toInt() and 0xFFFF
      buf.short // pad
      if (col >= colCount) continue
      if (col == selEnd && flags and FLAG_WIDE != 0 && rowIndex in rowSelEndWide.indices) {
        rowSelEndWide[rowIndex] = true
      }
      val selected = selStart >= 0 && col >= selStart && col <= selEnd
      val colors = resolveCellColors(fg, bg, flags, selected, defaultFg, defaultBg, selectionFg, selectionBg)
      cellFg[col] = packedFg(colors)
      cellBg[col] = packedBg(colors)
      cellTextOff[col] = textOff
      cellTextLen[col] = textLen
      cellFlags[col] = flags
    }
    buf.position(nextRecord)

    val top = (rowIndex * cellHeight).toFloat()
    val bottom = top + cellHeight

    if (background) {
    // Default background is drawn once, so negative-z images remain visible.
    fillPaint.color = defaultBg

    for (col in 0 until colCount) {
      val bg = cellBg[col]
      if (bg == defaultBg && cellFlags[col] and FLAG_BG_NONE != 0 && cellFlags[col] and FLAG_INVERSE == 0 && !(selStart >= 0 && col in selStart..selEnd)) continue
      val width = if (cellFlags[col] and FLAG_WIDE != 0) cellWidth * 2 else cellWidth
      val x = col * cellWidth
      fillPaint.color = bg
      canvas.drawRect(x, top, x + width, bottom, fillPaint)
    }

    return
    }
    // Text pass.
    for (col in 0 until colCount) {
      val flags = cellFlags[col]
      val len = cellTextLen[col]
      if (len == 0 || flags and FLAG_SPACER != 0 || flags and FLAG_INVISIBLE != 0) continue
      val codepoint = Character.codePointAt(rowChars, cellTextOff[col])
      if (codepoint == 0x10EEEE) continue
      val paint = when {
        symbolsPaint != null &&
          (codepoint in PUA_BMP_FIRST..PUA_BMP_LAST || codepoint >= PUA_SUPPLEMENTARY_FIRST) ->
          symbolsPaint
        flags and FLAG_BOLD != 0 && flags and FLAG_ITALIC != 0 -> boldItalicPaint
        flags and FLAG_BOLD != 0 -> boldPaint
        flags and FLAG_ITALIC != 0 -> italicPaint
        else -> textPaint
      }
      paint.color = cellFg[col]
      if (flags and FLAG_FAINT != 0) paint.alpha = 160
      val x = col * cellWidth
      val cellRunWidth = if (flags and FLAG_WIDE != 0) cellWidth * 2 else cellWidth
      val measured = paint.measureText(rowChars, cellTextOff[col], len)
      canvas.save()
      canvas.clipRect(x, top, x + cellRunWidth, bottom)
      if (measured > cellRunWidth && measured > 0) {
        canvas.translate(x, 0f); canvas.scale(cellRunWidth / measured, 1f)
        canvas.drawText(rowChars, cellTextOff[col], len, 0f, top + baseline, paint)
      } else canvas.drawText(rowChars, cellTextOff[col], len, x, top + baseline, paint)
      canvas.restore()
      val runWidth = if (flags and FLAG_WIDE != 0) cellWidth * 2 else cellWidth
      if (flags and FLAG_UNDERLINE != 0) {
        canvas.drawRect(x, bottom - underlineThickness, x + runWidth, bottom, paint)
      }
      if (flags and FLAG_STRIKETHROUGH != 0) {
        val mid = top + cellHeight / 2f
        canvas.drawRect(x, mid - underlineThickness / 2, x + runWidth, mid + underlineThickness / 2, paint)
      }
      paint.alpha = 255
    }
  }

  override fun onDraw(canvas: Canvas) {
    canvas.drawColor(defaultBg)
    canvas.save(); canvas.translate(0f, -scrollAccum)
    graphics.draw(canvas, 0, cellWidth, cellHeight)
    backgroundRows.forEachIndexed { i, row -> row.draw(canvas, (i - 1) * cellHeight.toFloat()) }
    graphics.draw(canvas, 1, cellWidth, cellHeight)
    textRows.forEachIndexed { i, row -> row.draw(canvas, (i - 1) * cellHeight.toFloat()) }
    graphics.draw(canvas, 2, cellWidth, cellHeight)
    drawCursor(canvas)
    drawComposition(canvas)
    drawSelectionHandles(canvas)
    canvas.restore()
    drawScrollIndicator(canvas)
    drawJumpToBottomChip(canvas)
  }

  private fun drawScrollIndicator(canvas: Canvas) {
    if (scrollbarTotal <= scrollbarLen) return
    val elapsed = android.os.SystemClock.uptimeMillis() - lastScrollActivityAt
    if (elapsed > SCROLLBAR_FADE_END_MS) return
    val alpha = if (elapsed <= SCROLLBAR_FADE_START_MS) {
      255
    } else {
      (255 * (SCROLLBAR_FADE_END_MS - elapsed) / (SCROLLBAR_FADE_END_MS - SCROLLBAR_FADE_START_MS)).toInt()
    }
    val density = resources.displayMetrics.density
    val barWidth = 3 * density
    val right = width - 2 * density
    val trackHeight = height.toFloat()
    val top = trackHeight * scrollbarOffset / scrollbarTotal
    val thumbHeight = max(16 * density, trackHeight * scrollbarLen / scrollbarTotal)
    scrollbarPaint.color = SCROLLBAR_COLOR
    scrollbarPaint.alpha = alpha
    canvas.drawRoundRect(
      right - barWidth, top, right, (top + thumbHeight).coerceAtMost(trackHeight),
      barWidth / 2, barWidth / 2, scrollbarPaint
    )
    if (elapsed > SCROLLBAR_FADE_START_MS) invalidate()
  }

  private fun jumpChipCenter(): Pair<Float, Float> {
    val density = resources.displayMetrics.density
    return Pair(width - 32 * density, height - 32 * density)
  }

  private fun drawJumpToBottomChip(canvas: Canvas) {
    if (scrollbarTotal <= 0 || scrollbarOffset + scrollbarLen >= scrollbarTotal) return
    val density = resources.displayMetrics.density
    val (cx, cy) = jumpChipCenter()
    val radius = JUMP_CHIP_RADIUS_DP * density
    jumpChipPaint.style = Paint.Style.FILL
    jumpChipPaint.color = JUMP_CHIP_BACKGROUND
    canvas.drawCircle(cx, cy, radius, jumpChipPaint)
    // Downward chevron.
    val span = radius * 0.45f
    jumpChipArrow.reset()
    jumpChipArrow.moveTo(cx - span, cy - span * 0.5f)
    jumpChipArrow.lineTo(cx, cy + span * 0.5f)
    jumpChipArrow.lineTo(cx + span, cy - span * 0.5f)
    jumpChipPaint.style = Paint.Style.STROKE
    jumpChipPaint.strokeWidth = 2 * density
    jumpChipPaint.color = JUMP_CHIP_ARROW_COLOR
    canvas.drawPath(jumpChipArrow, jumpChipPaint)
  }

  private fun drawCursor(canvas: Canvas) {
    if (!cursorVisible || cursorX < 0 || cursorY < 0) return
    if (cursorBlinks && blinkScheduled && !blinkPhaseOn) return
    val x = cursorX * cellWidth
    val top = (cursorY * cellHeight).toFloat()
    val bottom = top + cellHeight
    cursorPaint.color = if (cursorColor != 0) cursorColor else defaultFg
    when (cursorStyle) {
      CURSOR_STYLE_BAR -> {
        cursorPaint.style = Paint.Style.FILL
        canvas.drawRect(x, top, x + underlineThickness * 2, bottom, cursorPaint)
      }
      CURSOR_STYLE_UNDERLINE -> {
        cursorPaint.style = Paint.Style.FILL
        canvas.drawRect(x, bottom - underlineThickness * 2, x + cellWidth, bottom, cursorPaint)
      }
      CURSOR_STYLE_BLOCK_HOLLOW -> {
        cursorPaint.style = Paint.Style.STROKE
        cursorPaint.strokeWidth = underlineThickness
        canvas.drawRect(x, top, x + cellWidth, bottom, cursorPaint)
      }
      else -> {
        cursorPaint.style = Paint.Style.FILL
        cursorPaint.alpha = 170
        canvas.drawRect(x, top, x + cellWidth, bottom, cursorPaint)
        cursorPaint.alpha = 255
      }
    }
  }

  // ── Input ──

  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (event.actionMasked == MotionEvent.ACTION_DOWN) {
      scroller.abortAnimation()
      removeCallbacks(flingRunnable)
      mouseScrollAccum = 0f
      scrollX = event.x
      scrollY = event.y
    }
    if (event.actionMasked == MotionEvent.ACTION_CANCEL) {
      scroller.abortAnimation()
      removeCallbacks(flingRunnable)
    }
    scaleDetector.onTouchEvent(event)
    if (scaleDetector.isInProgress) {
      if (draggingHandle != HANDLE_NONE) {
        draggingHandle = HANDLE_NONE
        magnifier?.dismiss()
      }
      // Keep the tap/long-press detector's stream consistent; its callbacks
      // are guarded on isInProgress.
      gestureDetector.onTouchEvent(event)
      return true
    }
    if (selectionMode) {
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          draggingHandle = hitTestHandle(event.x, event.y)
          if (draggingHandle != HANDLE_NONE) {
            // Hide the toolbar while dragging; it comes back on release.
            actionMode?.finish()
            return true
          }
        }
        MotionEvent.ACTION_MOVE -> if (draggingHandle != HANDLE_NONE) {
          dragSelection(event.x, event.y)
          return true
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL ->
          if (draggingHandle != HANDLE_NONE) {
            draggingHandle = HANDLE_NONE
            magnifier?.dismiss()
            startTerminalActionMode()
            return true
          }
      }
    }
    return gestureDetector.onTouchEvent(event) || super.onTouchEvent(event)
  }

  override fun onCheckIsTextEditor(): Boolean = true

  override fun onDragEvent(event: android.view.DragEvent): Boolean {
    if (event.action == android.view.DragEvent.ACTION_DRAG_STARTED) return event.clipDescription != null
    if (event.action == android.view.DragEvent.ACTION_DROP) {
      val clip = event.clipData ?: return false
      val activity = generateSequence(context) { (it as? android.content.ContextWrapper)?.baseContext }.filterIsInstance<android.app.Activity>().firstOrNull()
      val permission = activity?.requestDragAndDropPermissions(event)
      val remaining = java.util.concurrent.atomic.AtomicInteger(clip.itemCount)
      val release = { if (remaining.decrementAndGet() == 0) permission?.release(); Unit }
      for (i in 0 until clip.itemCount) {
        val item = clip.getItemAt(i)
        if (item.uri != null) onImportUri?.invoke(item.uri, release) else { item.text?.let { paste(it.toString()) }; release() }
      }
      return true
    }
    return true
  }
  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
    outAttrs.contentMimeTypes = arrayOf("image/*")
    // Visible-password + no-suggestions keeps IMEs in send-as-you-type mode
    // (no autocorrect batching) while still allowing CJK composition.
    outAttrs.inputType = InputType.TYPE_CLASS_TEXT or
      InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
      InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    outAttrs.imeOptions = EditorInfo.IME_ACTION_NONE or
      EditorInfo.IME_FLAG_NO_FULLSCREEN or
      EditorInfo.IME_FLAG_NO_EXTRACT_UI
    return TerminalInputConnection()
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    return handleKeyEvent(event) || super.onKeyDown(keyCode, event)
  }

  override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
    return handleKeyEvent(event) || super.onKeyUp(keyCode, event)
  }

  internal fun handleKeyEvent(event: KeyEvent): Boolean {
    if (handle == 0L || finished) return false
    if (event.keyCode == KeyEvent.KEYCODE_V && (event.isCtrlPressed || event.isMetaPressed)) {
      if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) requestPaste()
      return true
    }
    @Suppress("DEPRECATION")
    if (event.action == KeyEvent.ACTION_MULTIPLE && event.characters != null) {
      sendText(event.characters)
      return true
    }
    val action = when (event.action) {
      KeyEvent.ACTION_DOWN -> if (event.repeatCount > 0) 2 else 1
      KeyEvent.ACTION_UP -> 0
      else -> return false
    }
    // Sticky accessory-bar modifiers apply to hardware keys too.
    val stickyMeta = if (action == 1 && ctrlArmed) KeyEvent.META_CTRL_ON else pressedSticky[event.keyCode] ?: 0
    if (action == 1) pressedSticky[event.keyCode] = stickyMeta
    if (action == 0) pressedSticky.remove(event.keyCode)
    if (action == 1 && ctrlArmed) { ctrlArmed = false; onCtrlChanged?.invoke(false) }
    val metaState = event.metaState or stickyMeta
    val unicode = event.getUnicodeChar(
      metaState and (KeyEvent.META_CTRL_MASK or KeyEvent.META_META_MASK).inv()
    )
    val utf8 = if (unicode != 0 && unicode and KeyCharacterMap.COMBINING_ACCENT == 0) {
      String(Character.toChars(unicode)).toByteArray(Charsets.UTF_8)
    } else {
      null
    }
    val unshifted = event.getUnicodeChar(0)
    val bytes = GhosttyVt.nativeEncodeKey(
      handle, event.keyCode, action, metaState, unshifted, utf8
    ) ?: return false
    if (bytes.isEmpty()) return false
    sendBytes(bytes)
    return true
  }

  private inner class TerminalInputConnection :
    BaseInputConnection(this@GhosttyTerminalView, false) {
    override fun commitContent(info: android.view.inputmethod.InputContentInfo, flags: Int, opts: android.os.Bundle?): Boolean {
      if (android.os.Build.VERSION.SDK_INT < 25) return false
      if (flags and InputConnection.INPUT_CONTENT_GRANT_READ_URI_PERMISSION != 0) info.requestPermission()
      onImportUri?.invoke(info.contentUri) { info.releasePermission() }
      return true
    }
    override fun setComposingText(text: CharSequence, newCursorPosition: Int): Boolean {
      composition = text.toString(); invalidate()
      return super.setComposingText(text, newCursorPosition)
    }
    override fun finishComposingText(): Boolean {
      composition = ""; invalidate()
      return super.finishComposingText()
    }
    override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
      composition = ""; invalidate()
      sendText(text)
      return super.commitText("", newCursorPosition)
    }

    // IMEs can use either deletion API; BaseInputConnection only edits its
    // local composing buffer, whereas committed terminal text lives remotely.
    override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean =
      deleteSurroundingText(beforeLength, afterLength)

    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
      if (beforeLength < 0 || afterLength < 0) return false
      repeat(beforeLength) {
        sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DEL))
        sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DEL))
      }
      repeat(afterLength) {
        sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_FORWARD_DEL))
        sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_FORWARD_DEL))
      }
      return true
    }

    override fun performEditorAction(actionCode: Int): Boolean {
      sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
      sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER))
      return true
    }

    override fun sendKeyEvent(event: KeyEvent): Boolean {
      if (handleKeyEvent(event)) return true
      return super.sendKeyEvent(event)
    }
  }

  private companion object {
    const val FONT_SIZE_DP = 9f
    // Same bounds and step as the iOS pinch-zoom (UITerminalView).
    const val MIN_FONT_SIZE_DP = 6f
    const val MAX_FONT_SIZE_DP = 32f
    const val PINCH_SCALE_STEP = 0.1f
    const val INITIAL_COLS = 80
    const val INITIAL_ROWS = 24
    const val MAX_SCROLLBACK = 10_000L
    const val BLINK_INTERVAL_MS = 600L
    const val SYMBOLS_FONT_ASSET = "fonts/LinkShellSymbols.ttf"

    // Nerd Font glyph ranges: BMP private-use area plus the supplementary
    // private-use planes (material icons live at U+F0000+ since v3).
    const val PUA_BMP_FIRST = 0xE000
    const val PUA_BMP_LAST = 0xF8FF
    const val PUA_SUPPLEMENTARY_FIRST = 0xF0000

    const val HANDLE_NONE = 0
    const val HANDLE_START = 1
    const val HANDLE_END = 2
    const val HANDLE_RADIUS_DP = 8f
    const val HANDLE_HIT_SLOP_DP = 24f
    const val HANDLE_COLOR = 0xFF4C8DF5.toInt()

    const val MENU_COPY = 1
    const val MENU_PASTE = 2
    const val MENU_SELECT_ALL = 3

    const val SCROLLBAR_FADE_START_MS = 800L
    const val SCROLLBAR_FADE_END_MS = 1400L
    const val SCROLLBAR_COLOR = 0xB3AAAAAA.toInt()
    const val JUMP_CHIP_RADIUS_DP = 18f
    const val JUMP_CHIP_BACKGROUND = 0xCC2A2A2E.toInt()
    const val JUMP_CHIP_ARROW_COLOR = 0xFFE0E0E0.toInt()

  }
}
