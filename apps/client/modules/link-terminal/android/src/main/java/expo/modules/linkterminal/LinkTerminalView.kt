package expo.modules.linkterminal

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.view.inputmethod.InputMethodManager
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

class LinkTerminalView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onFontSize by EventDispatcher()
  private val onInput by EventDispatcher()
  private val onResize by EventDispatcher()
  private val onFile by EventDispatcher()
  private val onError by EventDispatcher()
  private val onModifiers by EventDispatcher()
  @Volatile private var disposed = false
  private val imports = Executors.newSingleThreadExecutor()
  private val terminal = GhosttyTerminalView(context).also { view ->
    view.onInputBytes = { onInput(mapOf("data" to String(it, Charsets.UTF_8))) }
    view.onGridResize = { cols, rows -> if (!view.restoring) onResize(mapOf("cols" to cols, "rows" to rows)) }
    view.onFontSizeChanged = { onFontSize(mapOf("size" to it)) }
    view.onCtrlChanged = { onModifiers(mapOf("ctrl" to it)) }
    view.onImportUri = { uri, release -> importFile(uri, release) }
  }
  private var previousMode: Int? = null
  private var selectedMode: Int? = null
  private val activity get() = generateSequence(context) { (it as? android.content.ContextWrapper)?.baseContext }
    .filterIsInstance<android.app.Activity>().firstOrNull()

  init { addView(terminal, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)) }
  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val inset = (8 * resources.displayMetrics.density).toInt()
    terminal.layout(inset, 0, (r-l-inset).coerceAtLeast(inset), b-t)
  }
  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    val display = display ?: return
    val current = display.mode
    val best = display.supportedModes.filter { it.physicalWidth == current.physicalWidth && it.physicalHeight == current.physicalHeight && it.refreshRate <= 120.5f }
      .maxByOrNull { it.refreshRate } ?: return
    if (best.refreshRate <= current.refreshRate) return
    activity?.window?.let { window ->
      val attrs = window.attributes
      previousMode = attrs.preferredDisplayModeId; selectedMode = best.modeId
      attrs.preferredDisplayModeId = best.modeId; window.attributes = attrs
    }
  }
  override fun onDetachedFromWindow() {
    activity?.window?.let { window ->
      if (window.attributes.preferredDisplayModeId == selectedMode) {
        val attrs = window.attributes; attrs.preferredDisplayModeId = previousMode ?: 0; window.attributes = attrs
      }
    }
    super.onDetachedFromWindow()
  }
  fun write(data: String) = terminal.write(data.toByteArray(Charsets.UTF_8))
  fun reset() = write("\u001bc")
  fun finish(message: String) { write(message); terminal.finish(0) }
  fun setFontSize(size: Double) = terminal.setFontSize(size.toFloat().coerceIn(6f, 32f))
  fun setTheme(theme: Map<String, String>) {
    val names = listOf("black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite")
    terminal.setTheme(theme["foreground"], theme["background"], theme["cursor"], theme["selectionBackground"], null, names.map { theme[it] }.toTypedArray())
  }
  fun showKeyboard() { terminal.requestFocus(); context.getSystemService(InputMethodManager::class.java).showSoftInput(terminal, 0) }
  fun hideKeyboard() { context.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(terminal.windowToken, 0); terminal.clearFocus() }
  fun key(name: String, shift: Boolean, ctrl: Boolean, alt: Boolean) = terminal.key(name, shift, ctrl, alt)
  fun paste(text: String) = terminal.paste(text)
  fun pasteClipboard() = terminal.requestPaste()
  fun toggleCtrl() = terminal.toggleCtrl()
  fun beginReplay(reset: Boolean) = terminal.beginReplay(reset)
  fun replay(data: String, cols: Int, rows: Int) = terminal.replay(data, cols, rows)
  fun endReplay() = terminal.endReplay()
  fun destroy() { disposed = true; terminal.destroy(); imports.shutdown() }

  private fun importFile(uri: Uri, release: (() -> Unit)?) {
    if (disposed) { release?.invoke(); return }
    imports.execute {
      var target: File? = null
      try {
        val resolver = context.contentResolver
        var name = uri.lastPathSegment ?: "image.png"
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
          if (cursor.moveToFirst()) {
            cursor.getString(0)?.let { name = it }
            require(cursor.isNull(1) || cursor.getLong(1) <= MAX_FILE) { "文件超过 30 MB" }
          }
        }
        val directory = File(context.cacheDir, "linkshell-imports").apply { mkdirs() }
        val file = File(directory, UUID.randomUUID().toString() + "-" + File(name).name)
        target = file
        var count = 0L
        resolver.openInputStream(uri)?.use { input ->
          file.outputStream().use { out ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
              val read = input.read(buffer); if (read < 0) break
              count += read; require(count <= MAX_FILE) { "文件超过 30 MB" }; out.write(buffer, 0, read)
            }
          }
        } ?: error("无法读取文件")
        post { if (disposed) file.delete() else onFile(mapOf("uri" to Uri.fromFile(file).toString(), "name" to File(name).name, "size" to count)) }
      } catch (e: Exception) {
        target?.delete()
        post { if (!disposed) onError(mapOf("message" to if (e is IllegalArgumentException) "文件超过 30 MB" else "无法读取粘贴或拖入的文件")) }
      } finally { release?.invoke() }
    }
  }
  companion object { const val MAX_FILE = 30L * 1024 * 1024 }
}
