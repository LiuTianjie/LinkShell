package expo.modules.linkterminal

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Picture
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.RenderNode
import android.os.Build
import android.util.LruCache

/** Dirty rows record draw commands; the system RenderThread rasterizes glyphs on the GPU. */
internal class TerminalRowLayer(private val width: Int, private val height: Int) {
  private val node = if (Build.VERSION.SDK_INT >= 29) RenderNode("terminal-row").apply {
    // Unqualified width/height here refer to the new RenderNode's zero bounds.
    setPosition(0, 0, this@TerminalRowLayer.width, this@TerminalRowLayer.height)
  } else null
  private val picture = Picture()
  fun record(draw: (Canvas) -> Unit) {
    val canvas = picture.beginRecording(width, height)
    try { draw(canvas) } finally { picture.endRecording() }
    if (Build.VERSION.SDK_INT >= 29 && node != null) {
      val gpu = node.beginRecording(width, height)
      try { gpu.drawPicture(picture) } finally { node.endRecording() }
    }
  }
  fun draw(canvas: Canvas, y: Float) {
    canvas.save(); canvas.translate(0f, y)
    if (Build.VERSION.SDK_INT >= 29 && node != null && canvas.isHardwareAccelerated) canvas.drawRenderNode(node)
    else canvas.drawPicture(picture)
    canvas.restore()
  }
}

internal class TerminalGraphics {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val cache = object : LruCache<Long, Bitmap>(32 * 1024 * 1024) {
    override fun sizeOf(key: Long, value: Bitmap) = value.allocationByteCount
  }
  private var placements = emptyList<LongArray>()
  fun update(handle: Long) {
    placements = (GhosttyVt.nativeImages(handle) ?: LongArray(0)).asList().chunked(15)
      .filter { it.size == 15 }.map { it.toLongArray() }.sortedWith(compareBy<LongArray> { it[12] }.thenBy { it[0] })
    val live = placements.map { it[1] }.toSet()
    cache.snapshot().keys.filter { it !in live }.forEach { cache.remove(it) }
    for (p in placements) {
      if (cache[p[1]] != null) continue
      val pixels = GhosttyVt.nativeImagePixels(handle, p[0]) ?: continue
      if (pixels.size < 2) continue
      val bitmap = Bitmap.createBitmap(pixels, 2, pixels[0], pixels[0], pixels[1], Bitmap.Config.ARGB_8888)
      cache.put(p[1], bitmap)
    }
  }
  fun clear() { placements = emptyList(); cache.evictAll() }
  fun draw(canvas: Canvas, layer: Int, cellWidth: Float, cellHeight: Int) {
    for (p in placements) {
      val z = p[12]
      val imageLayer = if (z < Int.MIN_VALUE / 2) 0 else if (z < 0) 1 else 2
      if (imageLayer != layer) continue
      val bitmap = cache[p[1]] ?: continue
      val x = p[2] * cellWidth + p[4]; val y = (p[3] * cellHeight + p[5]).toFloat()
      val source = Rect(p[8].toInt(), p[9].toInt(), (p[8]+p[10]).toInt(), (p[9]+p[11]).toInt())
      canvas.save()
      if (p[13] >= 0) canvas.clipRect(p[13] * cellWidth, (p[14] * cellHeight).toFloat(), (p[13] + 1) * cellWidth, ((p[14] + 1) * cellHeight).toFloat())
      canvas.drawBitmap(bitmap, source, RectF(x, y, x + p[6], y + p[7]), paint)
      canvas.restore()
    }
  }
}
