package expo.modules.tensorfoldperception

import android.graphics.ImageFormat
import android.media.Image
import com.google.ar.core.CameraIntrinsics
import java.nio.FloatBuffer
import java.util.Locale
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

data class CorridorSector(
  val index: Int,
  val centerDegrees: Double,
  val label: String,
  val clearanceMeters: Double,
  val sampleCount: Int,
  val confidence: Double
) {
  fun toMap(): Map<String, Any> = mapOf(
    "index" to index,
    "centerDegrees" to centerDegrees,
    "label" to label,
    "clearanceMeters" to clearanceMeters,
    "sampleCount" to sampleCount,
    "confidence" to confidence
  )
}

data class CorridorOpening(
  val bearingDegrees: Double,
  val direction: String,
  val distanceMeters: Double,
  val clearanceMeters: Double,
  val widthDegrees: Double
) {
  fun toMap(): Map<String, Any> = mapOf(
    "bearingDegrees" to bearingDegrees,
    "direction" to direction,
    "distanceMeters" to distanceMeters,
    "clearanceMeters" to clearanceMeters,
    "widthDegrees" to widthDegrees
  )
}

data class SpatialHazard(
  val id: String,
  val kind: String, // "fast-mover" | "obstacle" | "head-height" | "step-down" | "step-up" | "drop-off" | "doorway"
  val severity: String, // "info" | "caution" | "urgent"
  val direction: String,
  val bearingDegrees: Double,
  val distanceMeters: Double,
  val confidence: Double,
  val message: String,
  val closingSpeedMps: Double? = null,
  val externalSpeedMps: Double? = null,
  val ttcSeconds: Double? = null
) {
  fun toMap(timestampMs: Double): Map<String, Any> {
    val result = mutableMapOf<String, Any>(
      "id" to id,
      "kind" to kind,
      "severity" to severity,
      "direction" to direction,
      "bearingDegrees" to bearingDegrees,
      "distanceMeters" to distanceMeters,
      "confidence" to confidence,
      "message" to message,
      "observedAt" to timestampMs
    )
    closingSpeedMps?.let { result["closingSpeedMps"] = it }
    externalSpeedMps?.let { result["externalSpeedMps"] = it }
    ttcSeconds?.let { result["ttcSeconds"] = it }
    return result
  }
}

class ApproachEstimate(
  val sectorClosingSpeedMps: DoubleArray,
  val sectorExternalSpeedMps: DoubleArray,
  val maxClosingSpeedMps: Double,
  val recedingCenter: Boolean,
  val fastMover: SpatialHazard?
)

data class LightAnalysis(
  val ambientLuma: Double,
  val lightingState: String // "good" | "dim" | "dark"
)

/**
 * Fast strided luminance analyzer on Android Camera2 / ARCore YUV_420_888 Y-plane.
 * Matches iOS LightAnalyzer thresholds: < 0.14 dark, < 0.28 dim, >= 0.28 good.
 */
object LightAnalyzer {
  const val DARK_THRESHOLD = 0.14
  const val DIM_THRESHOLD = 0.28

  fun classify(luma: Double): String {
    val clamped = luma.coerceIn(0.0, 1.0)
    return when {
      clamped < DARK_THRESHOLD -> "dark"
      clamped < DIM_THRESHOLD -> "dim"
      else -> "good"
    }
  }

  fun analyze(image: Image): LightAnalysis? {
    if (image.format != ImageFormat.YUV_420_888) return null
    val planes = image.planes
    if (planes.isEmpty()) return null
    val yPlane = planes[0]
    val buffer = yPlane.buffer
    val width = image.width
    val height = image.height
    if (width <= 0 || height <= 0) return null
    val rowStride = yPlane.rowStride
    val pixelStride = yPlane.pixelStride
    val limit = buffer.limit()
    val strideX = max(1, width / 32)
    val strideY = max(1, height / 24)
    var sum = 0L
    var count = 0
    var y = 0
    while (y < height) {
      val rowOffset = y * rowStride
      var x = 0
      while (x < width) {
        val index = rowOffset + x * pixelStride
        if (index in 0 until limit) {
          sum += (buffer.get(index).toInt() and 0xff)
          count++
        }
        x += strideX
      }
      y += strideY
    }
    if (count == 0) return null
    val luma = ((sum.toDouble() / count) / 255.0).coerceIn(0.0, 1.0)
    return LightAnalysis(ambientLuma = luma, lightingState = classify(luma))
  }
}

/**
 * Multi-frame world-compensated approach velocity tracker.
 * Subtracts the user's own walking velocity along each sector ray so static walls never trigger
 * false alarms, while approaching cyclists, e-scooters, runners, or loose dogs are flagged rapidly.
 */
class ApproachTracker {
  private class FrameState(
    val timestampSec: Double,
    val posX: Float,
    val posZ: Float,
    val fwdX: Float,
    val fwdZ: Float,
    val clearances: DoubleArray,
    val validMask: BooleanArray
  )

  private var previous: FrameState? = null
  private val emaClosing = DoubleArray(7)
  private val emaExternal = DoubleArray(7)
  private val fastStreak = IntArray(7)

  fun reset() {
    previous = null
    emaClosing.fill(0.0)
    emaExternal.fill(0.0)
    fastStreak.fill(0)
  }

