package expo.modules.linkscreen

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import android.os.Process
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

internal object ScreenAudioSpec {
  const val VERSION = 1
  const val CODEC_OPUS = 1
  const val CODEC_PCM16 = 2
  const val SAMPLE_RATE = 48_000
  const val CHANNELS = 2
  const val FRAME_SAMPLES = 960
  const val HEADER_BYTES = 8
  const val MAX_PACKET_BYTES = 4096
  const val MAX_PENDING_PACKETS = 8
}

internal data class ScreenAudioPacketData(
  val codec: Int,
  val seq: Int,
  val timestampMs: Long,
  val payload: ByteArray,
)

internal fun parseScreenAudioPacket(bytes: ByteArray): ScreenAudioPacketData? {
  if (bytes.size <= ScreenAudioSpec.HEADER_BYTES || bytes.size > ScreenAudioSpec.MAX_PACKET_BYTES) {
    return null
  }
  val version = bytes[0].toInt() and 0xFF
  val codec = bytes[1].toInt() and 0xFF
  if (version != ScreenAudioSpec.VERSION) return null
  if (codec != ScreenAudioSpec.CODEC_OPUS && codec != ScreenAudioSpec.CODEC_PCM16) return null

  val seq = ((bytes[2].toInt() and 0xFF) shl 8) or (bytes[3].toInt() and 0xFF)
  val timestampMs =
    ((bytes[4].toLong() and 0xFFL) shl 24) or
      ((bytes[5].toLong() and 0xFFL) shl 16) or
      ((bytes[6].toLong() and 0xFFL) shl 8) or
      (bytes[7].toLong() and 0xFFL)
  val payload = bytes.copyOfRange(ScreenAudioSpec.HEADER_BYTES, bytes.size)
  if (codec == ScreenAudioSpec.CODEC_PCM16 && payload.size % (ScreenAudioSpec.CHANNELS * 2) != 0) {
    return null
  }
  return ScreenAudioPacketData(codec = codec, seq = seq, timestampMs = timestampMs, payload = payload)
}

/**
 * Decodes screen audio packets (Opus or PCM16 stereo at 48kHz) and plays them on a low-latency
 * AudioTrack off a dedicated audio thread so WebRTC signaling and UI never stall.
 */
internal class ScreenAudioPlayerAndroid(initialMuted: Boolean = true) {
  private val muted = AtomicBoolean(initialMuted)
  private val stopped = AtomicBoolean(false)
  private val pendingCount = AtomicInteger(0)

