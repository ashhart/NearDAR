package expo.modules.tensorfoldperception

import android.media.Image
import com.google.ar.core.Camera
import com.google.ar.core.CameraIntrinsics
import java.util.Arrays
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

private const val COLUMNS = 5
private const val ROWS = 3
private const val CELLS = COLUMNS * ROWS

data class DepthAnalysis(
  val obstacles: List<Map<String, Any>>,
  val confidence: Double,
  val valid: Boolean,
  val aligned: Boolean
)

data class Measurement(val distance: Double, val direction: Map<String, Any>, val confidence: Double)

class DepthAnalyzer {
  private var samples = FloatArray(0)
  private var cellCapacity = 0

  fun analyze(depth: Image, confidence: Image?, camera: Camera, settings: SessionSettings): DepthAnalysis {
    val width = depth.width
    val height = depth.height
    val intrinsics = camera.imageIntrinsics
    val dimensions = intrinsics.imageDimensions
    val expectedAspect = dimensions[0].toDouble() / dimensions[1].toDouble()
    val actualAspect = width.toDouble() / height.toDouble()
    if (abs(expectedAspect - actualAspect) / expectedAspect >= 0.08 || confidence == null) {
      return DepthAnalysis(emptyList(), 0.0, false, expectedAspect == actualAspect || abs(expectedAspect - actualAspect) / expectedAspect < 0.08)
    }
    val depthPlane = depth.planes[0]
    val confidencePlane = confidence.planes[0]
    val depthBuffer = depthPlane.buffer
    val confidenceBuffer = confidencePlane.buffer
    val depthRow = depthPlane.rowStride
    val depthPixel = depthPlane.pixelStride
    val confidenceRow = confidencePlane.rowStride
    val confidencePixel = confidencePlane.pixelStride
    cellCapacity = ((width + COLUMNS - 1) / COLUMNS + 1) * ((height + ROWS - 1) / ROWS + 1)
    val needed = cellCapacity * CELLS
    if (samples.size < needed) samples = FloatArray(needed)
    val obstacles = mutableListOf<Map<String, Any>>()
    var totalValid = 0
    var totalSamples = 0
    var allConfidence = 0.0
    for (row in 0 until ROWS) {
      for (column in 0 until COLUMNS) {
        val cell = row * COLUMNS + column
        val offset = cell * cellCapacity
        val x0 = column * width / COLUMNS
        val x1 = (column + 1) * width / COLUMNS
        val y0 = row * height / ROWS
        val y1 = (row + 1) * height / ROWS
        var count = 0
        var confidenceSum = 0.0
        for (y in y0 until y1) {
          for (x in x0 until x1) {
            val index = y * depthRow + x * depthPixel
            val millimetres = (depthBuffer.get(index).toInt() and 0xff) or ((depthBuffer.get(index + 1).toInt() and 0xff) shl 8)
            val c = confidenceBuffer.get(y * confidenceRow + x * confidencePixel).toInt() and 0xff
            val meters = millimetres / 1000.0f
            if (millimetres == 0 || c < 128 || meters < 0.15f || meters > 20f || !meters.isFinite()) continue
            samples[offset + count] = meters
            count++
            confidenceSum += c / 255.0
            allConfidence += c / 255.0
          }
        }
        val cellPixels = (x1 - x0) * (y1 - y0)
        totalSamples += cellPixels
        totalValid += count
        if (count < max(3, cellPixels / 20)) continue
        Arrays.sort(samples, offset, offset + count)
        val nearest = samples[offset + max(0, ((count - 1) * 0.1).toInt())].toDouble()
        val median = samples[offset + count / 2].toDouble()
        val high = samples[offset + min(count - 1, ((count - 1) * 0.9).toInt())].toDouble()
        val bounds = mapOf(
          "x" to column.toDouble() / COLUMNS, "y" to row.toDouble() / ROWS,
          "width" to 1.0 / COLUMNS, "height" to 1.0 / ROWS
        )
        val nx = (column + 0.5) / COLUMNS
        val ny = (row + 0.5) / ROWS
        val point = pointAt(nx, ny, nearest, intrinsics)
        val obstacle = mutableMapOf<String, Any>(
          "sector" to sectorName(row, column), "nearestDistanceMeters" to nearest,
          "robustDistanceMeters" to median, "spreadMeters" to high - nearest,
          "validPixelFraction" to count.toDouble() / cellPixels,
          "meanConfidence" to confidenceSum / count,
          "nearestPoint" to mapOf("x" to point[0], "y" to point[1], "z" to point[2]),
          "bounds" to bounds, "direction" to direction(point[0], point[1], point[2])
        )
        steps(nearest, settings)?.let { obstacle["steps"] = it }
        obstacles.add(obstacle)
      }
    }
    val validFraction = if (totalSamples > 0) totalValid.toDouble() / totalSamples else 0.0
    val meanConfidence = if (totalValid > 0) allConfidence / totalValid else 0.0
    return DepthAnalysis(obstacles, validFraction * meanConfidence, totalValid >= 20, true)
  }