  fun update(
    timestampSec: Double,
    poseMatrix: FloatArray,
    sectors: List<CorridorSector>,
    aimState: String
  ): ApproachEstimate {
    val neutral = ApproachEstimate(
      sectorClosingSpeedMps = DoubleArray(7),
      sectorExternalSpeedMps = DoubleArray(7),
      maxClosingSpeedMps = 0.0,
      recedingCenter = false,
      fastMover = null
    )

    if (sectors.size != 7 || poseMatrix.size < 16 || aimState == "lowered" || aimState == "covered") {
      reset()
      return neutral
    }

    val posX = poseMatrix[12]
    val posZ = poseMatrix[14]
    val rawFwdX = -poseMatrix[8]
    val rawFwdZ = -poseMatrix[10]
    val fwdLen = hypot(rawFwdX.toDouble(), rawFwdZ.toDouble()).toFloat()
    if (fwdLen < 0.25f) {
      reset()
      return neutral
    }
    val fwdX = rawFwdX / fwdLen
    val fwdZ = rawFwdZ / fwdLen
    val rightX = -fwdZ
    val rightZ = fwdX

    val clearances = DoubleArray(7) { sectors[it].clearanceMeters }
    val validMask = BooleanArray(7) { i ->
      val s = sectors[i]
      s.sampleCount >= 3 && s.clearanceMeters > 0.25 && s.clearanceMeters < CorridorAnalyzer.MAX_RANGE_METERS - 0.15
    }

    val current = FrameState(
      timestampSec = timestampSec,
      posX = posX,
      posZ = posZ,
      fwdX = fwdX,
      fwdZ = fwdZ,
      clearances = clearances,
      validMask = validMask
    )

    val prev = previous
    if (prev == null) {
      previous = current
      return neutral
    }

    val dt = timestampSec - prev.timestampSec
    if (abs(dt) < 0.001) {
      // Same frame re-evaluated (e.g. capture on current ARFrame); preserve existing state.
      return buildEstimate(sectors)
    }
    if (dt < 0.05 || dt > 0.85) {
      reset()
      previous = current
      return neutral
    }

    // Reject rapid camera panning so swinging the phone past a wall does not create synthetic velocity.
    val dotFwd = (prev.fwdX.toDouble() * fwdX + prev.fwdZ.toDouble() * fwdZ).coerceIn(-1.0, 1.0)
    val deltaYawDeg = acos(dotFwd) * 180.0 / Math.PI
    if (deltaYawDeg > 12.0) {
      reset()
      previous = current
      return neutral
    }

    val dCamX = (posX - prev.posX).toDouble()
    val dCamZ = (posZ - prev.posZ).toDouble()
    val camSpeed = hypot(dCamX, dCamZ) / dt
    if (camSpeed > 6.5) {
      // Unrealistic ARCore relocalization jump
      reset()
      previous = current
      return neutral
    }

    for (i in 0 until 7) {
      if (prev.validMask[i] && current.validMask[i]) {
        val rawClosing = (prev.clearances[i] - current.clearances[i]) / dt
        // Guard against sharp occlusion edges / stepping past a doorframe (> 16 m/s is noise/step jump)
        if (abs(rawClosing) > 16.0) {
          fastStreak[i] = 0
          emaClosing[i] *= 0.4
          emaExternal[i] *= 0.4
          continue
        }
        val rad = CorridorAnalyzer.SECTOR_CENTERS[i] * Math.PI / 180.0
        val cosR = cos(rad)
        val sinR = sin(rad)
        val rayX = fwdX * cosR + rightX * sinR
        val rayZ = fwdZ * cosR + rightZ * sinR
        val camAlongRay = (dCamX * rayX + dCamZ * rayZ) / dt
        val rawExternal = rawClosing - camAlongRay

        val alpha = 0.55
        emaClosing[i] = emaClosing[i] * (1.0 - alpha) + rawClosing * alpha
        emaExternal[i] = emaExternal[i] * (1.0 - alpha) + rawExternal * alpha

        if (rawExternal >= 1.25 && rawClosing >= 1.35 && current.clearances[i] <= 4.5) {
          fastStreak[i] += 1
        } else {
          fastStreak[i] = 0
        }
      } else {
        fastStreak[i] = 0
        emaClosing[i] *= 0.35
        emaExternal[i] *= 0.35
      }
    }

    previous = current
    return buildEstimate(sectors)
  }