  private val executor = Executors.newSingleThreadExecutor { runnable ->
    Thread({
      runCatching { Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO) }
      runnable.run()
    }, "LinkShellScreenAudio")
  }

  private var audioTrack: AudioTrack? = null
  private var opusDecoder: MediaCodec? = null
  private var opusFailed = false
  private var lastSeq = -1
  private var trackSampleRate = ScreenAudioSpec.SAMPLE_RATE
  private var trackChannels = ScreenAudioSpec.CHANNELS

  fun isMuted(): Boolean = muted.get()

  fun setMuted(value: Boolean) {
    val previous = muted.getAndSet(value)
    if (previous == value || stopped.get()) return
    executor.execute {
      if (stopped.get()) return@execute
      if (value) {
        pauseAndFlush()
      } else {
        ensureTrackStarted()
      }
    }
  }

  fun enqueue(rawPacket: ByteArray) {
    if (stopped.get() || muted.get()) return
    if (rawPacket.size <= ScreenAudioSpec.HEADER_BYTES || rawPacket.size > ScreenAudioSpec.MAX_PACKET_BYTES) {
      return
    }
    // Bound queued audio tasks so transient cellular spikes drop stale packets instead of growing latency.
    if (pendingCount.get() >= ScreenAudioSpec.MAX_PENDING_PACKETS) return
    val packet = parseScreenAudioPacket(rawPacket) ?: return
    pendingCount.incrementAndGet()
    try {
      executor.execute {
        pendingCount.decrementAndGet()
        if (stopped.get() || muted.get()) return@execute
        playPacket(packet)
      }
    } catch (_: Throwable) {
      pendingCount.decrementAndGet()
    }
  }

  fun stop() {
    if (!stopped.compareAndSet(false, true)) return
    muted.set(true)
    try {
      executor.execute {
        releaseOpus()
        releaseTrack()
      }
      executor.shutdown()
    } catch (_: Throwable) {
    }
  }

  private fun playPacket(packet: ScreenAudioPacketData) {
    val prev = lastSeq
    lastSeq = packet.seq
    if (prev >= 0 && ((prev + 1) and 0xFFFF) != packet.seq && packet.codec == ScreenAudioSpec.CODEC_OPUS) {
      // Drop stale codec state slightly? Let MediaCodec continue cleanly; only flush on large backwards jump.
      val forwardGap = (packet.seq - prev) and 0xFFFF
      if (forwardGap > 300) {
        runCatching { opusDecoder?.flush() }
      }
    }

    when (packet.codec) {
      ScreenAudioSpec.CODEC_PCM16 -> {
        val track = ensureTrackStarted(ScreenAudioSpec.SAMPLE_RATE, ScreenAudioSpec.CHANNELS) ?: return
        writePcm(track, packet.payload)
      }
      ScreenAudioSpec.CODEC_OPUS -> decodeAndPlayOpus(packet)
    }
  }

  private fun decodeAndPlayOpus(packet: ScreenAudioPacketData) {
    if (opusFailed) return
    val codec = ensureOpusDecoder() ?: return
    try {
      val inputIndex = codec.dequeueInputBuffer(10_000L)
      if (inputIndex >= 0) {
        val inputBuffer = codec.getInputBuffer(inputIndex)
        if (inputBuffer != null) {
          inputBuffer.clear()
          if (packet.payload.size <= inputBuffer.capacity()) {
            inputBuffer.put(packet.payload)
            codec.queueInputBuffer(inputIndex, 0, packet.payload.size, packet.timestampMs * 1000L, 0)
          } else {
            codec.queueInputBuffer(inputIndex, 0, 0, packet.timestampMs * 1000L, 0)
          }
        }
      }

      val info = MediaCodec.BufferInfo()
      while (true) {
        val outIndex = codec.dequeueOutputBuffer(info, 2_000L)
        when {
          outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            val format = codec.outputFormat
            val rate = if (format.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
              format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            } else {
              ScreenAudioSpec.SAMPLE_RATE
            }
            val ch = if (format.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
              format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            } else {
              ScreenAudioSpec.CHANNELS
            }
            ensureTrackStarted(rate, ch)
          }
          outIndex >= 0 -> {
            try {
              val outBuffer = codec.getOutputBuffer(outIndex)
              if (outBuffer != null && info.size > 0) {
                val track = ensureTrackStarted(trackSampleRate, trackChannels)
                if (track != null) {
                  outBuffer.position(info.offset)
                  outBuffer.limit(info.offset + info.size)
                  val pcm = ByteArray(info.size)
                  outBuffer.get(pcm)
                  writePcm(track, pcm)
                }
              }
            } finally {
              codec.releaseOutputBuffer(outIndex, false)
            }
          }
          else -> break
        }
      }
    } catch (_: Throwable) {
      // Avoid tight failure loops if a device OEM decoder throws mid-stream; keep PCM16 usable.
      releaseOpus()
      opusFailed = true
    }
  }

  private fun writePcm(track: AudioTrack, pcm: ByteArray) {
    if (pcm.isEmpty() || muted.get() || stopped.get()) return
    runCatching {
      var offset = 0
      while (offset < pcm.size && !muted.get() && !stopped.get()) {
        val written = track.write(pcm, offset, pcm.size - offset, AudioTrack.WRITE_BLOCKING)
        if (written <= 0) break
        offset += written
      }
    }
  }

  private fun ensureOpusDecoder(): MediaCodec? {
    if (opusDecoder != null) return opusDecoder
    if (opusFailed) return null
    return try {
      val codec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
      val format = MediaFormat.createAudioFormat(
        MediaFormat.MIMETYPE_AUDIO_OPUS,
        ScreenAudioSpec.SAMPLE_RATE,
        ScreenAudioSpec.CHANNELS,
      )
      // RFC 7845 OpusHead + Matroska/MediaCodec codec-specific pre-skip & seek pre-roll.
      val opusHead = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN).apply {
        put("OpusHead".toByteArray(Charsets.US_ASCII))
        put(1.toByte())
        put(ScreenAudioSpec.CHANNELS.toByte())
        putShort(0)
        putInt(ScreenAudioSpec.SAMPLE_RATE)
        putShort(0)
        put(0.toByte())
        flip()
      }
      val preSkipNs = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putLong(0L).apply { flip() }
      val seekPreRollNs = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putLong(80_000_000L).apply { flip() }
      format.setByteBuffer("csd-0", opusHead)
      format.setByteBuffer("csd-1", preSkipNs)
      format.setByteBuffer("csd-2", seekPreRollNs)
      codec.configure(format, null, null, 0)
      codec.start()
      opusDecoder = codec
      codec
    } catch (_: Throwable) {
      opusFailed = true
      null
    }
  }

  private fun ensureTrackStarted(
    sampleRate: Int = ScreenAudioSpec.SAMPLE_RATE,
    channels: Int = ScreenAudioSpec.CHANNELS,
  ): AudioTrack? {
    if (stopped.get() || muted.get()) return null
    val existing = audioTrack
    if (existing != null && trackSampleRate == sampleRate && trackChannels == channels) {
      runCatching {
        if (existing.playState != AudioTrack.PLAYSTATE_PLAYING) {
          existing.play()
        }
      }
      return existing
    }
    releaseTrack()
    val channelMask = if (channels == 1) AudioFormat.CHANNEL_OUT_MONO else AudioFormat.CHANNEL_OUT_STEREO
    val minBufferBytes = AudioTrack.getMinBufferSize(sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT)
    if (minBufferBytes <= 0) return null
    val frameBytes = channels * 2
    val targetBufferBytes = maxOf(minBufferBytes, ScreenAudioSpec.FRAME_SAMPLES * frameBytes * 4)
    return try {
      val builder = AudioTrack.Builder()
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
            .build()
        )
        .setAudioFormat(
          AudioFormat.Builder()
            .setSampleRate(sampleRate)
            .setChannelMask(channelMask)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .build()
        )
        .setBufferSizeInBytes(targetBufferBytes)
        .setTransferMode(AudioTrack.MODE_STREAM)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        builder.setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
      }
      val track = builder.build()
      track.play()
      audioTrack = track
      trackSampleRate = sampleRate
      trackChannels = channels
      track
    } catch (_: Throwable) {
      null
    }
  }

  private fun pauseAndFlush() {
    lastSeq = -1
    runCatching {
      audioTrack?.pause()
      audioTrack?.flush()
    }
    runCatching {
      opusDecoder?.flush()
    }
  }

  private fun releaseOpus() {
    val codec = opusDecoder ?: return
    opusDecoder = null
    runCatching { codec.stop() }
    runCatching { codec.release() }
  }

  private fun releaseTrack() {
    val track = audioTrack ?: return
    audioTrack = null
    runCatching {
      track.pause()
      track.flush()
    }
    runCatching { track.release() }
  }
}
