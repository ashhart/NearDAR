package expo.modules.tensorfoldhaptics

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlin.math.abs
import kotlin.math.roundToInt

class HapticRequest : Record {
  @Field var direction: String = "unknown"
  @Field var severity: String = "info"
  @Field var distanceMeters: Double? = null
}

class GuidanceHapticState : Record {
  @Field var active: Boolean = false
  @Field var steeringEnabled: Boolean = true
  @Field var proximityEnabled: Boolean = true
  @Field var headingOffsetDeg: Double? = null
  @Field var forwardClearanceMeters: Double? = null
  @Field var muted: Boolean = false
}

private data class HapticPulse(
  val durationMs: Long,
  val gapAfterMs: Long = 0L,
  val intensity: Float? = null
)

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

private enum class HapticCue(val value: String, val pulses: List<HapticPulse>) {
  MIC_OPEN(
    "mic-open",
    listOf(HapticPulse(25, 40, 0.55f), HapticPulse(30, 0, 0.80f))
  ),
  MIC_CLOSE(
    "mic-close",
    listOf(HapticPulse(25, 0, 0.45f))
  ),
  THINKING_TICK(
    "thinking-tick",
    listOf(HapticPulse(20, 0, 0.24f))
  ),
  TURN_APPROACHING(
    "turn-approaching",
    listOf(HapticPulse(50, 90, 0.48f), HapticPulse(60, 0, 0.74f))
  ),
  TURN_LEFT(
    "turn-left",
    listOf(HapticPulse(80, 90, 0.78f), HapticPulse(80, 0, 0.78f))
  ),
  TURN_RIGHT(
    "turn-right",
    listOf(HapticPulse(45, 65, 0.78f), HapticPulse(45, 65, 0.78f), HapticPulse(45, 0, 0.82f))
  ),
  OFF_ROUTE(
    "off-route",
    listOf(HapticPulse(220, 0, 0.62f))
  ),
  HEAD_HAZARD(
    "head-hazard",
    listOf(HapticPulse(40, 55, 0.95f), HapticPulse(40, 55, 0.95f), HapticPulse(40, 0, 1.0f))
  ),
  DROP_OFF(
    "drop-off",
    listOf(HapticPulse(140, 90, 1.0f), HapticPulse(140, 0, 0.92f))
  ),
  FAST_MOVER(
    "fast-mover",
    listOf(
      HapticPulse(30, 35, 1.0f),
      HapticPulse(30, 35, 1.0f),
      HapticPulse(30, 35, 1.0f),
      HapticPulse(45, 0, 1.0f)
    )
  ),
  ANIMAL(
    "animal",
    listOf(HapticPulse(35, 90, 0.48f), HapticPulse(35, 0, 0.56f))
  ),
  OPENING(
    "opening",
    listOf(HapticPulse(25, 60, 0.36f), HapticPulse(35, 0, 0.52f))
  ),
  STANDBY(
    "standby",
    listOf(HapticPulse(60, 0, 0.30f))
  ),
  ARRIVED(
    "arrived",
    listOf(HapticPulse(50, 80, 0.48f), HapticPulse(60, 80, 0.68f), HapticPulse(100, 0, 0.86f))
  ),
  PAUSED(
    "paused",
    listOf(HapticPulse(50, 70, 0.60f), HapticPulse(40, 0, 0.35f))
  ),
  RESUMED(
    "resumed",
    listOf(HapticPulse(40, 70, 0.42f), HapticPulse(60, 0, 0.72f))
  );

  companion object {
    fun parse(value: String): HapticCue =
      values().firstOrNull { it.value == value }
        ?: throw IllegalArgumentException("Unsupported haptic cue '$value'.")
  }
}

class TensorFoldHapticsModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var vibrator: Vibrator? = null
  private var guidanceState = GuidanceHapticState()
  private var guidanceRunning = false
  private var lastGuidancePulseMs = 0L
  private var cueHoldUntilMs = 0L

  private val guidanceTick = object : Runnable {
    override fun run() {
      if (!guidanceRunning) return
      tickGuidance()
      if (guidanceRunning) {
        mainHandler.postDelayed(this, GUIDANCE_TICK_MS)
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("TensorFoldHaptics")

    OnCreate {
      runOnMain { cachedVibrator() }
    }
    OnActivityEntersBackground {
      runOnMain { stopPlayback() }
    }
    OnUserLeavesActivity {
      runOnMain { stopPlayback() }
    }
    OnActivityDestroys {
      runOnMain { stopPlayback() }
    }
    OnDestroy {
      runOnMain {
        stopPlayback()
        vibrator = null
      }
    }

    AsyncFunction("getCapabilities") { capabilities() }.runOnQueue(Queues.MAIN)

    AsyncFunction("play") { request: HapticRequest ->
      play(request)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("playCue") { cueName: String ->
      playCue(cueName)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("updateGuidance") { state: GuidanceHapticState ->
      updateGuidance(state)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stopGuidance") {
      stopGuidanceLoop()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stop") {
      stopPlayback()
    }.runOnQueue(Queues.MAIN)
  }

  private fun capabilities(): Map<String, Any?> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return mapOf(
        "platform" to "android",
        "available" to false,
        "customPatterns" to false,
        "amplitudeControl" to false,
        "continuousGuidance" to false,
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
      "continuousGuidance" to hasVibrator,
      "reason" to if (hasVibrator) null else "This device does not report a vibration actuator."
    )
  }

  private fun play(request: HapticRequest): Map<String, Any> {
    val direction = HapticDirection.parse(request.direction)
    val severity = HapticSeverity.parse(request.severity)

    val pulses = pulsesWithUrgency(direction, severity)
    val close = request.distanceMeters?.let { it.isFinite() && it >= 0.0 && it <= 1.5 } == true
    val amplitude = if (close) {
      (severity.baseAmplitude + 0.08f).coerceAtMost(1.0f)
    } else {
      severity.baseAmplitude
    }

    cueHoldUntilMs = SystemClock.elapsedRealtime() + 550L
    return playPulses(pulses, defaultAmplitude = amplitude)
  }

  private fun playCue(cueName: String): Map<String, Any> {
    val cue = HapticCue.parse(cueName)
    cueHoldUntilMs = SystemClock.elapsedRealtime() + 450L
    return playPulses(cue.pulses, defaultAmplitude = 0.70f)
  }

  private fun updateGuidance(state: GuidanceHapticState): Map<String, Any> {
    guidanceState = state
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      stopGuidanceLoop()
      return unavailable("Android waveform playback requires Android 8.0 or newer.")
    }
    val device = cachedVibrator()
    if (device == null) {
      stopGuidanceLoop()
      return unavailable("The Android runtime context is unavailable.")
    }
    if (!device.hasVibrator()) {
      stopGuidanceLoop()
      return unavailable("This device does not report a vibration actuator.")
    }
    if (!state.active) {
      stopGuidanceLoop()
      return mapOf("status" to "stopped")
    }
    if (!guidanceRunning) {
      guidanceRunning = true
      mainHandler.removeCallbacks(guidanceTick)
      mainHandler.postDelayed(guidanceTick, GUIDANCE_TICK_MS)
    }
    return mapOf("status" to "active")
  }

  private fun tickGuidance() {
    if (!guidanceState.active || guidanceState.muted) return
    val now = SystemClock.elapsedRealtime()
    if (now < cueHoldUntilMs) return

    // Priority 1: Proximity radar (parking-sensor cadence below 2.2m)
    val clearance = guidanceState.forwardClearanceMeters
    if (guidanceState.proximityEnabled && clearance != null && clearance.isFinite() && clearance > 0.0 && clearance < 2.2) {
      val intervalMs: Long
      val pulses: List<HapticPulse>
      if (clearance < 0.70) {
        intervalMs = 340L
        pulses = listOf(
          HapticPulse(40, 60, 0.95f),
          HapticPulse(40, 0, 0.95f)
        )
      } else if (clearance < 1.35) {
        val ratio = ((1.35 - clearance) / 0.65).toFloat().coerceIn(0f, 1f)
        intervalMs = (620.0 - ratio * 240.0).toLong()
        pulses = listOf(HapticPulse(40, 0, 0.68f + ratio * 0.20f))
      } else {
        val ratio = ((2.20 - clearance) / 0.85).toFloat().coerceIn(0f, 1f)
        intervalMs = (1050.0 - ratio * 380.0).toLong()
        pulses = listOf(HapticPulse(35, 0, 0.38f + ratio * 0.22f))
      }
      if (now - lastGuidancePulseMs >= intervalMs) {
        lastGuidancePulseMs = now
        playPulses(pulses, defaultAmplitude = 0.70f)
      }
      return
    }

    // Priority 2: Compass / open-corridor lock pulse ("Follow the Beat")
    val offset = guidanceState.headingOffsetDeg
    if (guidanceState.steeringEnabled && offset != null && offset.isFinite()) {
      val absOffset = abs(offset)
      if (absOffset <= 15.0) {
        if (now - lastGuidancePulseMs >= 1150L) {
          lastGuidancePulseMs = now
          playPulses(listOf(HapticPulse(30, 0, 0.42f)), defaultAmplitude = 0.42f)
        }
      } else if (absOffset <= 32.0) {
        if (now - lastGuidancePulseMs >= 1650L) {
          lastGuidancePulseMs = now
          playPulses(listOf(HapticPulse(25, 0, 0.22f)), defaultAmplitude = 0.22f)
        }
      }
    }
  }

  private fun playPulses(pulses: List<HapticPulse>, defaultAmplitude: Float = 0.70f): Map<String, Any> {
    if (pulses.isEmpty()) {
      return mapOf("status" to "played", "amplitudeControl" to false)
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return unavailable("Android waveform playback requires Android 8.0 or newer.")
    }
    val device = cachedVibrator() ?: return unavailable("The Android runtime context is unavailable.")
    if (!device.hasVibrator()) {
      return unavailable("This device does not report a vibration actuator.")
    }

    val amplitudeSupported = device.hasAmplitudeControl()
    return try {
      // Replace rather than overlap cues. Each call is one finite pattern.
      device.cancel()
      val effect = if (pulses.size == 1) {
        val pulseAmplitude = (pulses[0].intensity ?: defaultAmplitude).coerceIn(0.05f, 1.0f)
        VibrationEffect.createOneShot(
          pulses[0].durationMs.coerceAtLeast(1L),
          if (amplitudeSupported) pulseAmplitude.toDeviceAmplitude() else VibrationEffect.DEFAULT_AMPLITUDE
        )
      } else if (amplitudeSupported) {
        val timings = waveformTimings(pulses)
        val amplitudes = IntArray(timings.size)
        for (index in pulses.indices) {
          val pulseAmplitude = (pulses[index].intensity ?: defaultAmplitude).coerceIn(0.05f, 1.0f)
          amplitudes[index * 2 + 1] = pulseAmplitude.toDeviceAmplitude()
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

  private fun stopGuidanceLoop() {
    guidanceRunning = false
    mainHandler.removeCallbacks(guidanceTick)
    guidanceState.active = false
  }

  private fun stopPlayback() {
    stopGuidanceLoop()
    cachedVibrator()?.cancel()
  }

  private fun runOnMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      block()
    } else {
      mainHandler.post(block)
    }
  }

  private fun cachedVibrator(): Vibrator? {
    vibrator?.let { return it }
    val context = appContext.reactContext ?: return null
    val resolved = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }
    vibrator = resolved
    return resolved
  }

  private fun unavailableCapabilities(reason: String): Map<String, Any?> = mapOf(
    "platform" to "android",
    "available" to false,
    "customPatterns" to false,
    "amplitudeControl" to false,
    "continuousGuidance" to false,
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
    timings[0] = 0L
    for (index in pulses.indices) {
      timings[index * 2 + 1] = pulses[index].durationMs.coerceAtLeast(1L)
      if (index < pulses.lastIndex) {
        timings[index * 2 + 2] = pulses[index].gapAfterMs.coerceAtLeast(1L)
      }
    }
    return timings
  }

  private fun Float.toDeviceAmplitude(): Int = (this * 255).roundToInt().coerceIn(1, 255)

  companion object {
    private const val GUIDANCE_TICK_MS = 100L
  }
}
