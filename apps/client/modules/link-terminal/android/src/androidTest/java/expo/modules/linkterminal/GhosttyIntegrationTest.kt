package expo.modules.linkterminal

import android.content.ClipData
import android.content.ClipboardManager
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class GhosttyIntegrationTest {
  private fun onMain(block: () -> Unit) {
    var failure: Throwable? = null
    InstrumentationRegistry.getInstrumentation().runOnMainSync { try { block() } catch (error: Throwable) { failure = error } }
    failure?.let { throw it }
  }

  private fun withTerminal(test: (Long) -> Unit) {
    val handle = GhosttyVt.nativeCreate(80, 24, 1000)
    assertNotEquals(0L, handle)
    try { GhosttyVt.nativeResize(handle, 80, 24, 10, 20); test(handle) }
    finally { GhosttyVt.nativeFree(handle) }
  }

  @Test fun kittyKeysAndBracketedPasteFollowNegotiatedModes() = onMain { withTerminal { handle ->
    GhosttyVt.nativeWrite(handle, "\u001b[>31u\u001b[?2004h".toByteArray())
    val press = GhosttyVt.nativeEncodeKey(handle, KeyEvent.KEYCODE_ENTER, 1, KeyEvent.META_SHIFT_ON, 0, null)!!.decodeToString()
    val release = GhosttyVt.nativeEncodeKey(handle, KeyEvent.KEYCODE_ENTER, 0, KeyEvent.META_SHIFT_ON, 0, null)!!.decodeToString()
    assertTrue(press, press.startsWith("\u001b[13;2"))
    assertTrue(release, release.contains(":3"))
    assertEquals("\u001b[200~中文\nnext\u001b[201~", GhosttyVt.nativeEncodePaste(handle, "中文\nnext".toByteArray())!!.decodeToString())
  } }

  @Test fun unicodeAndResizePreserveText() = onMain { withTerminal { handle ->
    GhosttyVt.nativeWrite(handle, "中文 AB 👩‍💻 é\r\n第二行".toByteArray())
    GhosttyVt.nativeResize(handle, 40, 12, 10, 20)
    assertTrue(GhosttyVt.nativeSelectAll(handle))
    val text = GhosttyVt.nativeSelectionText(handle)!!.decodeToString()
    assertTrue(text, text.contains("中文 AB"))
    assertTrue(text, text.contains("第二行"))
  } }

  @Test fun kittyRgbPlacementMovesAndDeletesWithTheCore() = onMain { withTerminal { handle ->
    GhosttyVt.nativeWrite(handle, "\u001b_Ga=T,f=24,s=1,v=1,i=9,c=2,r=2;/wAA\u001b\\".toByteArray())
    val placements = GhosttyVt.nativeImages(handle)!!
    assertEquals(15, placements.size)
    assertEquals(9L, placements[0])
    val pixels = GhosttyVt.nativeImagePixels(handle, 9)!!
    assertArrayEquals(intArrayOf(1, 1, 0xFFFF0000.toInt()), pixels)
    GhosttyVt.nativeWrite(handle, "\u001b_Ga=d,d=I,i=9\u001b\\".toByteArray())
    assertEquals(0, GhosttyVt.nativeImages(handle)!!.size)
  } }

  @Test fun virtualImagePlaceholdersInheritCoordinatesAndMoveWithText() = onMain { withTerminal { handle ->
    GhosttyVt.nativeWrite(handle, "\u001b_Ga=T,U=1,f=24,s=1,v=1,i=42,c=2,r=1,q=2;/wAA\u001b\\\u001b[38;5;42m".toByteArray())
    val placeholder = String(Character.toChars(0x10EEEE))
    GhosttyVt.nativeWrite(handle, (placeholder + "\u0305\u0305" + placeholder).toByteArray())
    val placements = GhosttyVt.nativeImages(handle)!!
    assertEquals(30, placements.size)
    assertEquals(0L, placements[13])
    assertEquals(1L, placements[28])
    GhosttyVt.nativeWrite(handle, "\u001b[2J".toByteArray())
    assertEquals(0, GhosttyVt.nativeImages(handle)!!.size)
  } }

  @Test fun pngPayloadIsDecodedByAndroidAndStoredByGhostty() = onMain { withTerminal { handle ->
    val png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
    val reply = GhosttyVt.nativeWrite(handle, "\u001b_Ga=T,f=100,i=17;$png\u001b\\".toByteArray())?.decodeToString()
    assertTrue(reply ?: "no reply", reply?.contains("OK") == true)
    assertArrayEquals(intArrayOf(1, 1, 0xFFFF0000.toInt()), GhosttyVt.nativeImagePixels(handle, 17))
  } }

  @Test fun replayDoesNotSendQueriesBackToTheShellAndImeCommitsOnce() = onMain {
    val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    val view = GhosttyTerminalView(context)
    val output = mutableListOf<String>()
    view.onInputBytes = { output += it.decodeToString() }
    try {
      view.layout(0, 0, 800, 480)
      view.beginReplay(true)
      view.replay("\u001b[6n\u001b[c\u001b[>31u", 40, 12)
      view.endReplay()
      assertTrue(output.toString(), output.isEmpty())
      val input = view.onCreateInputConnection(EditorInfo())
      input.setComposingText("zhongwen", 1)
      assertTrue(output.isEmpty())
      input.commitText("中文", 1)
      assertEquals(listOf("中文"), output)
      output.clear()
      view.key("enter", true, false, false)
      assertTrue(output.joinToString(), output.first().startsWith("\u001b[13;2"))
    } finally { view.destroy() }
  }

  @Test fun synchronizedOutputWaitsForTheFrameBoundary() = onMain { withTerminal { handle ->
    val buffer = java.nio.ByteBuffer.allocateDirect(1024 * 1024).order(java.nio.ByteOrder.LITTLE_ENDIAN)
    GhosttyVt.nativeWrite(handle, "\u001b[?2026hhalf".toByteArray())
    assertEquals(-2, GhosttyVt.nativeSnapshot(handle, buffer))
    GhosttyVt.nativeWrite(handle, "-complete\u001b[?2026l".toByteArray())
    assertTrue(GhosttyVt.nativeSnapshot(handle, buffer) > 0)
  } }

  @Test fun imeDeletionSupportsCodePointsAndForwardDelete() = onMain {
    val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    val view = GhosttyTerminalView(context)
    val output = mutableListOf<String>()
    view.onInputBytes = { output += it.decodeToString() }
    try {
      val input = view.onCreateInputConnection(EditorInfo())
      assertTrue(input.deleteSurroundingTextInCodePoints(1, 1))
      assertEquals(listOf(127, 27, 91, 51, 126), output.joinToString("").map { it.code })
      output.clear()
      assertTrue(input.deleteSurroundingText(0, 1))
      assertEquals(listOf(27, 91, 51, 126), output.joinToString("").map { it.code })
    } finally { view.destroy() }
  }

  @Test fun smallerFontChangesGridAndGpuDrawsTextAndKittyImage() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val intent = android.content.Intent(instrumentation.context, TerminalTestActivity::class.java)
      .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
    val textArea = android.graphics.Rect()
    androidx.test.core.app.ActivityScenario.launch<TerminalTestActivity>(intent).use { scenario ->
      instrumentation.waitForIdleSync()
      scenario.onActivity { activity ->
        val view = activity.terminal
        val widths = mutableListOf<Int>()
        var gridRows = 1
        view.onGridResize = { cols, rows -> widths += cols; gridRows = rows }
        view.setFontSize(9f)
        view.setFontSize(8f)
        view.setFontSize(7f)
        view.setFontSize(6f)
        assertTrue(widths.toString(), widths.size >= 3 && widths.zipWithNext().all { (a, b) -> b > a })
        view.setFontSize(9f)
        val location = IntArray(2); view.getLocationOnScreen(location)
        textArea.set(location[0], location[1], location[0] + view.width / 2, location[1] + view.height / gridRows * 2)
        view.write("\u001b[2J\u001b[H中文 AB 1234\r\nGPU + Ghostty\r\n\u001b_Ga=T,f=24,s=1,v=1,i=77,c=12,r=4,q=2;/wAA\u001b\\".toByteArray())
      }
      val drawn = java.util.concurrent.CountDownLatch(1)
      scenario.onActivity { activity -> activity.terminal.postOnAnimation { activity.terminal.postOnAnimation { drawn.countDown() } } }
      assertTrue(drawn.await(5, java.util.concurrent.TimeUnit.SECONDS))
      instrumentation.waitForIdleSync()
      android.os.SystemClock.sleep(500) // Wait for the system Activity opening animation, not terminal rendering.
      val bitmap = instrumentation.uiAutomation.takeScreenshot()
      assertNotNull(bitmap)
      var redPixels = 0
      var textPixels = 0
      for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) {
        val c = bitmap.getPixel(x, y)
        if (textArea.contains(x, y) && android.graphics.Color.red(c) > 240 && android.graphics.Color.green(c) > 240 && android.graphics.Color.blue(c) > 240) textPixels++
        if (android.graphics.Color.red(c) > 240 && android.graphics.Color.green(c) < 20 && android.graphics.Color.blue(c) < 20) redPixels++
      }
      val file = java.io.File(instrumentation.context.getExternalFilesDir(null), "ghostty-render.png")
      file.outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
      assertTrue("Kitty image must reach the GPU surface: $redPixels pixels", redPixels > 1000)
      assertTrue("CJK and Latin glyphs must reach the GPU surface: $textPixels pixels", textPixels > 20)
      bitmap.recycle()
    }
  }

  @Test fun clipboardImageIsImportedInsteadOfPastingAPhoneLocalUri() {
    val intent = android.content.Intent(InstrumentationRegistry.getInstrumentation().context, TerminalTestActivity::class.java)
      .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
    androidx.test.core.app.ActivityScenario.launch<TerminalTestActivity>(intent).use { scenario ->
      scenario.onActivity { activity ->
        val view = activity.terminal
        val clipboard = activity.getSystemService(ClipboardManager::class.java)
        val uri = android.net.Uri.parse("content://linkshell.test/image/1")
        var imported: android.net.Uri? = null
        val output = mutableListOf<String>()
        view.onInputBytes = { output += it.decodeToString() }
        view.onImportUri = { value, release -> imported = value; release?.invoke() }
        clipboard.setPrimaryClip(ClipData("image", arrayOf("image/png"), ClipData.Item(uri)))
        view.requestPaste()
        assertEquals(uri, imported)
        assertTrue(output.isEmpty())
      }
    }
  }
}
