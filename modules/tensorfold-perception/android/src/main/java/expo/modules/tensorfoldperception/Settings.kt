package expo.modules.tensorfoldperception

class PerceptionException(val code: String, message: String) : Exception(message)

data class SessionSettings(
  val stepLength: Double?,
  val warningDistance: Double,
  val criticalDistance: Double,
  val maximumFrameAgeMs: Double,
  val maximumAlignmentAgeMs: Double,
  val proximityIntervalMs: Long,
  val detectPeople: Boolean,
  val recognizeText: Boolean,
  val ocrLanguages: List<String>,
  val mountMode: String = "handheld"
) {
  companion object {
    fun parse(values: Map<String, Any?>?): SessionSettings {
      fun number(key: String): Double? = (values?.get(key) as? Number)?.toDouble()
      val step = number("stepLengthMeters")
      if (step != null && (step < 0.3 || step > 1.5)) {
        throw PerceptionException("E_OPTIONS", "stepLengthMeters must be between 0.3 and 1.5.")
      }
      val warning = number("warningDistanceMeters") ?: 2.5
      val critical = number("criticalDistanceMeters") ?: 0.9
      val frameAge = number("maximumFrameAgeMs") ?: 500.0
      val alignmentAge = number("maximumAlignmentAgeMs") ?: 80.0
      val interval = number("proximityIntervalMs")?.toLong() ?: 120L
      val mountMode = (values?.get("mountMode") as? String) ?: "handheld"
      if (mountMode != "handheld" && mountMode != "lanyard") {
        throw PerceptionException("E_OPTIONS", "mountMode must be 'handheld' or 'lanyard'.")
      }
      if (warning <= critical || critical <= 0 || frameAge < 100 || alignmentAge < 0 || interval < 100) {
        throw PerceptionException("E_OPTIONS", "Invalid distance, freshness, or proximity interval settings.")
      }
      @Suppress("UNCHECKED_CAST")
      val languages = (values?.get("ocrLanguages") as? List<String>) ?: emptyList()
      return SessionSettings(
        step, warning, critical, frameAge, alignmentAge, interval,
        values?.get("detectPeople") as? Boolean ?: true,
        values?.get("recognizeText") as? Boolean ?: true,
        languages,
        mountMode
      )
    }
  }
}

fun steps(distance: Double, settings: SessionSettings): Map<String, Any>? {
  val length = settings.stepLength ?: return null
  return mapOf("calibrated" to true, "stepLengthMeters" to length, "count" to distance / length)
}