  private fun buildEstimate(sectors: List<CorridorSector>): ApproachEstimate {
    var bestFast: SpatialHazard? = null
    var bestScore = -1.0

    for (i in 0 until 7) {
      val dist = sectors[i].clearanceMeters
      val ext = emaExternal[i]
      val closing = emaClosing[i]
      if (fastStreak[i] < 2 || ext < 1.35 || closing < 1.5 || dist <= 0.25 || dist > 4.3) continue
      val ttc = dist / max(0.3, closing)
      if (ttc > 2.6 && dist > 2.5) continue
      val urgencyScore = (1.0 / max(0.2, ttc)) + (ext * 0.25)
      if (urgencyScore > bestScore) {
        bestScore = urgencyScore
        val dir = CorridorAnalyzer.directionLabel(sectors[i].centerDegrees)
        val spokenDir = dir.replace("-", " ")
        val distText = CorridorAnalyzer.formatMetres(dist)
        bestFast = SpatialHazard(
          id = "arcore-fast-mover",
          kind = "fast-mover",
          severity = "urgent",
          direction = dir,
          bearingDegrees = sectors[i].centerDegrees,
          distanceMeters = dist,
          confidence = min(0.95, max(0.7, sectors[i].confidence)),
          message = "Fast movement $spokenDir, $distText — hold still.",
          closingSpeedMps = closing,
          externalSpeedMps = ext,
          ttcSeconds = ttc
        )
      }
    }

    var maxClosing = 0.0
    for (v in emaClosing) {
      if (v > maxClosing) maxClosing = v
    }
    var nearestCenter = 3
    if (sectors[2].clearanceMeters < sectors[nearestCenter].clearanceMeters) nearestCenter = 2
    if (sectors[4].clearanceMeters < sectors[nearestCenter].clearanceMeters) nearestCenter = 4
    val recedingCenter = emaClosing[nearestCenter] <= -0.35 && fastStreak[nearestCenter] == 0

    return ApproachEstimate(
      sectorClosingSpeedMps = emaClosing.copyOf(),
      sectorExternalSpeedMps = emaExternal.copyOf(),
      maxClosingSpeedMps = maxClosing,
      recedingCenter = recedingCenter,
      fastMover = bestFast
    )
  }
}

data class CorridorAnalysis(
  val sectors: List<CorridorSector>,
  val openings: List<CorridorOpening>,
  val recommendedHeadingOffsetDeg: Double,
  val corridorState: String, // "clear" | "narrow" | "blocked" | "unknown"
  val forwardClearanceMeters: Double,
  val bestClearanceMeters: Double,
  val aimState: String, // "level" | "too-low" | "too-high" | "lowered" | "covered"
  val pitchDegrees: Double,
  val headingDegrees: Double?,
  val floorHeightMeters: Double?,
  val maxClosingSpeedMps: Double,
  val recedingObstacle: Boolean,
  val hazards: List<SpatialHazard>,
  val valid: Boolean
) {
  fun toMap(): Map<String, Any> {
    val result = mutableMapOf<String, Any>(
      "sectors" to sectors.map { it.toMap() },
      "openings" to openings.map { it.toMap() },
      "recommendedHeadingOffsetDeg" to recommendedHeadingOffsetDeg,
      "corridorState" to corridorState,
      "forwardClearanceMeters" to forwardClearanceMeters,
      "bestClearanceMeters" to bestClearanceMeters,
      "aimState" to aimState,
      "pitchDegrees" to pitchDegrees,
      "maxClosingSpeedMps" to maxClosingSpeedMps,
      "recedingObstacle" to recedingObstacle,
      "valid" to valid
    )
    headingDegrees?.let { result["headingDegrees"] = it }
    floorHeightMeters?.let { result["floorHeightMeters"] = it }
    return result
  }

  fun hazardMaps(timestampMs: Double): List<Map<String, Any>> =
    hazards.map { it.toMap(timestampMs) }

  fun applying(approach: ApproachEstimate): CorridorAnalysis {
    val mergedHazards = mutableListOf<SpatialHazard>()
    if (approach.fastMover != null) {
      mergedHazards.add(approach.fastMover)
      mergedHazards.addAll(hazards)
    } else if (approach.recedingCenter) {
      // De-escalate static torso obstacle if the surface ahead is actively moving away from the user.
      for (hazard in hazards) {
        if (hazard.kind == "obstacle" && hazard.severity == "caution") {
          mergedHazards.add(
            hazard.copy(
              severity = "info",
              closingSpeedMps = approach.sectorClosingSpeedMps[3],
              externalSpeedMps = approach.sectorExternalSpeedMps[3]
            )
          )
        } else {
          mergedHazards.add(hazard)
        }
      }
    } else {
      mergedHazards.addAll(hazards)
    }

    return copy(
      maxClosingSpeedMps = approach.maxClosingSpeedMps,
      recedingObstacle = approach.recedingCenter,
      hazards = mergedHazards
    )
  }
}

object CorridorAnalyzer {
  val SECTOR_CENTERS = doubleArrayOf(-45.0, -30.0, -15.0, 0.0, 15.0, 30.0, 45.0)
  val SECTOR_LABELS = arrayOf("far-left", "left", "ahead-left", "ahead", "ahead-right", "right", "far-right")
  const val MAX_RANGE_METERS = 5.0
  private const val DEFAULT_CAMERA_HEIGHT_ABOVE_FLOOR = 1.15f
  private const val LANYARD_PITCH_COMPENSATION_DEG = 14.0

  fun cameraPitchDegrees(poseMatrix: FloatArray): Double {
    if (poseMatrix.size < 16) return 0.0
    val fx = -poseMatrix[8].toDouble()
    val fy = -poseMatrix[9].toDouble()
    val fz = -poseMatrix[10].toDouble()
    val len = sqrt(fx * fx + fy * fy + fz * fz)
    if (len <= 0.001) return 0.0
    val ny = (fy / len).coerceIn(-1.0, 1.0)
    return asin(ny) * 180.0 / Math.PI
  }

