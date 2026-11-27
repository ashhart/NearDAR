package expo.modules.tensorfoldperception

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.Image
import android.media.ImageReader
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.PowerManager
import androidx.core.content.ContextCompat
import com.google.android.gms.tasks.Tasks
import com.google.ar.core.ArCoreApk
import com.google.ar.core.Config
import com.google.ar.core.Frame
import com.google.ar.core.Plane
import com.google.ar.core.PointCloud
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.CameraNotAvailableException
import com.google.ar.core.exceptions.NotYetAvailableException
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.util.UUID
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.roundToInt

class ArcorePerceptionController(
  private val context: Context,
  private val activityProvider: () -> Activity?,
  val emit: (String, Map<String, Any?>) -> Unit
) {
  private val thread = HandlerThread("TensorFoldPerception").apply { start() }
  private val handler = Handler(thread.looper)
  private val mainHandler = Handler(Looper.getMainLooper())
  private val analyzer = DepthAnalyzer()
  private val approachTracker = ApproachTracker()
  private val poseMatrix = FloatArray(16)
  private val rotationMatrix = FloatArray(9)
  private var session: Session? = null
  private var settings = SessionSettings.parse(null)
  private var active = false
  private var depthSupported = false
  private var depthSupportDetermined = false
  private var latestSnapshot: Map<String, Any?>? = null
  private var captureInProgress = false
  private var latestCaptureURI: String? = null
  private var lastCaptureAt: Double? = null
  private var recognizer: TextRecognizer? = null
  private var cameraDevice: CameraDevice? = null
  private var cameraCaptureSession: CameraCaptureSession? = null
  private var cameraReader: ImageReader? = null
  private var cameraId: String? = null
  private var latestCameraImage: Image? = null
  private var cameraOnlyMode = false
  private var cameraOnlyReason: String? = null
  private var cameraStartCompletion: ((Result<Map<String, Any?>>) -> Unit)? = null
  private var lastErrorAt = 0L
  private var detectedFloorY: Float? = null
  private var sensorManager: SensorManager? = null
  private var sensorHeadingDegrees: Double? = null
  private var sensorPitchDegrees: Double? = null
  private var latestLightAnalysis: LightAnalysis? = null
  private var lastLumaSampleMs = 0L
  private var torchActive = false

  private val sensorListener = object : SensorEventListener {
    override fun onSensorChanged(event: SensorEvent) {
      val values = event.values ?: return
      if (values.size < 3) return
      try {
        SensorManager.getRotationMatrixFromVector(rotationMatrix, values)
        // Back camera looks along device -Z -> column 2 negated in world ENU (East, North, Up)
        val east = -rotationMatrix[2].toDouble()
        val north = -rotationMatrix[5].toDouble()
        val up = -rotationMatrix[8].toDouble()
        val pitch = asin(up.coerceIn(-1.0, 1.0)) * 180.0 / Math.PI
        if (pitch.isFinite()) sensorPitchDegrees = pitch
        val horiz = hypot(east, north)
        if (horiz >= 0.25) {
          var degrees = atan2(east, north) * 180.0 / Math.PI
          if (degrees < 0.0) degrees += 360.0
          if (degrees.isFinite()) sensorHeadingDegrees = degrees
        }
      } catch (_: Exception) {
        // Ignore malformed sensor frames
      }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
  }

  fun capabilities(): Map<String, Any?> {
    val availability = ArCoreApk.getInstance().checkAvailability(context)
    val permission = cameraPermission()
    val supported = availability.isSupported
    val cameraAvailable = findCameraId() != null
    val captureAvailable = supported || cameraAvailable
    if (!supported) {
      depthSupported = false
      depthSupportDetermined = true
    } else if (!depthSupportDetermined && permission == "granted") {
      queryDepthSupport()
    }
    val limitations = mutableListOf<String>()
    if (!supported) {
      limitations.add("ARCore is unavailable on this device: ${availability.name}. ${if (cameraAvailable) "Camera-only capture and OCR remain available" else "Camera capture is also unavailable"}; depth and obstacle warnings are unavailable.")
    }
    if (permission != "granted") limitations.add("Camera permission is required for camera capture and ARCore depth.")
    if (supported && depthSupportDetermined && !depthSupported) limitations.add("This ARCore device does not support raw depth. Camera capture and OCR remain available.")
    if (cameraOnlyMode && active) limitations.add(cameraOnlyReason ?: "Camera-only mode is active; depth and obstacle warnings are unavailable.")
    limitations.add("Named chair and person geometry is unavailable in this adapter.")
    limitations.add("The bundled on-device OCR model recognizes Latin script.")
    return mapOf(
      "available" to captureAvailable, "depth" to depthSupported, "detector" to false,
      "reason" to limitations.firstOrNull(),
      "platform" to "android", "arSupported" to supported, "arAvailability" to availability.name,
      "cameraPermission" to permission, "depthSupported" to depthSupported,
      "depthSupportDetermined" to depthSupportDetermined, "rawDepth" to depthSupported,
      "meshClassification" to false, "personDetection" to false, "freeSeatCandidates" to false,
      "ocr" to captureAvailable, "ocrMode" to "onDeviceBundled", "captureFormat" to (if (captureAvailable) "jpeg-file" else "unavailable"),
      "limitations" to limitations
    )
  }

  private fun queryDepthSupport() {
    if (session != null) return
    var probe: Session? = null
    try {
      probe = Session(context)
      depthSupported = probe.isDepthModeSupported(Config.DepthMode.AUTOMATIC)
      depthSupportDetermined = true
    } catch (_: Exception) {
      depthSupportDetermined = false
    } finally {
      probe?.close()
    }
  }

  fun start(options: Map<String, Any?>?, completion: (Result<Map<String, Any?>>) -> Unit) {
    val parsedSettings = try { SessionSettings.parse(options) } catch (error: Exception) {
      completion(Result.failure(error)); return
    }
    if (activityProvider() == null) {
      completion(Result.failure(PerceptionException("E_ACTIVITY", "An Android activity is required to start camera perception."))); return
    }
    val availability = ArCoreApk.getInstance().checkAvailability(context)
    handler.post {
      stopInternal()
      settings = parsedSettings
      if (availability != ArCoreApk.Availability.SUPPORTED_INSTALLED) {
        startCameraOnly("ARCore is unavailable on this device (${availability.name}); using camera-only mode.", completion)
        return@post
      }
      var created: Session? = null
      try {
        created = Session(context)
        val config = created.config
        depthSupported = created.isDepthModeSupported(Config.DepthMode.AUTOMATIC)
        depthSupportDetermined = true
        config.depthMode = if (depthSupported) Config.DepthMode.AUTOMATIC else Config.DepthMode.DISABLED
        config.focusMode = Config.FocusMode.AUTO
        config.updateMode = Config.UpdateMode.LATEST_CAMERA_IMAGE
        config.planeFindingMode = Config.PlaneFindingMode.HORIZONTAL_AND_VERTICAL
        created.configure(config)
        created.resume()
        session = created
        active = true
        latestSnapshot = null
        detectedFloorY = null
        latestLightAnalysis = null
        lastLumaSampleMs = 0L
        approachTracker.reset()
        startOrientationSensor()
        val result = mutableMapOf<String, Any?>("active" to true, "capabilities" to capabilities())
        settings.stepLength?.let { result["stepLengthMeters"] = it }
        completion(Result.success(result))
        scheduleTick()
      } catch (error: Exception) {
        try { created?.close() } catch (_: Exception) {}
        session = null
        active = false
        startCameraOnly("ARCore could not start (${error.message ?: error.javaClass.simpleName}); camera-only depth and obstacle warnings are unavailable.", completion)
      }
    }
  }

  fun stop(completion: (Map<String, Any?>) -> Unit) {
    handler.post {
      stopInternal()
      completion(mapOf("active" to false))
    }
  }

  fun shutdown() {
    handler.post {
      stopInternal()
      recognizer?.close()
      recognizer = null
      thread.quitSafely()
    }
  }

  fun setTorch(enabled: Boolean, level: Double, completion: (Map<String, Any?>) -> Unit) {
    val clamped = if (level.isFinite()) level.coerceIn(0.05, 1.0) else 0.6
    handler.post {
      val activeState = setTorchInternal(enabled, clamped)
      completion(mapOf("active" to activeState))
    }
  }

  private fun stopInternal() {
    handler.removeCallbacksAndMessages(null)
    if (torchActive) setTorchInternal(false, 0.0)
    torchActive = false
    stopOrientationSensor()
    approachTracker.reset()
    detectedFloorY = null
    latestLightAnalysis = null
    lastLumaSampleMs = 0L
    active = false
    latestSnapshot = null
    captureInProgress = false
    latestCaptureURI = null
    lastCaptureAt = null
    SceneImage.pruneCaptures(context)
    try { session?.close() } catch (_: Exception) {}
    session = null
    cameraStartCompletion?.invoke(Result.failure(PerceptionException("E_SESSION_INACTIVE", "Camera startup was cancelled.")))
    cameraStartCompletion = null
    closeCameraOnly()
  }

  private fun scheduleTick(thermalState: String = currentThermalState()) {
    handler.removeCallbacks(tick)
    if (active) handler.postDelayed(tick, effectiveProximityIntervalMs(thermalState))
  }

  private fun startOrientationSensor() {
    stopOrientationSensor()
    try {
      val mgr = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return
      val sensor = mgr.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
        ?: mgr.getDefaultSensor(Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR)
        ?: return
      sensorManager = mgr
      mgr.registerListener(sensorListener, sensor, SensorManager.SENSOR_DELAY_UI, handler)
    } catch (_: Exception) {
      sensorManager = null
    }
  }

  private fun stopOrientationSensor() {
    try {
      sensorManager?.unregisterListener(sensorListener)
    } catch (_: Exception) {}
    sensorManager = null
    sensorHeadingDegrees = null
    sensorPitchDegrees = null
  }

  private fun currentThermalState(): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "nominal"
    val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return "nominal"
    return when (powerManager.currentThermalStatus) {
      PowerManager.THERMAL_STATUS_NONE -> "nominal"
      PowerManager.THERMAL_STATUS_LIGHT, PowerManager.THERMAL_STATUS_MODERATE -> "fair"
      PowerManager.THERMAL_STATUS_SEVERE -> "serious"
      PowerManager.THERMAL_STATUS_CRITICAL,
      PowerManager.THERMAL_STATUS_EMERGENCY,
      PowerManager.THERMAL_STATUS_SHUTDOWN -> "critical"
      else -> "nominal"
    }
  }

  private fun effectiveProximityIntervalMs(thermalState: String): Long {
    val thermalFloor = when (thermalState) {
      "critical" -> 380L
      "serious" -> 280L
      "fair" -> 180L
      else -> 120L
    }
    return max(settings.proximityIntervalMs, thermalFloor)
  }

  private fun updateDetectedFloorY(currentSession: Session, camY: Float) {
    try {
      val planes = currentSession.getAllTrackables(Plane::class.java)
      var lowestFloorY: Float? = null
      for (plane in planes) {
        if (plane.trackingState != TrackingState.TRACKING) continue
        if (plane.type != Plane.Type.HORIZONTAL_UPWARD_FACING) continue
        val y = plane.centerPose.ty()
        if (y < camY - 0.65f && (lowestFloorY == null || y < lowestFloorY)) {
          lowestFloorY = y
        }
      }
      if (lowestFloorY != null) {
        detectedFloorY = lowestFloorY
      }
    } catch (_: Exception) {
      // Fall back to default camera height above floor when plane query is unavailable.
    }
  }

  private fun setTorchInternal(enabled: Boolean, level: Double): Boolean {
    val manager = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager ?: run {
      torchActive = false
      return false
    }
    if (cameraOnlyMode) {
      val device = cameraDevice
      val captureSession = cameraCaptureSession
      val reader = cameraReader
      val id = cameraId
      if (device != null && captureSession != null && reader != null && id != null) {
        return try {
          val flashAvailable = manager.getCameraCharacteristics(id)
            .get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
          if (!flashAvailable) {
            torchActive = false
            return false
          }
          val request = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
            addTarget(reader.surface)
            set(
              CaptureRequest.FLASH_MODE,
              if (enabled) CaptureRequest.FLASH_MODE_TORCH else CaptureRequest.FLASH_MODE_OFF
            )
          }.build()
          captureSession.setRepeatingRequest(request, null, handler)
          torchActive = enabled
          torchActive
        } catch (_: Exception) {
          torchActive = false
          false
        }
      }
    }

    val id = try { session?.cameraConfig?.cameraId } catch (_: Exception) { null } ?: findCameraId()
    if (id == null) {
      torchActive = false
      return false
    }
    return try {
      val characteristics = manager.getCameraCharacteristics(id)
      val flashAvailable = characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
      if (!flashAvailable) {
        torchActive = false
        return false
      }
      if (enabled && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        val maxStrength = characteristics.get(CameraCharacteristics.FLASH_INFO_STRENGTH_MAXIMUM_LEVEL) ?: 1
        if (maxStrength > 1) {
          val strength = (level.coerceIn(0.05, 1.0) * maxStrength).roundToInt().coerceIn(1, maxStrength)
          manager.turnOnTorchWithStrengthLevel(id, strength)
        } else {
          manager.setTorchMode(id, true)
        }
      } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        manager.setTorchMode(id, enabled)
      } else {
        torchActive = false
        return false
      }
      torchActive = enabled
      torchActive
    } catch (_: Exception) {
      torchActive = false
      false
    }
  }

  private val tick = object : Runnable {
    override fun run() {
      if (!active) return
      try { process(null) }
      catch (error: CameraNotAvailableException) {
        reportThrottled("E_CAMERA_UNAVAILABLE", "The ARCore camera is temporarily unavailable.", true)
        reportUnavailableStatus("The ARCore camera is temporarily unavailable.")
      }
      catch (error: Exception) {
        val message = if (cameraOnlyMode) "Camera frame processing failed" else "ARCore frame processing failed"
        reportThrottled(if (cameraOnlyMode) "E_CAMERA_FRAME" else "E_AR_FRAME", "$message: ${error.message ?: error.javaClass.simpleName}", true)
        reportUnavailableStatus(if (cameraOnlyMode) "No fresh camera frame is available." else "No fresh ARCore frame is available.")
      }
      finally { scheduleTick() }
    }
  }

  fun capture(options: Map<String, Any?>?, completion: (Result<Map<String, Any?>>) -> Unit) {
    handler.post {
      if (!active) {
        completion(Result.failure(PerceptionException("E_SESSION_INACTIVE", "Start a perception session before capturing a scene.")))
        return@post
      }
      captureInProgress = true
      var completed = false
      try {
        val snapshot = process(options ?: emptyMap())
        val image = snapshot["image"] as? Map<String, Any?>
        latestCaptureURI = image?.get("uri") as? String
        lastCaptureAt = (snapshot["cameraTimestampMs"] as? Number)?.toDouble()
        if (image == null) SceneImage.pruneCaptures(context)
        completed = true
        completion(Result.success(snapshot))
      } catch (error: NotYetAvailableException) {
        completion(Result.failure(PerceptionException("E_NO_FRAME", "The camera image is not available yet. Try the capture again.")))
      } catch (error: PerceptionException) {
        report(error.code, error.message ?: "Capture failed.", true)
        completion(Result.failure(error))
      } catch (error: Exception) {
        val wrapped = PerceptionException("E_CAPTURE", "Scene capture failed: ${error.message ?: error.javaClass.simpleName}")
        report(wrapped.code, wrapped.message ?: "Capture failed.", true)
        completion(Result.failure(wrapped))
      } finally {
        captureInProgress = false
        if (!completed) {
          latestCaptureURI = null
          lastCaptureAt = null
          SceneImage.pruneCaptures(context)
        }
      }
    }
  }

  fun getStatus(completion: (Map<String, Any?>) -> Unit) {
    handler.post {
      val nativeDepth = latestSnapshot?.get("depthState") as? String ?: "unavailable"
      val depthState = when (nativeDepth) {
        "available" -> "ready"
        "stale" -> "stale"
        "misaligned" -> "limited"
        else -> "unavailable"
      }
      val imageAvailable = !captureInProgress && latestCaptureURI?.let { uri ->
        try { java.io.File(java.net.URI(uri)).exists() } catch (_: Exception) { false }
      } == true
      val result = mutableMapOf<String, Any?>(
        "state" to (if (active) (if (nativeDepth == "available") "active" else "degraded") else "idle"),
        "active" to active, "capturing" to captureInProgress,
        "trackingReady" to (latestSnapshot?.get("trackingState") == "normal" && nativeDepth != "stale"),
        "depthState" to depthState, "imageAvailable" to imageAvailable
      )
      (latestSnapshot?.get("cameraTimestampMs") as? Number)?.toDouble()?.let { result["observedAt"] = it }
      lastCaptureAt?.let { result["lastCaptureAt"] = it }
      val message = latestSnapshot?.let { PerceptionContract.statusMessage(status(it)) }
      if (message != null) result["message"] = message
      else if (!active) result["message"] = "Perception session is not active."
      completion(result)
    }
  }

  fun release(uri: String, completion: (Map<String, Any?>) -> Unit) {
    handler.post {
      val released = SceneImage.releaseCapture(context, uri)
      if (released && latestCaptureURI == uri) latestCaptureURI = null
      completion(mapOf("released" to released))
    }
  }

  private fun process(captureOptions: Map<String, Any?>?): Map<String, Any?> {
    if (cameraOnlyMode) return processCameraOnly(captureOptions)
    val current = session ?: throw PerceptionException("E_SESSION_INACTIVE", "The perception session is not active.")
    val frame = current.update()
    val camera = frame.camera
    val cameraTimestamp = DepthAnalyzer.timestamp(frame.androidCameraTimestamp)
    var depthImage: Image? = null
    var confidenceImage: Image? = null
    var cameraImage: Image? = null
    try {
      if (depthSupported && camera.trackingState == TrackingState.TRACKING) {
        try {
          depthImage = frame.acquireRawDepthImage16Bits()
          confidenceImage = frame.acquireRawDepthConfidenceImage()
        } catch (_: NotYetAvailableException) {
          depthImage?.close(); depthImage = null
          confidenceImage?.close(); confidenceImage = null
        }
      }
      val depthTimestamp = depthImage?.timestamp?.let { DepthAnalyzer.timestamp(it) }
      val alignmentDelta = depthTimestamp?.let { abs(cameraTimestamp - it) }
      val measuredAge = System.currentTimeMillis() - cameraTimestamp
      val age = max(0.0, measuredAge)
      val measuredDepthAge = depthTimestamp?.let { System.currentTimeMillis() - it }
      val depthAge = measuredDepthAge?.let { max(0.0, it) }
      val analysis = if (depthImage != null) analyzer.analyze(depthImage!!, confidenceImage, camera, settings) else null
      val stale = measuredAge > settings.maximumFrameAgeMs || measuredAge < -100 || (measuredDepthAge != null && (measuredDepthAge > settings.maximumFrameAgeMs || measuredDepthAge < -100))
      val timestampMisaligned = alignmentDelta != null && alignmentDelta > settings.maximumAlignmentAgeMs
      val aspectMisaligned = analysis != null && !analysis.aligned
      val healthIssues = mutableListOf<String>()
      val depthState = when {
        !depthSupported -> "unsupported".also { healthIssues.add("ARCore raw depth is unsupported on this device.") }
        depthImage == null -> "unavailable".also { healthIssues.add("No raw-depth frame is available. Tracking, lighting, or camera motion may be insufficient.") }
        timestampMisaligned || aspectMisaligned -> "misaligned".also {
          healthIssues.add(if (timestampMisaligned) "Camera and depth timestamps exceed the alignment window." else "Camera and depth image aspect ratios do not align.")
        }
        stale -> "stale".also { healthIssues.add("Camera or depth data is outside the freshness window.") }
        analysis?.valid == true -> "available"
        else -> "unavailable".also { healthIssues.add("Raw-depth confidence is too low for proximity measurements.") }
      }
      if (camera.trackingState != TrackingState.TRACKING) healthIssues.add("ARCore camera tracking is not active.")
      val sensorHealth = mutableMapOf<String, Any?>(
        "cameraAuthorized" to (cameraPermission() == "granted"), "depthSupported" to depthSupported,
        "cameraTimestampMs" to cameraTimestamp, "depthTimestampMs" to depthTimestamp,
        "cameraDepthDeltaMs" to alignmentDelta, "frameAgeMs" to age, "depthAgeMs" to depthAge,
        "alignment" to when {
          depthImage == null -> "unavailable"
          timestampMisaligned -> "timestamp-mismatch"
          aspectMisaligned -> "aspect-mismatch"
          else -> "aligned"
        },
        "fresh" to (depthState == "available" && !stale), "issues" to healthIssues
      )
      val freshGeometry = depthState == "available" && camera.trackingState == TrackingState.TRACKING
      val trackingReady = camera.trackingState == TrackingState.TRACKING
      if (captureOptions != null && age > settings.maximumFrameAgeMs) {
        throw PerceptionException("E_STALE_FRAME", "The latest camera frame is stale. Wait for fresh tracking before capturing.")
      }
      val nowMs = System.currentTimeMillis()
      var image: Map<String, Any>? = null
      var ocr: List<Map<String, Any>> = emptyList()
      if (captureOptions != null) {
        val acquired = frame.acquireCameraImage()
        cameraImage = acquired
        LightAnalyzer.analyze(acquired)?.let {
          latestLightAnalysis = it
          lastLumaSampleMs = nowMs
        }
        val activity = activityProvider() ?: throw PerceptionException("E_ACTIVITY", "The Android activity is unavailable.")
        val rotation = SceneImage.rotationDegrees(activity, current.cameraConfig.cameraId)
        val recognizeText = captureOptions["recognizeText"] as? Boolean ?: settings.recognizeText
        if (recognizeText) {
          ocr = recognize(acquired, frame, rotation, if (depthState == "available") depthImage else null, confidenceImage)
        }
        val includeImage = captureOptions["includeImage"] as? Boolean ?: true
        if (includeImage) {
          val quality = (captureOptions["jpegQuality"] as? Number)?.toDouble() ?: 0.85
          val maxImageLongEdge = (captureOptions["maxImageLongEdge"] as? Number)?.toInt()
          image = SceneImage.writeJPEG(activity, acquired, rotation, (quality * 100).toInt(), cameraTimestamp, maxImageLongEdge)
        }
      } else if (nowMs - lastLumaSampleMs >= 500L || latestLightAnalysis == null) {
        try {
          val acquired = frame.acquireCameraImage()
          cameraImage = acquired
          LightAnalyzer.analyze(acquired)?.let {
            latestLightAnalysis = it
            lastLumaSampleMs = nowMs
          }
        } catch (_: Exception) {
          // Camera image may not be ready on early ARCore ticks; retain last luma reading.
        }
      }

      camera.pose.toMatrix(poseMatrix, 0)
      if (trackingReady) {
        updateDetectedFloorY(current, poseMatrix[13])
      }
      val pitchDegrees = if (trackingReady) {
        CorridorAnalyzer.cameraPitchDegrees(poseMatrix)
      } else {
        sensorPitchDegrees ?: CorridorAnalyzer.cameraPitchDegrees(poseMatrix)
      }
      val headingDegrees = sensorHeadingDegrees
      var aimState = CorridorAnalyzer.aimState(pitchDegrees = pitchDegrees, mountMode = settings.mountMode)
      var corridorDict: Map<String, Any>? = null
      var hazardsList: List<Map<String, Any>> = emptyList()
      var depthSource = "unavailable"
      val timestampSec = frame.timestamp / 1_000_000_000.0
      val dImg = depthImage
      val cImg = confidenceImage

      if (freshGeometry && dImg != null && cImg != null) {
        val rawCorridor = CorridorAnalyzer.analyze(
          depthImage = dImg,
          confidenceImage = cImg,
          intrinsics = camera.imageIntrinsics,
          poseMatrix = poseMatrix,
          headingDegrees = headingDegrees,
          knownFloorY = detectedFloorY,
          mountMode = settings.mountMode,
          warningDistance = settings.warningDistance,
          criticalDistance = settings.criticalDistance
        )
        val approach = approachTracker.update(
          timestampSec = timestampSec,
          poseMatrix = poseMatrix,
          sectors = rawCorridor.sectors,
          aimState = rawCorridor.aimState
        )
        val corridor = rawCorridor.applying(approach)
        aimState = corridor.aimState
        corridorDict = corridor.toMap()
        hazardsList = corridor.hazardMaps(cameraTimestamp)
        depthSource = if (corridor.valid) "lidar" else "unavailable"
      } else if (!stale && trackingReady && depthImage == null && aimState != "lowered") {
        approachTracker.reset()
        var pointCloud: PointCloud? = null
        try {
          pointCloud = frame.acquirePointCloud()
          val fallbackCorridor = CorridorAnalyzer.analyzePointCloud(
            points = pointCloud.points,
            poseMatrix = poseMatrix,
            headingDegrees = headingDegrees,
            knownFloorY = detectedFloorY,
            mountMode = settings.mountMode,
            warningDistance = settings.warningDistance,
            criticalDistance = settings.criticalDistance
          )
          if (fallbackCorridor.valid) {
            aimState = fallbackCorridor.aimState
            corridorDict = fallbackCorridor.toMap()
            hazardsList = fallbackCorridor.hazardMaps(cameraTimestamp)
            depthSource = "feature-points"
          }
        } catch (_: Exception) {
          // Point cloud may be temporarily unavailable during relocalization.
        } finally {
          try { pointCloud?.release() } catch (_: Exception) {}
        }
      } else {
        approachTracker.reset()
      }

      val thermalState = currentThermalState()
      val proactiveVlmAllowed = thermalState == "nominal" || thermalState == "fair"

      val snapshot = mutableMapOf<String, Any?>(
        "id" to UUID.randomUUID().toString(), "source" to "arcore",
        "mode" to (if (captureOptions == null) "proximity" else "capture"),
        "cameraTimestampMs" to cameraTimestamp, "depthTimestampMs" to depthTimestamp,
        "capturedAtMs" to System.currentTimeMillis().toDouble(), "trackingState" to tracking(camera.trackingState),
        "trackingReason" to trackingReason(camera.trackingState), "depthState" to depthState,
        "depthSource" to depthSource, "thermalState" to thermalState,
        "proactiveVlmAllowed" to proactiveVlmAllowed,
        "confidence" to (if (freshGeometry) analysis?.confidence ?: 0.0 else 0.0),
        "sensorHealth" to sensorHealth, "obstacles" to (if (freshGeometry) analysis?.obstacles ?: emptyList() else emptyList()),
        "objects" to emptyList<Map<String, Any>>(), "freeSeats" to emptyList<Map<String, Any>>(), "ocr" to ocr,
        "aimState" to aimState, "pitchDegrees" to pitchDegrees, "hazards" to hazardsList
      )
      latestLightAnalysis?.let {
        snapshot["lightingState"] = it.lightingState
        snapshot["ambientLuma"] = it.ambientLuma
      }
      headingDegrees?.let { snapshot["headingDegrees"] = it }
      corridorDict?.let { snapshot["corridor"] = it }
      image?.let { snapshot["image"] = it }
      latestSnapshot = snapshot
      emit("onSnapshot", snapshot)
      if (captureOptions == null) {
        emit("onStatus", status(snapshot))
        if (depthSource != "unavailable" && trackingReady && aimState != "lowered" && aimState != "covered") {
          emitWarnings(snapshot)
        }
      }
      return snapshot
    } finally {
      cameraImage?.close()
      confidenceImage?.close()
      depthImage?.close()
    }
  }

  @SuppressLint("MissingPermission")
  private fun startCameraOnly(reason: String, completion: (Result<Map<String, Any?>>) -> Unit) {
    if (cameraPermission() != "granted") {
      completion(Result.failure(PerceptionException("E_CAMERA_PERMISSION", "Camera access is required for camera-only perception.")))
      return
    }
    val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    val id = findCameraId()
    if (id == null) {
      completion(Result.failure(PerceptionException("E_CAMERA_UNAVAILABLE", "ARCore is unavailable and no camera was found for camera-only perception.")))
      return
    }
    var reader: ImageReader? = null
    try {
      val characteristics = manager.getCameraCharacteristics(id)
      val sizes = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        ?.getOutputSizes(ImageFormat.YUV_420_888)
        ?.filter { it.width > 0 && it.height > 0 }
        ?: emptyList()
      if (sizes.isEmpty()) throw PerceptionException("E_CAMERA_UNAVAILABLE", "The camera does not support YUV image capture.")
      val size = sizes.filter { it.width.toLong() * it.height <= 1920L * 1080L }
        .maxByOrNull { it.width.toLong() * it.height }
        ?: sizes.minByOrNull { it.width.toLong() * it.height }!!
      val openedReader = ImageReader.newInstance(size.width, size.height, ImageFormat.YUV_420_888, 3)
      reader = openedReader
      cameraReader = openedReader
      cameraId = id
      cameraOnlyMode = true
      cameraStartCompletion = completion
      cameraOnlyReason = reason
      depthSupported = false
      depthSupportDetermined = true
      latestSnapshot = null
      openedReader.setOnImageAvailableListener({
        val image = openedReader.acquireLatestImage() ?: return@setOnImageAvailableListener
        if (cameraReader !== openedReader) {
          image.close()
          return@setOnImageAvailableListener
        }
        latestCameraImage?.close()
        latestCameraImage = image
      }, handler)
      manager.openCamera(id, object : CameraDevice.StateCallback() {
        override fun onOpened(device: CameraDevice) {
          if (cameraReader !== openedReader) {
            device.close()
            return
          }
          cameraDevice = device
          try {
            device.createCaptureSession(listOf(openedReader.surface), object : CameraCaptureSession.StateCallback() {
              override fun onConfigured(captureSession: CameraCaptureSession) {
                if (cameraReader !== openedReader) {
                  captureSession.close()
                  return
                }
                cameraCaptureSession = captureSession
                try {
                  val request = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                    addTarget(openedReader.surface)
                    if (torchActive) {
                      set(CaptureRequest.FLASH_MODE, CaptureRequest.FLASH_MODE_TORCH)
                    }
                  }.build()
                  captureSession.setRepeatingRequest(request, null, handler)
                  active = true
                  latestSnapshot = null
                  latestLightAnalysis = null
                  lastLumaSampleMs = 0L
                  startOrientationSensor()
                  val result = mutableMapOf<String, Any?>("active" to true, "capabilities" to capabilities())
                  settings.stepLength?.let { result["stepLengthMeters"] = it }
                  cameraStartCompletion = null
                  completion(Result.success(result))
                  scheduleTick()
                } catch (error: Exception) {
                  cameraFailed(openedReader, "Camera capture could not start: ${error.message ?: error.javaClass.simpleName}", completion)
                }
              }

              override fun onConfigureFailed(captureSession: CameraCaptureSession) {
                captureSession.close()
                cameraFailed(openedReader, "The camera capture session could not be configured.", completion)
              }
            }, handler)
          } catch (error: Exception) {
            cameraFailed(openedReader, "Camera capture could not start: ${error.message ?: error.javaClass.simpleName}", completion)
          }
        }

        override fun onDisconnected(device: CameraDevice) {
          if (cameraReader !== openedReader) {
            device.close()
            return
          }
          cameraFailed(openedReader, "The camera was disconnected.", completion)
        }

        override fun onError(device: CameraDevice, error: Int) {
          if (cameraReader !== openedReader) {
            device.close()
            return
          }
          cameraFailed(openedReader, "The camera reported error $error.", completion)
        }
      }, handler)
    } catch (error: Exception) {
      reader?.close()
      if (cameraReader === reader) closeCameraOnly()
      val wrapped = error as? PerceptionException
        ?: PerceptionException("E_CAMERA_UNAVAILABLE", "Camera-only perception could not start: ${error.message ?: error.javaClass.simpleName}")
      completion(Result.failure(wrapped))
    }
  }

  private fun cameraFailed(reader: ImageReader, message: String, completion: (Result<Map<String, Any?>>) -> Unit) {
    if (cameraReader !== reader) return
    val wasActive = active
    if (wasActive) reportThrottled("E_CAMERA_UNAVAILABLE", message, true)
    closeCameraOnly()
    active = false
    latestSnapshot = null
    if (wasActive) reportUnavailableStatus(message)
    else completion(Result.failure(PerceptionException("E_CAMERA_UNAVAILABLE", message)))
  }

  private fun closeCameraOnly() {
    latestCameraImage?.close()
    latestCameraImage = null
    try { cameraCaptureSession?.close() } catch (_: Exception) {}
    cameraCaptureSession = null
    try { cameraDevice?.close() } catch (_: Exception) {}
    cameraDevice = null
    try { cameraReader?.close() } catch (_: Exception) {}
    cameraReader = null
    cameraId = null
    cameraOnlyMode = false
    cameraOnlyReason = null
    cameraStartCompletion = null
  }

  private fun findCameraId(): String? {
    return try {
      val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
      val ids = manager.cameraIdList
      ids.firstOrNull { id ->
        manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
      } ?: ids.firstOrNull()
    } catch (_: Exception) {
      null
    }
  }

  private fun processCameraOnly(captureOptions: Map<String, Any?>?): Map<String, Any?> {
    val cameraImage = latestCameraImage
    val now = System.currentTimeMillis()
    val cameraTimestamp = cameraImage?.timestamp?.let { DepthAnalyzer.timestamp(it) }
    val age = cameraTimestamp?.let { max(0.0, now.toDouble() - it) }
    val stale = cameraTimestamp == null || now - cameraTimestamp > settings.maximumFrameAgeMs || now - cameraTimestamp < -100
    if (captureOptions != null && cameraImage == null) {
      throw PerceptionException("E_NO_FRAME", "The camera image is not available yet. Try the capture again.")
    }
    if (captureOptions != null && stale) {
      throw PerceptionException("E_STALE_FRAME", "The latest camera frame is stale. Wait for a fresh frame before capturing.")
    }
    val issues = mutableListOf(
      cameraOnlyReason ?: "ARCore is unavailable; using camera-only mode.",
      "Camera-only mode has no sensor depth. Obstacle distances, meshes, safe-path claims, and proximity warnings are unavailable."
    )
    if (stale) issues.add("No fresh camera frame is available.")
    val sensorHealth = mapOf<String, Any?>(
      "cameraAuthorized" to (cameraPermission() == "granted"), "depthSupported" to false,
      "cameraTimestampMs" to cameraTimestamp, "depthTimestampMs" to null,
      "cameraDepthDeltaMs" to null, "frameAgeMs" to age, "depthAgeMs" to null,
      "alignment" to "unavailable", "fresh" to !stale, "issues" to issues
    )
    val trackingState = if (stale) "paused" else "normal"
    val trackingReason = if (stale) "No fresh camera frame is available." else null
    if (cameraImage != null) {
      LightAnalyzer.analyze(cameraImage)?.let {
        latestLightAnalysis = it
        lastLumaSampleMs = now
      }
    }
    var image: Map<String, Any>? = null
    var ocr: List<Map<String, Any>> = emptyList()
    if (captureOptions != null && cameraImage != null) {
      val activity = activityProvider() ?: throw PerceptionException("E_ACTIVITY", "The Android activity is unavailable.")
      val rotation = SceneImage.rotationDegrees(activity, cameraId ?: throw PerceptionException("E_CAMERA_UNAVAILABLE", "The camera is unavailable."))
      val recognizeText = captureOptions["recognizeText"] as? Boolean ?: settings.recognizeText
      if (recognizeText) ocr = recognizeCameraOnly(cameraImage, rotation)
      val includeImage = captureOptions["includeImage"] as? Boolean ?: true
      if (includeImage) {
        val quality = (captureOptions["jpegQuality"] as? Number)?.toDouble() ?: 0.85
        val maxImageLongEdge = (captureOptions["maxImageLongEdge"] as? Number)?.toInt()
        image = SceneImage.writeJPEG(activity, cameraImage, rotation, (quality * 100).toInt(), cameraTimestamp!!, maxImageLongEdge)
      }
    }
    val pitchDegrees = sensorPitchDegrees ?: 0.0
    val aimState = CorridorAnalyzer.aimState(pitchDegrees = pitchDegrees, mountMode = settings.mountMode)
    val thermalState = currentThermalState()
    val proactiveVlmAllowed = thermalState == "nominal" || thermalState == "fair"
    val snapshot = mutableMapOf<String, Any?>(
      "id" to UUID.randomUUID().toString(), "source" to "camera2",
      "mode" to (if (captureOptions == null) "proximity" else "capture"),
      "cameraTimestampMs" to cameraTimestamp, "depthTimestampMs" to null,
      "capturedAtMs" to now.toDouble(), "trackingState" to trackingState,
      "trackingReason" to trackingReason, "depthState" to "unsupported",
      "depthSource" to "unavailable", "thermalState" to thermalState,
      "proactiveVlmAllowed" to proactiveVlmAllowed,
      "confidence" to 0.0, "sensorHealth" to sensorHealth,
      "obstacles" to emptyList<Map<String, Any>>(), "objects" to emptyList<Map<String, Any>>(),
      "freeSeats" to emptyList<Map<String, Any>>(), "ocr" to ocr,
      "aimState" to aimState, "pitchDegrees" to pitchDegrees, "hazards" to emptyList<Map<String, Any>>()
    )
    latestLightAnalysis?.let {
      snapshot["lightingState"] = it.lightingState
      snapshot["ambientLuma"] = it.ambientLuma
    }
    sensorHeadingDegrees?.let { snapshot["headingDegrees"] = it }
    image?.let { snapshot["image"] = it }
    latestSnapshot = snapshot
    emit("onSnapshot", snapshot)
    if (captureOptions == null) emit("onStatus", status(snapshot))
    return snapshot
  }

  private fun recognizeCameraOnly(image: Image, rotation: Int): List<Map<String, Any>> {
    val client = recognizer ?: TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS).also { recognizer = it }
    val result = Tasks.await(client.process(InputImage.fromMediaImage(image, rotation)))
    val output = mutableListOf<Map<String, Any>>()
    for (block in result.textBlocks) {
      for (line in block.lines) {
        val rect = line.boundingBox ?: continue
        val bounds = SceneImage.uprightBounds(rect, image.width, image.height, rotation)
        output.add(mapOf(
          "text" to line.text, "confidence" to (line.confidence?.toDouble() ?: 0.0),
          "bounds" to bounds, "direction" to cameraOnlyDirection(bounds)
        ))
      }
    }
    return output
  }

  private fun cameraOnlyDirection(bounds: Map<String, Double>): Map<String, Any> {
    val x = bounds.getValue("x") + bounds.getValue("width") / 2
    val y = bounds.getValue("y") + bounds.getValue("height") / 2
    val horizontal = if (x < 1.0 / 3) "left" else if (x > 2.0 / 3) "right" else null
    val vertical = if (y < 1.0 / 3) "upper" else if (y > 2.0 / 3) "lower" else null
    val bearing = listOfNotNull(vertical, horizontal).joinToString("-").ifEmpty { "ahead" }
    val clock = when (horizontal) { "left" -> 9; "right" -> 3; else -> 12 }
    return mapOf("bearing" to bearing, "clockSector" to clock)
  }

  private fun recognize(
    image: Image,
    frame: Frame,
    rotation: Int,
    depthImage: Image?,
    confidenceImage: Image?
  ): List<Map<String, Any>> {
    val client = recognizer ?: TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS).also { recognizer = it }
    val input = InputImage.fromMediaImage(image, rotation)
    val result = Tasks.await(client.process(input))
    val output = mutableListOf<Map<String, Any>>()
    for (block in result.textBlocks) {
      for (line in block.lines) {
        val rect = line.boundingBox ?: continue
        val bounds = SceneImage.sensorBounds(rect, image.width, image.height, rotation)
        val measurement = if (depthImage != null) analyzer.measure(depthImage, confidenceImage, bounds, frame.camera.imageIntrinsics) else null
        val item = mutableMapOf<String, Any>(
          "text" to line.text, "confidence" to (line.confidence?.toDouble() ?: 0.0),
          "bounds" to bounds, "direction" to cameraOnlyDirection(SceneImage.uprightBounds(rect, image.width, image.height, rotation))
        )
        measurement?.distance?.let { item["distanceMeters"] = it }
        output.add(item)
      }
    }
    return output
  }

  @Suppress("UNCHECKED_CAST")
  private fun emitWarnings(snapshot: Map<String, Any?>) {
    val nowMs = (snapshot["cameraTimestampMs"] as? Number)?.toDouble() ?: System.currentTimeMillis().toDouble()
    val hazards = (snapshot["hazards"] as? List<Map<String, Any?>>) ?: emptyList()

    // Priority 1: Fast-approaching hazard (cyclist, runner, scooter, loose dog)
    val fastMover = hazards.firstOrNull { (it["kind"] as? String) == "fast-mover" }
    if (fastMover != null) {
      val payload = mutableMapOf<String, Any?>(
        "id" to (fastMover["id"] as? String ?: "arcore-fast-mover"),
        "kind" to "fast-mover",
        "timestampMs" to nowMs,
        "severity" to "critical",
        "direction" to mapOf(
          "bearing" to (fastMover["direction"] as? String ?: "ahead"),
          "yawDegrees" to ((fastMover["bearingDegrees"] as? Number)?.toDouble() ?: 0.0)
        ),
        "distanceMeters" to ((fastMover["distanceMeters"] as? Number)?.toDouble() ?: 0.0),
        "message" to (fastMover["message"] as? String ?: "Fast movement ahead — hold still.")
      )
      (fastMover["closingSpeedMps"] as? Number)?.toDouble()?.let { payload["closingSpeedMps"] = it }
      (fastMover["externalSpeedMps"] as? Number)?.toDouble()?.let { payload["externalSpeedMps"] = it }
      (fastMover["ttcSeconds"] as? Number)?.toDouble()?.let { payload["ttcSeconds"] = it }
      emit("onWarning", payload)
      return
    }

    // Priority 2: Vertical hazards (head-height overhang, drop-off, step-down, step-up)
    val verticalHazard = hazards.firstOrNull {
      val kind = it["kind"] as? String ?: ""
      kind == "head-height" || kind == "drop-off" || kind == "step-down" || kind == "step-up"
    }
    if (verticalHazard != null) {
      val kind = verticalHazard["kind"] as? String ?: "obstacle"
      emit(
        "onWarning",
        mapOf(
          "id" to (verticalHazard["id"] as? String ?: "arcore-vertical-hazard"),
          "kind" to kind,
          "timestampMs" to nowMs,
          "severity" to (if (verticalHazard["severity"] == "urgent") "critical" else "warning"),
          "direction" to mapOf(
            "bearing" to (verticalHazard["direction"] as? String ?: "ahead"),
            "yawDegrees" to ((verticalHazard["bearingDegrees"] as? Number)?.toDouble() ?: 0.0)
          ),
          "distanceMeters" to ((verticalHazard["distanceMeters"] as? Number)?.toDouble() ?: 0.0),
          "message" to (verticalHazard["message"] as? String ?: "Hazard ahead.")
        )
      )
      return
    }

    // Priority 3: Nearest static obstacle within warningDistance (suppressed if receding unless critical)
    val corridor = snapshot["corridor"] as? Map<String, Any?>
    val receding = corridor?.get("recedingObstacle") as? Boolean ?: false
    val obstacles = ((snapshot["obstacles"] as? List<Map<String, Any?>>) ?: emptyList())
      .filter { ((it["nearestDistanceMeters"] as? Number)?.toDouble() ?: Double.POSITIVE_INFINITY) <= settings.warningDistance }
    val nearestObstacle = obstacles.minByOrNull {
      (it["nearestDistanceMeters"] as? Number)?.toDouble() ?: Double.POSITIVE_INFINITY
    }
    if (nearestObstacle != null) {
      val distance = (nearestObstacle["nearestDistanceMeters"] as? Number)?.toDouble() ?: return
      if (!receding || distance <= settings.criticalDistance) {
        emit(
          "onWarning",
          mapOf(
            "id" to "arcore-live-obstacle",
            "kind" to "obstacle",
            "timestampMs" to nowMs,
            "snapshotId" to snapshot["id"],
            "severity" to (if (distance <= settings.criticalDistance) "critical" else "warning"),
            "sector" to nearestObstacle["sector"],
            "direction" to nearestObstacle["direction"],
            "distanceMeters" to distance,
            "robustDistanceMeters" to (nearestObstacle["robustDistanceMeters"] ?: distance),
            "confidence" to nearestObstacle["meanConfidence"],
            "obstacle" to nearestObstacle
          )
        )
      }
      return
    }

    // Priority 4: Feature-point fallback corridor obstacle when dense raw depth is unavailable
    val fallbackObstacle = hazards.firstOrNull { (it["kind"] as? String) == "obstacle" }
    if (fallbackObstacle != null) {
      val distance = (fallbackObstacle["distanceMeters"] as? Number)?.toDouble() ?: return
      if (distance <= settings.warningDistance && (!receding || distance <= settings.criticalDistance)) {
        emit(
          "onWarning",
          mapOf(
            "id" to (fallbackObstacle["id"] as? String ?: "arcore-corridor-obstacle"),
            "kind" to "obstacle",
            "timestampMs" to nowMs,
            "severity" to (if (distance <= settings.criticalDistance) "critical" else "warning"),
            "direction" to mapOf(
              "bearing" to (fallbackObstacle["direction"] as? String ?: "ahead"),
              "yawDegrees" to ((fallbackObstacle["bearingDegrees"] as? Number)?.toDouble() ?: 0.0)
            ),
            "distanceMeters" to distance,
            "message" to (fallbackObstacle["message"] as? String ?: "Obstacle ahead.")
          )
        )
      }
    }
  }

  private fun status(snapshot: Map<String, Any?>): Map<String, Any?> = mapOf(
    "timestampMs" to System.currentTimeMillis().toDouble(), "active" to active,
    "trackingState" to snapshot["trackingState"], "trackingReason" to snapshot["trackingReason"],
    "depthState" to snapshot["depthState"], "sensorHealth" to snapshot["sensorHealth"]
  )

  private fun tracking(state: TrackingState): String = when (state) {
    TrackingState.TRACKING -> "normal"
    TrackingState.PAUSED -> "paused"
    TrackingState.STOPPED -> "stopped"
  }

  private fun trackingReason(state: TrackingState): String? = when (state) {
    TrackingState.TRACKING -> null
    TrackingState.PAUSED -> "ARCore camera tracking is paused."
    TrackingState.STOPPED -> "ARCore camera tracking has stopped."
  }

  private fun cameraPermission(): String = when (ContextCompat.checkSelfPermission(context, android.Manifest.permission.CAMERA)) {
    PackageManager.PERMISSION_GRANTED -> "granted"
    else -> if (ContextCompat.checkSelfPermission(context, android.Manifest.permission.CAMERA) == PackageManager.PERMISSION_DENIED) "denied" else "unknown"
  }

  private fun reportUnavailableStatus(message: String) {
    val previous = latestSnapshot?.get("sensorHealth") as? Map<String, Any?> ?: emptyMap()
    val issues = (previous["issues"] as? List<String> ?: emptyList()) + message
    val health = previous.toMutableMap()
    health["fresh"] = false
    health["issues"] = issues
    emit("onStatus", mapOf(
      "timestampMs" to System.currentTimeMillis().toDouble(), "active" to active,
      "trackingState" to "paused", "trackingReason" to message,
      "depthState" to (if (depthSupported) "unavailable" else "unsupported"), "sensorHealth" to health
    ))
  }

  private fun reportThrottled(code: String, message: String, recoverable: Boolean) {
    val now = System.currentTimeMillis()
    if (now - lastErrorAt > 5000) { lastErrorAt = now; report(code, message, recoverable) }
  }

  private fun report(code: String, message: String, recoverable: Boolean) {
    emit("onError", mapOf(
      "timestampMs" to System.currentTimeMillis().toDouble(), "code" to code,
      "message" to message, "recoverable" to recoverable
    ))
  }
}
