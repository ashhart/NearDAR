package expo.modules.tensorfoldperception

import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

object PerceptionContract {
  private val sequence = AtomicLong(0)

  fun snapshot(native: Map<String, Any?>): Map<String, Any?> {
    val snapshotId = native["id"] as? String ?: UUID.randomUUID().toString()
    val nativeDepth = native["depthState"] as? String ?: "unavailable"
    val depthState = when (nativeDepth) {
      "available" -> "ready"
      "stale" -> "stale"
      "misaligned" -> "limited"
      else -> "unavailable"
    }
    val obstacles = mapList(native["obstacles"])
    val nativeObjects = mapList(native["objects"])
    val objects = mutableListOf<Map<String, Any?>>()
    for (obstacle in obstacles) {
      val sector = obstacle["sector"] as? String ?: "unknown"
      val confidence = number(obstacle["meanConfidence"]) ?: 0.0
      val validFraction = number(obstacle["validPixelFraction"]) ?: 0.0
      objects.add(sceneObject(
        id = "$snapshotId-$sector", label = "obstacle", confidence = confidence,
        direction = direction(asMap(obstacle["direction"])), clock = clock(asMap(obstacle["direction"])),
        distance = number(obstacle["robustDistanceMeters"]) ?: number(obstacle["nearestDistanceMeters"]),
        steps = stepCount(obstacle),
        evidence = listOf("Measured raw-depth sector $sector with ${(validFraction * 100).roundToInt()} percent valid pixels.")
      ))
    }
    for (nativeObject in nativeObjects) {
      val id = nativeObject["id"] as? String ?: continue
      val label = nativeObject["label"] as? String ?: continue
      val source = nativeObject["source"] as? String ?: "native-detector"
      objects.add(sceneObject(
        id = id, label = label, confidence = number(nativeObject["confidence"]) ?: 0.0,
        direction = direction(asMap(nativeObject["direction"])), clock = clock(asMap(nativeObject["direction"])),
        distance = number(nativeObject["distanceMeters"]), steps = stepCount(nativeObject),
        evidence = listOf("Geometry supplied by $source, with timestamped confidence ${number(nativeObject["confidence"]) ?: 0.0}.")
      ))
    }
    val freeSeats = mutableListOf<Map<String, Any?>>()
    val seatObjects = nativeObjects.filter { it["id"] is String }.associateBy { it["id"] as String }
    for (candidate in mapList(native["freeSeats"])) {
      if (candidate["occupancy"] != "free") continue
      val id = candidate["objectId"] as? String ?: continue
      val seat = seatObjects[id]
      val evidence = mapList(candidate["evidence"]).mapNotNull { it["detail"] as? String }
      val geometryConfidence = number(candidate["confidence"]) ?: 0.0
      val seatObject = sceneObject(
        id = candidate["id"] as? String ?: "candidate-$id", label = "seat", confidence = geometryConfidence,
        direction = direction(asMap(candidate["direction"])), clock = clock(asMap(candidate["direction"])),
        distance = number(candidate["distanceMeters"]), steps = seat?.let { stepCount(it) }, evidence = evidence
      ).toMutableMap()
      seatObject["free"] = true
      // No-person-overlap is conservative evidence, not a guarantee that a chair is empty.
      seatObject["occupancyConfidence"] = min(0.5, geometryConfidence)
      seatObject["occupied"] = false
      freeSeats.add(seatObject)
    }
    val health = asMap(native["sensorHealth"]) ?: emptyMap()
    val notes = (health["issues"] as? List<*>)?.filterIsInstance<String>()?.toMutableList() ?: mutableListOf()
    (native["trackingReason"] as? String)?.let { notes.add(it) }
    if (native["source"] == "arcore") {
      notes.add("Named chair and person detection is unavailable in this ARCore adapter. Generic depth obstacles and captured image evidence remain available.")
    }
    val textObservations = mapList(native["ocr"]).mapNotNull { observation ->
      val text = (observation["text"] as? String)?.takeIf(String::isNotEmpty) ?: return@mapNotNull null
      mapOf("text" to text, "direction" to direction(asMap(observation["direction"])))
    }
    val validDepthFraction = obstacles.sumOf { number(it["validPixelFraction"]) ?: 0.0 } / 15
    val trackingReady = native["trackingState"] == "normal" && nativeDepth != "stale"
    val result = mutableMapOf<String, Any?>(
      "observedAt" to (number(native["cameraTimestampMs"]) ?: number(native["capturedAtMs"]) ?: System.currentTimeMillis().toDouble()),
      "sequence" to sequence.incrementAndGet(), "trackingReady" to trackingReady, "depthState" to depthState,
      "validDepthFraction" to validDepthFraction, "cameraOrientation" to "camera-forward",
      "objects" to objects, "freeSeats" to freeSeats, "recognizedText" to textObservations.mapNotNull { it["text"] },
      "textObservations" to textObservations, "notes" to notes
    )
    val image = asMap(native["image"])
    (image?.get("uri") as? String)?.let { result["temporaryImagePath"] = it }
    image?.get("width")?.let { result["imageWidth"] = it }
    image?.get("height")?.let { result["imageHeight"] = it }
    asMap(native["corridor"])?.let { result["corridor"] = it }
    if (native["hazards"] is List<*>) {
      result["hazards"] = mapList(native["hazards"])
    }
    number(native["headingDegrees"])?.let { result["headingDegrees"] = it }
    (native["aimState"] as? String)?.let { result["aimState"] = it }
    number(native["pitchDegrees"])?.let { result["pitchDegrees"] = it }
    (native["depthSource"] as? String)?.let { result["depthSource"] = it }
    (native["thermalState"] as? String)?.let { result["thermalState"] = it }
    (native["proactiveVlmAllowed"] as? Boolean)?.let { result["proactiveVlmAllowed"] = it }
    (native["lightingState"] as? String)?.let { result["lightingState"] = it }
    number(native["ambientLuma"])?.let { result["ambientLuma"] = it }
    return result
  }