  /**
   * Evaluates camera aim state from raw pitch and near-occlusion fraction.
   * In "lanyard" mode, applies +14.0 deg chest-mount pitch compensation and requires < -68 deg
   * before entering "lowered" standby so chest-mounted phones never nag or sleep prematurely.
   */
  fun aimState(
    pitchDegrees: Double,
    coveredFraction: Double = 0.0,
    mountMode: String = "handheld"
  ): String {
    if (coveredFraction >= 0.85) return "covered"
    if (mountMode == "lanyard") {
      if (pitchDegrees < -68.0) return "lowered"
      val compensated = pitchDegrees + LANYARD_PITCH_COMPENSATION_DEG
      if (compensated < -35.0) return "too-low"
      if (compensated > 25.0) return "too-high"
      return "level"
    }
    if (pitchDegrees < -58.0) return "lowered"
    if (pitchDegrees < -35.0) return "too-low"
    if (pitchDegrees > 25.0) return "too-high"
    return "level"
  }

  fun directionLabel(bearingDegrees: Double): String = when {
    bearingDegrees < -37.5 -> "left"
    bearingDegrees < -10.0 -> "ahead-left"
    bearingDegrees > 37.5 -> "right"
    bearingDegrees > 10.0 -> "ahead-right"
    else -> "ahead"
  }

  fun detectOpenings(sectors: List<CorridorSector>): List<CorridorOpening> {
    if (sectors.size != 7) return emptyList()
    val openings = mutableListOf<CorridorOpening>()
    var skipNext = false
    for (i in 1..5) {
      if (skipNext) {
        skipNext = false
        continue
      }
      val current = sectors[i].clearanceMeters
      if (current < 2.8) continue
      val leftFlank = sectors[i - 1].clearanceMeters
      val rightFlank = sectors[i + 1].clearanceMeters

      // Single-sector doorway / narrow gap (15 deg wide)
      if (leftFlank < 1.75 && rightFlank < 1.75 && current - max(leftFlank, rightFlank) >= 1.1) {
        val flankDist = min(leftFlank, rightFlank)
        openings.add(
          CorridorOpening(
            bearingDegrees = sectors[i].centerDegrees,
            direction = directionLabel(sectors[i].centerDegrees),
            distanceMeters = flankDist,
            clearanceMeters = current,
            widthDegrees = 15.0
          )
        )
        continue
      }

      // Two-sector doorway / wide opening (30 deg wide)
      if (i <= 4 && leftFlank < 1.75 && sectors[i + 1].clearanceMeters >= 2.8 && sectors[i + 2].clearanceMeters < 1.75) {
        val wideClear = min(current, sectors[i + 1].clearanceMeters)
        val farRightFlank = sectors[i + 2].clearanceMeters
        if (wideClear - max(leftFlank, farRightFlank) >= 1.1) {
          val midBearing = (sectors[i].centerDegrees + sectors[i + 1].centerDegrees) * 0.5
          openings.add(
            CorridorOpening(
              bearingDegrees = midBearing,
              direction = directionLabel(midBearing),
              distanceMeters = min(leftFlank, farRightFlank),
              clearanceMeters = wideClear,
              widthDegrees = 30.0
            )
          )
          skipNext = true
        }
      }
    }
    return openings
  }

