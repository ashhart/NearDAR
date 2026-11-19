package expo.modules.tensorfoldperception

import android.content.Context
import android.app.Activity
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.Image
import android.net.Uri
import android.view.Surface
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import kotlin.math.max
import kotlin.math.min

object SceneImage {
  fun captureDirectory(context: Context): File = File(context.cacheDir, "TensorFoldPerception")

  fun rotationDegrees(activity: Activity, cameraId: String): Int {
    val manager = activity.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    val characteristics = manager.getCameraCharacteristics(cameraId)
    val sensorOrientation = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION)
      ?: throw IllegalStateException("Camera $cameraId does not report its sensor orientation.")
    val displayRotation = activity.windowManager.defaultDisplay.rotation
    val deviceRotation = when (displayRotation) {
      Surface.ROTATION_90 -> 90
      Surface.ROTATION_180 -> 180
      Surface.ROTATION_270 -> 270
      else -> 0
    }
    return if (characteristics.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_FRONT) {
      (sensorOrientation + deviceRotation) % 360
    } else {
      (sensorOrientation - deviceRotation + 360) % 360
    }
  }

  fun sensorBounds(rect: Rect, imageWidth: Int, imageHeight: Int, rotation: Int): Map<String, Double> {
    val rotated = rotation == 90 || rotation == 270
    val outputWidth = if (rotated) imageHeight else imageWidth
    val outputHeight = if (rotated) imageWidth else imageHeight
    val x = rect.left.toDouble() / outputWidth
    val y = rect.top.toDouble() / outputHeight
    val width = rect.width().toDouble() / outputWidth
    val height = rect.height().toDouble() / outputHeight
    return when (rotation) {
      90 -> linkedMapOf("x" to y, "y" to 1 - x - width, "width" to height, "height" to width)
      270 -> linkedMapOf("x" to 1 - y - height, "y" to x, "width" to height, "height" to width)
      180 -> linkedMapOf("x" to 1 - x - width, "y" to 1 - y - height, "width" to width, "height" to height)
      else -> linkedMapOf("x" to x, "y" to y, "width" to width, "height" to height)
    }.mapValues { (_, value) -> max(0.0, min(1.0, value)) }
  }

  fun writeJPEG(
    activity: Activity,
    image: Image,
    rotation: Int,
    quality: Int,
    cameraTimestampMs: Double
  ): Map<String, Any> {
    require(image.format == android.graphics.ImageFormat.YUV_420_888) { "The camera did not provide a YUV_420_888 image." }
    val bytes = toNv21(image)
    val output = java.io.ByteArrayOutputStream(bytes.size)
    val yuv = YuvImage(bytes, android.graphics.ImageFormat.NV21, image.width, image.height, null)
    if (!yuv.compressToJpeg(Rect(0, 0, image.width, image.height), quality.coerceIn(10, 100), output)) {
      throw PerceptionException("E_CAPTURE", "The camera image could not be encoded as JPEG.")
    }
    val directory = captureDirectory(activity)
    if (!directory.exists() && !directory.mkdirs()) {
      throw PerceptionException("E_CAPTURE", "The temporary perception directory could not be created.")
    }
    val oriented = orientJPEG(output.toByteArray(), rotation, quality.coerceIn(10, 100))
    val file = File(directory, "${UUID.randomUUID()}.jpg")
    FileOutputStream(file).use { it.write(oriented.first) }
    pruneCaptures(activity, file)
    return mapOf(
      "uri" to Uri.fromFile(file).toString(), "width" to oriented.second, "height" to oriented.third,
      "rotationDegrees" to 0, "mimeType" to "image/jpeg", "cameraTimestampMs" to cameraTimestampMs
    )
  }

  fun releaseCapture(context: Context, uri: String): Boolean {
    val parsed = Uri.parse(uri)
    if (parsed.scheme != "file") return false
    val target = File(parsed.path ?: return false)
    val base = captureDirectory(context).canonicalFile
    val canonical = target.canonicalFile
    if (!canonical.path.startsWith(base.path + File.separator) || canonical.extension != "jpg") return false
    return canonical.delete()
  }
  fun pruneCaptures(context: Context, keeping: File? = null) {
    captureDirectory(context).listFiles()?.forEach { file ->
      if (file.extension == "jpg" && file != keeping) file.delete()
    }
  }

  private fun orientJPEG(encoded: ByteArray, rotation: Int, quality: Int): Triple<ByteArray, Int, Int> {
    if (rotation == 0) {
      val source = BitmapFactory.decodeByteArray(encoded, 0, encoded.size)
        ?: throw PerceptionException("E_CAPTURE", "The encoded camera image could not be decoded.")
      val result = Triple(encoded, source.width, source.height)
      source.recycle()
      return result
    }
    val source = BitmapFactory.decodeByteArray(encoded, 0, encoded.size)
      ?: throw PerceptionException("E_CAPTURE", "The encoded camera image could not be decoded.")
    try {
      val matrix = Matrix().apply { postRotate(rotation.toFloat()) }
      val rotated = android.graphics.Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
      try {
        val result = java.io.ByteArrayOutputStream(encoded.size)
        if (!rotated.compress(android.graphics.Bitmap.CompressFormat.JPEG, quality, result)) {
          throw PerceptionException("E_CAPTURE", "The upright camera image could not be encoded.")
        }
        return Triple(result.toByteArray(), rotated.width, rotated.height)
      } finally {
        if (rotated !== source) rotated.recycle()
      }
    } finally {
      source.recycle()
    }
  }


  private fun toNv21(image: Image): ByteArray {
    val width = image.width
    val height = image.height
    val result = ByteArray(width * height * 3 / 2)
    val yPlane = image.planes[0]
    val uPlane = image.planes[1]
    val vPlane = image.planes[2]
    val yBuffer = yPlane.buffer
    val uBuffer = uPlane.buffer
    val vBuffer = vPlane.buffer
    var output = 0
    for (row in 0 until height) {
      for (column in 0 until width) {
        result[output++] = yBuffer.get(row * yPlane.rowStride + column * yPlane.pixelStride)
      }
    }
    val chromaHeight = (height + 1) / 2
    val chromaWidth = (width + 1) / 2
    for (row in 0 until chromaHeight) {
      for (column in 0 until chromaWidth) {
        val vIndex = row * vPlane.rowStride + column * vPlane.pixelStride
        val uIndex = row * uPlane.rowStride + column * uPlane.pixelStride
        if (output + 1 < result.size && vIndex < vBuffer.limit() && uIndex < uBuffer.limit()) {
          result[output++] = vBuffer.get(vIndex)
          result[output++] = uBuffer.get(uIndex)
        }
      }
    }
    return result
  }
}
