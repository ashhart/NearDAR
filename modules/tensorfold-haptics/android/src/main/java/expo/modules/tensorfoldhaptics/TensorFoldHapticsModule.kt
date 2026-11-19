package expo.modules.tensorfoldhaptics

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlin.math.roundToInt

class HapticRequest : Record {
  @Field var direction: String = "unknown"
  @Field var severity: String = "info"
  @Field var distanceMeters: Double? = null
}

private enum class HapticDirection(val value: String, val pulses: List<HapticPulse>) {
  AHEAD("ahead", listOf(HapticPulse(90))),
  AHEAD_LEFT("ahead-left", listOf(HapticPulse(80, 110), HapticPulse(80))),
  AHEAD_RIGHT(
    "ahead-right",
    listOf(HapticPulse(80, 110), HapticPulse(80, 110), HapticPulse(80))
  ),
  LEFT("left", listOf(HapticPulse(120, 330), HapticPulse(120))),
  RIGHT(
    "right",
    listOf(HapticPulse(120, 330), HapticPulse(120, 330), HapticPulse(120))
  ),
  BEHIND("behind", listOf(HapticPulse(380, 200), HapticPulse(380))),
  UNKNOWN(
    "unknown",
    listOf(HapticPulse(65, 100), HapticPulse(65, 330), HapticPulse(65, 100), HapticPulse(65))
  );

  companion object {
    fun parse(value: String): HapticDirection =
      values().firstOrNull { it.value == value }
        ?: throw IllegalArgumentException("Unsupported haptic direction '$value'.")
  }
}

private enum class HapticSeverity(val value: String, val baseAmplitude: Float) {
  INFO("info", 0.45f),
  CAUTION("caution", 0.72f),
  URGENT("urgent", 0.95f);

  companion object {
    fun parse(value: String): HapticSeverity =
      values().firstOrNull { it.value == value }
        ?: throw IllegalArgumentException("Unsupported haptic severity '$value'.")
  }
}

private data class HapticPulse(val durationMs: Long, val gapAfterMs: Long = 0)

class TensorFoldHapticsModule : Module() {
  private var vibrator: Vibrator? = null

  override fun definition() = ModuleDefinition {
    Name("TensorFoldHaptics")

    OnCreate {
      cachedVibrator()
    }
    OnActivityEntersBackground {
      stopPlayback()
    }
    OnUserLeavesActivity {
      stopPlayback()
    }
    OnActivityDestroys {
      stopPlayback()
    }
    OnDestroy {
      stopPlayback()
      vibrator = null
    }

    AsyncFunction("getCapabilities") { capabilities() }

    AsyncFunction("play") { request: HapticRequest ->
      play(request)
    }

    AsyncFunction("stop") {
      stopPlayback()
    }
  }

  private fun capabilities(): Map<String, Any?> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return mapOf(
        "platform" to "android",
        "available" to false,
        "customPatterns" to false,
        "amplitudeControl" to false,
        "reason" to "Android waveform playback requires Android 8.0 or newer."
      )
    }

    val device = cachedVibrator()
    if (device == null) {
      return unavailableCapabilities("The Android runtime context is unavailable.")
    }
    val hasVibrator = device.hasVibrator()
    return mapOf(
      "platform" to "android",
      "available" to hasVibrator,
      "customPatterns" to hasVibrator,
      "amplitudeControl" to (hasVibrator && device.hasAmplitudeControl()),
      "reason" to if (hasVibrator) null else "This device does not report a vibration actuator."
    )
  }

  private fun play(request: HapticRequest): Map<String, Any> {
    val direction = HapticDirection.parse(request.direction)
    val severity = HapticSeverity.parse(request.severity)

    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return unavailable("Android waveform playback requires Android 8.0 or newer.")
    }
    val device = cachedVibrator() ?: return unavailable("The Android runtime context is unavailable.")
    if (!device.hasVibrator()) {
      return unavailable("This device does not report a vibration actuator.")
    }

    val amplitudeSupported = device.hasAmplitudeControl()
    val pulses = pulsesWithUrgency(direction, severity)
    val close = request.distanceMeters?.let { it.isFinite() && it >= 0.0 && it <= 1.5 } == true
    val amplitude = if (close) {
      (severity.baseAmplitude + 0.08f).coerceAtMost(1.0f)
    } else {
      severity.baseAmplitude
    }

    return try {
      // Replace rather than overlap cues. Each call is one finite pattern.
      device.cancel()
      val effect = if (pulses.size == 1) {
        VibrationEffect.createOneShot(
          pulses[0].durationMs,
          if (amplitudeSupported) amplitude.toDeviceAmplitude() else VibrationEffect.DEFAULT_AMPLITUDE
        )
      } else if (amplitudeSupported) {
        val timings = waveformTimings(pulses)
        val amplitudes = IntArray(timings.size)
        for (index in amplitudes.indices step 2) {
          amplitudes[index] = 0
        }
        for (index in 1 until amplitudes.size step 2) {
          amplitudes[index] = amplitude.toDeviceAmplitude()
        }
        VibrationEffect.createWaveform(timings, amplitudes, -1)
      } else {
        // Rhythm and urgency suffixes survive without amplitude control.
        VibrationEffect.createWaveform(waveformTimings(pulses), -1)
      }
      device.vibrate(effect)
      mapOf("status" to "played", "amplitudeControl" to amplitudeSupported)
    } catch (error: RuntimeException) {
      unavailable("Android rejected the haptic pattern: ${error.message ?: error.javaClass.simpleName}")
    }
  }

  private fun stopPlayback() {
    cachedVibrator()?.cancel()
  }

  private fun cachedVibrator(): Vibrator? {
    vibrator?.let { return it }
    val context = appContext.reactContext ?: return null
    val resolved = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
    }
    vibrator = resolved
    return resolved
  }

  private fun unavailableCapabilities(reason: String): Map<String, Any?> = mapOf(
    "platform" to "android",
    "available" to false,
    "customPatterns" to false,
    "amplitudeControl" to false,
    "reason" to reason
  )

  private fun unavailable(reason: String): Map<String, Any> = mapOf(
    "status" to "unavailable",
    "reason" to reason
  )

  private fun pulsesWithUrgency(direction: HapticDirection, severity: HapticSeverity): List<HapticPulse> {
    if (severity == HapticSeverity.INFO) return direction.pulses

    val suffix = if (severity == HapticSeverity.CAUTION) {
      listOf(HapticPulse(90))
    } else {
      listOf(HapticPulse(70, 110), HapticPulse(70))
    }
    val pulses = ArrayList<HapticPulse>(direction.pulses.size + suffix.size)
    pulses.addAll(direction.pulses)
    val lastDirectionIndex = direction.pulses.lastIndex
    pulses[lastDirectionIndex] = direction.pulses[lastDirectionIndex].copy(gapAfterMs = 240)
    pulses.addAll(suffix)
    return pulses
  }

  private fun waveformTimings(pulses: List<HapticPulse>): LongArray {
    val timings = LongArray(pulses.size * 2)
    timings[0] = 0
    for (index in pulses.indices) {
      timings[index * 2 + 1] = pulses[index].durationMs
      if (index < pulses.lastIndex) {
        timings[index * 2 + 2] = pulses[index].gapAfterMs
      }
    }
    return timings
  }

  private fun Float.toDeviceAmplitude(): Int = (this * 255).roundToInt().coerceIn(1, 255)
}