  fun warning(native: Map<String, Any?>): Map<String, Any?> {
    val obstacle = asMap(native["obstacle"]) ?: emptyMap()
    val heading = direction(asMap(native["direction"]))
    val distance = number(native["distanceMeters"])
    val kind = native["kind"] as? String ?: "obstacle"
    val calibratedSteps = stepCount(obstacle)
    val measurement = when {
      calibratedSteps != null -> "about ${calibratedSteps.roundToInt()} calibrated steps"
      distance != null -> "about ${String.format(Locale.US, "%.1f", max(0.1, distance))} metres"
      else -> "distance unavailable"
    }
    val label = native["label"] as? String
    val name = label?.replaceFirstChar { if (it.isLowerCase()) it.titlecase(Locale.US) else it.toString() } ?: "Obstacle"
    val defaultMessage = "$name ${heading.replace('-', ' ')}, $measurement."
    val severityRaw = native["severity"] as? String
    val severity = if (severityRaw == "critical" || severityRaw == "urgent") "urgent" else "caution"
    val id = native["id"] as? String
      ?: "${native["snapshotId"] as? String ?: UUID.randomUUID().toString()}-${native["sector"] as? String ?: "obstacle"}"
    val result = mutableMapOf<String, Any?>(
      "id" to id,
      "kind" to kind,
      "severity" to severity,
      "message" to (native["message"] as? String ?: defaultMessage),
      "observedAt" to (number(native["timestampMs"]) ?: System.currentTimeMillis().toDouble()),
      "direction" to heading
    )
    distance?.let { result["distanceMeters"] = it }
    label?.let { result["label"] = it }
    number(native["closingSpeedMps"])?.let { result["closingSpeedMps"] = it }
    number(native["externalSpeedMps"])?.let { result["externalSpeedMps"] = it }
    number(native["ttcSeconds"])?.let { result["ttcSeconds"] = it }
    return result
  }

  fun statusMessage(status: Map<String, Any?>): String? {
    (status["trackingReason"] as? String)?.let { return it }
    val health = asMap(status["sensorHealth"]) ?: emptyMap()
    val issues = (health["issues"] as? List<*>)?.filterIsInstance<String>() ?: emptyList()
    return issues.takeIf { it.isNotEmpty() }?.joinToString(" ")
  }

  private fun sceneObject(
    id: String,
    label: String,
    confidence: Double,
    direction: String,
    clock: Int,
    distance: Double?,
    steps: Double?,
    evidence: List<String>
  ): Map<String, Any?> {
    val result = mutableMapOf<String, Any?>(
      "id" to id, "label" to label, "confidence" to confidence, "direction" to direction,
      "clockSector" to clock, "evidence" to evidence
    )
    distance?.let { result["distanceMeters"] = it }
    steps?.let { result["stepEstimate"] = it }
    return result
  }

  private fun stepCount(native: Map<String, Any?>): Double? = number(asMap(native["steps"])?.get("count"))
  private fun clock(native: Map<String, Any?>?): Int = (native?.get("clockSector") as? Number)?.toInt() ?: 12

  private fun direction(native: Map<String, Any?>?): String {
    if (native == null) return "unknown"
    val yaw = number(native["yawDegrees"])
    if (yaw != null) {
      return when {
        yaw < -45 -> "left"
        yaw < -12 -> "ahead-left"
        yaw > 45 -> "right"
        yaw > 12 -> "ahead-right"
        else -> "ahead"
      }
    }
    return when (native["bearing"] as? String) {
      "left", "upper-left", "lower-left" -> "left"
      "right", "upper-right", "lower-right" -> "right"
      "ahead", "above", "below", "upper", "lower" -> "ahead"
      else -> "unknown"
    }
  }

  private fun number(value: Any?): Double? = (value as? Number)?.toDouble()

  @Suppress("UNCHECKED_CAST")
  private fun asMap(value: Any?): Map<String, Any?>? = value as? Map<String, Any?>

  @Suppress("UNCHECKED_CAST")
  private fun mapList(value: Any?): List<Map<String, Any?>> = (value as? List<Map<String, Any?>>) ?: emptyList()
}