  fun analyze(
    depthImage: Image,
    confidenceImage: Image?,
    intrinsics: CameraIntrinsics,
    poseMatrix: FloatArray,
    headingDegrees: Double? = null,
    knownFloorY: Float? = null,
    mountMode: String = "handheld",
    warningDistance: Double = 2.5,
    criticalDistance: Double = 0.9
  ): CorridorAnalysis {
    val pitch = cameraPitchDegrees(poseMatrix)
    val baseAim = aimState(pitchDegrees = pitch, mountMode = mountMode)

    if (poseMatrix.size < 16 || confidenceImage == null || baseAim == "lowered") {
      return invalidAnalysis(baseAim, pitch, headingDegrees, knownFloorY)
    }

    val camX = poseMatrix[12]
    val camY = poseMatrix[13]
    val camZ = poseMatrix[14]
    val forwardWorldX = -poseMatrix[8]
    val forwardWorldZ = -poseMatrix[10]
    val horizLen = hypot(forwardWorldX.toDouble(), forwardWorldZ.toDouble()).toFloat()

    val dimensions = intrinsics.imageDimensions
    val focal = intrinsics.focalLength
    val principal = intrinsics.principalPoint
    if (
      horizLen < 0.20f ||
      dimensions.size < 2 || dimensions[0] <= 0 || dimensions[1] <= 0 ||
      focal.size < 2 || focal[0] <= 0f || focal[1] <= 0f ||
      principal.size < 2
    ) {
      return invalidAnalysis(baseAim, pitch, headingDegrees, knownFloorY)
    }

    val width = depthImage.width
    val height = depthImage.height
    if (width <= 0 || height <= 0 || confidenceImage.width != width || confidenceImage.height != height) {
      return invalidAnalysis(baseAim, pitch, headingDegrees, knownFloorY)
    }

    val horizFwdX = (forwardWorldX / horizLen).toDouble()
    val horizFwdZ = (forwardWorldZ / horizLen).toDouble()
    // Right vector in world XZ plane: forward x up = (-forward.z, forward.x)
    val horizRightX = -horizFwdZ
    val horizRightZ = horizFwdX

    val fx = focal[0]
    val fy = focal[1]
    val cx = principal[0]
    val cy = principal[1]
    val resW = dimensions[0].toFloat()
    val resH = dimensions[1].toFloat()

    val depthPlane = depthImage.planes[0]
    val confPlane = confidenceImage.planes[0]
    val depthBuffer = depthPlane.buffer
    val confBuffer = confPlane.buffer
    val depthRow = depthPlane.rowStride
    val depthPixel = depthPlane.pixelStride
    val confRow = confPlane.rowStride
    val confPixel = confPlane.pixelStride
    val depthLimit = depthBuffer.limit()
    val confLimit = confBuffer.limit()

    val strideX = max(1, width / 96)
    val strideY = max(1, height / 72)

    val estimatedFloorY = knownFloorY ?: (camY - DEFAULT_CAMERA_HEIGHT_ABOVE_FLOOR)

    val sectorDistances = Array(7) { ArrayList<Double>(64) }
    val sectorConfSums = DoubleArray(7)
    val headDistances = ArrayList<Double>(32)
    val headBearings = ArrayList<Double>(32)
    val lowerCenterDistances = ArrayList<Double>(64)
    val floorNearY = ArrayList<Float>(64)
    val floorAheadY = ArrayList<Float>(64)
    val floorAheadDist = ArrayList<Double>(64)
    var totalValid = 0
    var nearCoveredCount = 0

    var y = 0
    while (y < height) {
      val ny = (y + 0.5f) / height.toFloat()
      val py = ny * resH
      val dRowOff = y * depthRow
      val cRowOff = y * confRow
      var x = 0
      while (x < width) {
        val dIdx = dRowOff + x * depthPixel
        val cIdx = cRowOff + x * confPixel
        if (dIdx + 1 < depthLimit && cIdx < confLimit) {
          val millimetres = (depthBuffer.get(dIdx).toInt() and 0xff) or
            ((depthBuffer.get(dIdx + 1).toInt() and 0xff) shl 8)
          val rawConf = confBuffer.get(cIdx).toInt() and 0xff
          val z = millimetres / 1000.0f
          if (millimetres > 0 && rawConf >= 128 && z.isFinite() && z >= 0.15f && z <= 20.0f) {
            totalValid++
            if (z < 0.28f) nearCoveredCount++
            if (z >= 0.25f && z <= 8.0f) {
              val nx = (x + 0.5f) / width.toFloat()
              val px = nx * resW

              // Camera sensor local coordinates: +X right along sensor, +Y up along sensor, -Z forward
              val xCam = (px - cx) / fx * z
              val yCam = -((py - cy) / fy * z)
              val zCam = -z

              val wx = poseMatrix[0] * xCam + poseMatrix[4] * yCam + poseMatrix[8] * zCam + camX
              val wy = poseMatrix[1] * xCam + poseMatrix[5] * yCam + poseMatrix[9] * zCam + camY
              val wz = poseMatrix[2] * xCam + poseMatrix[6] * yCam + poseMatrix[10] * zCam + camZ

              val dx = (wx - camX).toDouble()
              val dz = (wz - camZ).toDouble()
              val fwdDist = dx * horizFwdX + dz * horizFwdZ
              if (fwdDist >= 0.25) {
                val rightDist = dx * horizRightX + dz * horizRightZ
                val bearingDeg = atan2(rightDist, fwdDist) * 180.0 / Math.PI
                val heightAboveFloor = wy - estimatedFloorY
                val conf = rawConf / 255.0

                // Torso / walking corridor band (0.25m to 1.85m above floor)
                if (heightAboveFloor >= 0.25f && heightAboveFloor <= 1.85f && abs(bearingDeg) <= 52.5) {
                  val idx = floor((bearingDeg + 52.5) / 15.0).toInt().coerceIn(0, 6)
                  sectorDistances[idx].add(min(MAX_RANGE_METERS, fwdDist))
                  sectorConfSums[idx] += conf
                }

                // Lower body center band for overhang comparison
                if (abs(bearingDeg) <= 20.0 && heightAboveFloor >= 0.25f && heightAboveFloor <= 1.30f) {
                  lowerCenterDistances.add(min(MAX_RANGE_METERS, fwdDist))
                }

                // Head-height overhang band (relative to camera height, or 1.45m..2.15m above floor)
                val relY = wy - camY
                if (
                  abs(bearingDeg) <= 22.0 &&
                  fwdDist <= 2.2 &&
                  ((heightAboveFloor >= 1.45f && heightAboveFloor <= 2.15f) || (relY >= 0.05f && relY <= 0.65f))
                ) {
                  headDistances.add(fwdDist)
                  headBearings.add(bearingDeg)
                }

                // Floor / step-down / step-up band directly ahead (within +/-0.40m laterally, <= 0.45m above floor)
                if (abs(rightDist) <= 0.40 && heightAboveFloor >= -0.85f && heightAboveFloor <= 0.45f) {
                  if (fwdDist >= 0.60 && fwdDist < 1.25) {
                    floorNearY.add(wy)
                  } else if (fwdDist >= 1.25 && fwdDist <= 2.35) {
                    floorAheadY.add(wy)
                    floorAheadDist.add(fwdDist)
                  }
                }
              }
            }
          }
        }
        x += strideX
      }
      y += strideY
    }

    val coveredFraction = if (totalValid >= 10) nearCoveredCount.toDouble() / totalValid else 0.0
    val aim = aimState(pitchDegrees = pitch, coveredFraction = coveredFraction, mountMode = mountMode)

    if (totalValid < 15 || aim == "covered") {
      return invalidAnalysis(aim, pitch, headingDegrees, knownFloorY)
    }

    val sectors = ArrayList<CorridorSector>(7)
    for (i in 0 until 7) {
      val dists = sectorDistances[i]
      if (dists.size >= 3) {
        dists.sort()
        val p10 = dists[max(0, ((dists.size - 1) * 0.10).toInt())]
        val meanConf = sectorConfSums[i] / dists.size
        sectors.add(
          CorridorSector(
            index = i,
            centerDegrees = SECTOR_CENTERS[i],
            label = SECTOR_LABELS[i],
            clearanceMeters = p10,
            sampleCount = dists.size,
            confidence = meanConf
          )
        )
      } else {
        sectors.add(
          CorridorSector(
            index = i,
            centerDegrees = SECTOR_CENTERS[i],
            label = SECTOR_LABELS[i],
            clearanceMeters = MAX_RANGE_METERS,
            sampleCount = dists.size,
            confidence = if (dists.isEmpty()) 0.35 else sectorConfSums[i] / dists.size
          )
        )
      }
    }

    val openings = detectOpenings(sectors)
    val scoring = scoreCorridor(sectors)

    val hazards = mutableListOf<SpatialHazard>()

    // 1. Head-height overhang check (must be meaningfully closer than torso/lower corridor)
    if (headDistances.size >= 4) {
      headDistances.sort()
      val headNear = headDistances[max(0, ((headDistances.size - 1) * 0.15).toInt())]
      val lowerNear = if (lowerCenterDistances.size >= 4) {
        lowerCenterDistances.sort()
        lowerCenterDistances[max(0, ((lowerCenterDistances.size - 1) * 0.15).toInt())]
      } else {
        MAX_RANGE_METERS
      }
      if (headNear <= 2.0 && lowerNear >= headNear + 0.55) {
        val avgBearing = headBearings.sum() / headBearings.size
        val severity = if (headNear <= 1.1) "urgent" else "caution"
        val dir = directionLabel(avgBearing)
        hazards.add(
          SpatialHazard(
            id = "arcore-head-height",
            kind = "head-height",
            severity = severity,
            direction = dir,
            bearingDegrees = avgBearing,
            distanceMeters = headNear,
            confidence = 0.8,
            message = "Head-height obstacle ${dir.replace("-", " ")}, ${formatMetres(headNear)}."
          )
        )
      }
    }

    // 2. Floor drop-off / step-down / step-up check (requires steady near floor reference)
    var refinedFloorY: Float? = knownFloorY
    if (floorNearY.size >= 6) {
      floorNearY.sort()
      val nearMedian = floorNearY[floorNearY.size / 2]
      refinedFloorY = knownFloorY ?: nearMedian
      if (floorAheadY.size >= 6) {
        floorAheadY.sort()
        val aheadMedian = floorAheadY[floorAheadY.size / 2]
        val deltaY = (aheadMedian - nearMedian).toDouble()
        floorAheadDist.sort()
        val aheadDist = floorAheadDist[max(0, floorAheadDist.size / 4)]
        if (deltaY <= -0.14) {
          val isDropOff = deltaY <= -0.35
          val kind = if (isDropOff) "drop-off" else "step-down"
          val severity = if (aheadDist <= 1.5 || isDropOff) "urgent" else "caution"
          val label = if (isDropOff) "Drop-off" else "Step down"
          hazards.add(
            SpatialHazard(
              id = "arcore-$kind",
              kind = kind,
              severity = severity,
              direction = "ahead",
              bearingDegrees = 0.0,
              distanceMeters = aheadDist,
              confidence = 0.78,
              message = "$label ahead, ${formatMetres(aheadDist)}."
            )
          )
        } else if (deltaY >= 0.12 && deltaY <= 0.35 && scoring.forwardClearance > aheadDist + 0.35) {
          val severity = if (aheadDist <= 1.3) "urgent" else "caution"
          hazards.add(
            SpatialHazard(
              id = "arcore-step-up",
              kind = "step-up",
              severity = severity,
              direction = "ahead",
              bearingDegrees = 0.0,
              distanceMeters = aheadDist,
              confidence = 0.75,
              message = "Step up ahead, ${formatMetres(aheadDist)}."
            )
          )
        }
      }
    }

    // 3. Primary forward torso obstacle (if inside warningDistance)
    val nearestCenterSector = listOf(sectors[2], sectors[3], sectors[4]).minByOrNull { it.clearanceMeters }
    if (nearestCenterSector != null && nearestCenterSector.sampleCount >= 3 && nearestCenterSector.clearanceMeters <= warningDistance) {
      val dist = nearestCenterSector.clearanceMeters
      val severity = if (dist <= criticalDistance) "urgent" else "caution"
      val dir = directionLabel(nearestCenterSector.centerDegrees)
      val steerHint = when {
        scoring.corridorState == "blocked" -> " Path blocked."
        scoring.recommendedOffset <= -15.0 -> " Open space to your left."
        scoring.recommendedOffset >= 15.0 -> " Open space to your right."
        else -> ""
      }
      hazards.add(
        SpatialHazard(
          id = "arcore-corridor-obstacle",
          kind = "obstacle",
          severity = severity,
          direction = dir,
          bearingDegrees = nearestCenterSector.centerDegrees,
          distanceMeters = dist,
          confidence = nearestCenterSector.confidence,
          message = "Obstacle ${dir.replace("-", " ")}, ${formatMetres(dist)}.$steerHint"
        )
      )
    }

    // 4. Nearby doorway or passage opening (informational spatial landmark)
    val bestOpening = openings.minByOrNull { abs(it.bearingDegrees) }
    if (bestOpening != null && bestOpening.distanceMeters <= 2.4) {
      val spokenDir = bestOpening.direction.replace("-", " ")
      hazards.add(
        SpatialHazard(
          id = "arcore-doorway",
          kind = "doorway",
          severity = "info",
          direction = bestOpening.direction,
          bearingDegrees = bestOpening.bearingDegrees,
          distanceMeters = bestOpening.distanceMeters,
          confidence = 0.72,
          message = "Opening $spokenDir, ${formatMetres(bestOpening.distanceMeters)}."
        )
      )
    }

    return CorridorAnalysis(
      sectors = sectors,
      openings = openings,
      recommendedHeadingOffsetDeg = scoring.recommendedOffset,
      corridorState = scoring.corridorState,
      forwardClearanceMeters = scoring.forwardClearance,
      bestClearanceMeters = scoring.bestEffectiveClearance,
      aimState = aim,
      pitchDegrees = pitch,
      headingDegrees = headingDegrees,
      floorHeightMeters = refinedFloorY?.toDouble(),
      maxClosingSpeedMps = 0.0,
      recedingObstacle = false,
      hazards = hazards,
      valid = true
    )
  }