  fun measure(
    depth: Image,
    confidence: Image?,
    bounds: Map<String, Double>,
    intrinsics: CameraIntrinsics
  ): Measurement? {
    if (confidence == null) return null
    val width = depth.width
    val height = depth.height
    val x0 = max(0, min(width - 1, (bounds.getValue("x") * width).toInt()))
    val y0 = max(0, min(height - 1, (bounds.getValue("y") * height).toInt()))
    val x1 = max(x0 + 1, min(width, ((bounds.getValue("x") + bounds.getValue("width")) * width).toInt()))
    val y1 = max(y0 + 1, min(height, ((bounds.getValue("y") + bounds.getValue("height")) * height).toInt()))
    val countCapacity = (x1 - x0) * (y1 - y0)
    if (samples.size < countCapacity) samples = FloatArray(countCapacity)
    val values = samples
    val depthPlane = depth.planes[0]
    val confidencePlane = confidence.planes[0]
    val depthBuffer = depthPlane.buffer
    val confidenceBuffer = confidencePlane.buffer
    var count = 0
    var confidenceSum = 0.0
    for (y in y0 until y1) {
      for (x in x0 until x1) {
        val index = y * depthPlane.rowStride + x * depthPlane.pixelStride
        val millimetres = (depthBuffer.get(index).toInt() and 0xff) or ((depthBuffer.get(index + 1).toInt() and 0xff) shl 8)
        val c = confidenceBuffer.get(y * confidencePlane.rowStride + x * confidencePlane.pixelStride).toInt() and 0xff
        val meters = millimetres / 1000.0f
        if (millimetres == 0 || c < 128 || meters < 0.15f || meters > 20f || !meters.isFinite()) continue
        values[count++] = meters
        confidenceSum += c / 255.0
      }
    }
    if (count < 3) return null
    Arrays.sort(values, 0, count)
    val median = values[count / 2].toDouble()
    val nx = bounds.getValue("x") + bounds.getValue("width") / 2
    val ny = bounds.getValue("y") + bounds.getValue("height") / 2
    val point = pointAt(nx, ny, median, intrinsics)
    return Measurement(median, direction(point[0], point[1], point[2]), confidenceSum / count)
  }

  fun directionForBounds(bounds: Map<String, Double>, intrinsics: CameraIntrinsics): Map<String, Any> {
    val point = pointAt(
      bounds.getValue("x") + bounds.getValue("width") / 2,
      bounds.getValue("y") + bounds.getValue("height") / 2,
      1.0, intrinsics
    )
    return direction(point[0], point[1], point[2])
  }

  private fun pointAt(nx: Double, ny: Double, z: Double, intrinsics: CameraIntrinsics): DoubleArray {
    val dimensions = intrinsics.imageDimensions
    val focal = intrinsics.focalLength
    val principal = intrinsics.principalPoint
    val x = (nx * dimensions[0] - principal[0]) / focal[0] * z
    val y = (ny * dimensions[1] - principal[1]) / focal[1] * z
    return doubleArrayOf(x, y, z)
  }

  companion object {
    fun direction(x: Double, y: Double, z: Double): Map<String, Any> {
      val yaw = atan2(x, max(z, 0.0001)) * 180 / Math.PI
      val pitch = atan2(-y, max(z, 0.0001)) * 180 / Math.PI
      val bearing = when {
        yaw < -12 && pitch > 18 -> "upper-left"
        yaw > 12 && pitch > 18 -> "upper-right"
        yaw < -12 && pitch < -18 -> "lower-left"
        yaw > 12 && pitch < -18 -> "lower-right"
        yaw < -12 -> "left"
        yaw > 12 -> "right"
        pitch > 18 -> "above"
        pitch < -18 -> "below"
        else -> "ahead"
      }
      val reference = if (abs(yaw) >= 8) yaw else if (pitch >= 0) 0.0 else 180.0
      val normalized = (reference % 360 + 360) % 360
      val clock = (normalized / 30).roundToInt() % 12
      return mapOf(
        "bearing" to bearing, "clockSector" to if (clock == 0) 12 else clock,
        "yawDegrees" to yaw, "pitchDegrees" to pitch
      )
    }

    fun sectorName(row: Int, column: Int): String {
      val vertical = if (row == 0) "upper-" else if (row == 2) "lower-" else ""
      val horizontal = when (column) {
        0 -> "far-left"
        1 -> "left"
        2 -> "center"
        3 -> "right"
        else -> "far-right"
      }
      return vertical + horizontal
    }

    fun timestamp(timestampNanos: Long): Double {
      return System.currentTimeMillis() - (System.nanoTime() - timestampNanos) / 1_000_000.0
    }
  }
}