  /**
   * Conservative 7-sector corridor fallback using ARCore sparse 3D feature points when
   * raw depth is unsupported or temporarily unavailable (depthSource = "feature-points").
   */
  fun analyzePointCloud(
    points: FloatBuffer,
    poseMatrix: FloatArray,
    headingDegrees: Double? = null,
    knownFloorY: Float? = null,
    mountMode: String = "handheld",
    warningDistance: Double = 2.5,
    criticalDistance: Double = 0.9
  ): CorridorAnalysis {
    val pitch = cameraPitchDegrees(poseMatrix)
    val aim = aimState(pitchDegrees = pitch, mountMode = mountMode)
    if (poseMatrix.size < 16 || aim == "lowered") {
      return invalidAnalysis(aim, pitch, headingDegrees, knownFloorY)
    }

    val camX = poseMatrix[12]
    val camY = poseMatrix[13]
    val camZ = poseMatrix[14]
    val forwardWorldX = -poseMatrix[8]
    val forwardWorldZ = -poseMatrix[10]
    val horizLen = hypot(forwardWorldX.toDouble(), forwardWorldZ.toDouble()).toFloat()
    if (horizLen < 0.20f) {
      return invalidAnalysis(aim, pitch, headingDegrees, knownFloorY)
    }

    val horizFwdX = (forwardWorldX / horizLen).toDouble()
    val horizFwdZ = (forwardWorldZ / horizLen).toDouble()
    val horizRightX = -horizFwdZ
    val horizRightZ = horizFwdX
    val estimatedFloorY = knownFloorY ?: (camY - DEFAULT_CAMERA_HEIGHT_ABOVE_FLOOR)

    val sectorDistances = Array(7) { ArrayList<Double>(24) }
    val sectorConfSums = DoubleArray(7)
    var totalValid = 0

    val start = points.position()
    val limit = points.limit()
    var offset = start
    while (offset + 3 < limit) {
      val wx = points.get(offset)
      val wy = points.get(offset + 1)
      val wz = points.get(offset + 2)
      val conf = points.get(offset + 3)
      offset += 4
      if (!wx.isFinite() || !wy.isFinite() || !wz.isFinite() || !conf.isFinite() || conf < 0.25f) continue
      val dx = (wx - camX).toDouble()
      val dz = (wz - camZ).toDouble()
      val fwdDist = dx * horizFwdX + dz * horizFwdZ
      if (fwdDist < 0.25 || fwdDist > 8.0) continue
      val rightDist = dx * horizRightX + dz * horizRightZ
      val bearingDeg = atan2(rightDist, fwdDist) * 180.0 / Math.PI
      val heightAboveFloor = wy - estimatedFloorY
      if (heightAboveFloor >= 0.25f && heightAboveFloor <= 1.85f && abs(bearingDeg) <= 52.5) {
        val idx = floor((bearingDeg + 52.5) / 15.0).toInt().coerceIn(0, 6)
        sectorDistances[idx].add(min(MAX_RANGE_METERS, fwdDist))
        sectorConfSums[idx] += conf.toDouble().coerceIn(0.0, 1.0) * 0.65
        totalValid++
      }
    }

    if (totalValid < 8) {
      return invalidAnalysis(aim, pitch, headingDegrees, knownFloorY)
    }

    val sectors = ArrayList<CorridorSector>(7)
    for (i in 0 until 7) {
      val dists = sectorDistances[i]
      if (dists.size >= 2) {
        dists.sort()
        val p20 = dists[max(0, ((dists.size - 1) * 0.20).toInt())]
        sectors.add(
          CorridorSector(
            index = i,
            centerDegrees = SECTOR_CENTERS[i],
            label = SECTOR_LABELS[i],
            clearanceMeters = p20,
            sampleCount = dists.size,
            confidence = sectorConfSums[i] / dists.size
          )
        )
      } else {
        sectors.add(
          CorridorSector(
            index = i,
            centerDegrees = SECTOR_CENTERS[i],
            label = SECTOR_LABELS[i],
            clearanceMeters = MAX_RANGE_METERS,
            sampleCount = dists.size,
            confidence = 0.25
          )
        )
      }
    }

    val openings = detectOpenings(sectors)
    val scoring = scoreCorridor(sectors)
    val hazards = mutableListOf<SpatialHazard>()

    val nearestCenterSector = listOf(sectors[2], sectors[3], sectors[4]).minByOrNull { it.clearanceMeters }
    if (nearestCenterSector != null && nearestCenterSector.sampleCount >= 2 && nearestCenterSector.clearanceMeters <= warningDistance) {
      val dist = nearestCenterSector.clearanceMeters
      val severity = if (dist <= criticalDistance) "urgent" else "caution"
      val dir = directionLabel(nearestCenterSector.centerDegrees)
      hazards.add(
        SpatialHazard(
          id = "arcore-corridor-obstacle",
          kind = "obstacle",
          severity = severity,
          direction = dir,
          bearingDegrees = nearestCenterSector.centerDegrees,
          distanceMeters = dist,
          confidence = nearestCenterSector.confidence,
          message = "Obstacle ${dir.replace("-", " ")}, ${formatMetres(dist)}."
        )
      )
    }

    return CorridorAnalysis(
      sectors = sectors,
      openings = openings,
      recommendedHeadingOffsetDeg = scoring.recommendedOffset,
      corridorState = scoring.corridorState,
      forwardClearanceMeters = scoring.forwardClearance,
      bestClearanceMeters = scoring.bestEffectiveClearance,
      aimState = aim,
      pitchDegrees = pitch,
      headingDegrees = headingDegrees,
      floorHeightMeters = knownFloorY?.toDouble(),
      maxClosingSpeedMps = 0.0,
      recedingObstacle = false,
      hazards = hazards,
      valid = true
    )
  }

  private data class CorridorScoring(
    val recommendedOffset: Double,
    val corridorState: String,
    val forwardClearance: Double,
    val bestEffectiveClearance: Double
  )

  private fun scoreCorridor(sectors: List<CorridorSector>): CorridorScoring {
    var bestIndex = 3
    var bestScore = -1.0
    var bestEffectiveClearance = 0.0
    for (i in 0 until 7) {
      val leftClear = if (i > 0) sectors[i - 1].clearanceMeters else sectors[i].clearanceMeters
      val rightClear = if (i < 6) sectors[i + 1].clearanceMeters else sectors[i].clearanceMeters
      val selfClear = sectors[i].clearanceMeters
      // Effective passable clearance requires room for body width (blend center with tighter neighbor).
      val effective = min(selfClear, selfClear * 0.65 + min(leftClear, rightClear) * 0.35)
      val centerBias = 1.0 - abs(SECTOR_CENTERS[i]) / 180.0 * 0.18
      val score = effective * centerBias
      if (score > bestScore) {
        bestScore = score
        bestIndex = i
        bestEffectiveClearance = effective
      }
    }

    val forwardClearance = min(
      sectors[3].clearanceMeters,
      min(sectors[2].clearanceMeters, sectors[4].clearanceMeters) + 0.35
    )
    val centerBundleMax = max(
      sectors[1].clearanceMeters,
      max(
        sectors[2].clearanceMeters,
        max(
          sectors[3].clearanceMeters,
          max(sectors[4].clearanceMeters, sectors[5].clearanceMeters)
        )
      )
    )

    val corridorState = when {
      forwardClearance >= 2.2 -> "clear"
      centerBundleMax < 1.2 || bestEffectiveClearance < 1.15 -> "blocked"
      else -> "narrow"
    }

    val recommendedOffset = if (forwardClearance >= 2.4) 0.0 else SECTOR_CENTERS[bestIndex]
    return CorridorScoring(
      recommendedOffset = recommendedOffset,
      corridorState = corridorState,
      forwardClearance = forwardClearance,
      bestEffectiveClearance = bestEffectiveClearance
    )
  }

  private fun invalidAnalysis(
    aimState: String,
    pitchDegrees: Double,
    headingDegrees: Double?,
    knownFloorY: Float?
  ): CorridorAnalysis = CorridorAnalysis(
    sectors = emptySectors(),
    openings = emptyList(),
    recommendedHeadingOffsetDeg = 0.0,
    corridorState = "unknown",
    forwardClearanceMeters = 0.0,
    bestClearanceMeters = 0.0,
    aimState = aimState,
    pitchDegrees = pitchDegrees,
    headingDegrees = headingDegrees,
    floorHeightMeters = knownFloorY?.toDouble(),
    maxClosingSpeedMps = 0.0,
    recedingObstacle = false,
    hazards = emptyList(),
    valid = false
  )

  private fun emptySectors(): List<CorridorSector> = (0 until 7).map { i ->
    CorridorSector(
      index = i,
      centerDegrees = SECTOR_CENTERS[i],
      label = SECTOR_LABELS[i],
      clearanceMeters = 0.0,
      sampleCount = 0,
      confidence = 0.0
    )
  }

  fun formatMetres(metres: Double): String {
    if (metres < 1.0) return "less than a metre"
    return String.format(Locale.US, "%.1f metres", metres)
  }
}
