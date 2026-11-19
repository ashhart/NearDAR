package expo.modules.tensorfoldvoice

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.Locale

class ListeningOptions : Record {
  @Field
  val locale: String? = null

  @Field
  val silenceTimeoutMs: Int? = null

  @Field
  val preferBluetoothMicrophone: Boolean = true
}

class SpeakOptions : Record {
  @Field
  val utteranceId: String? = null

  @Field
  val locale: String? = null

  @Field
  val voiceIdentifier: String? = null

  @Field
  val priority: String? = null

  @Field
  val interrupt: Boolean = false

  @Field
  val speakerFallback: Boolean = true

  @Field
  val rate: Double? = null

  @Field
  val pitch: Double? = null

  @Field
  val volume: Double? = null
}

class VoiceException(code: String, message: String, cause: Throwable? = null) :
  CodedException(code, message, cause) {
  internal var eventEmitted = false
}

fun requireLocale(tag: String?): Locale {
  val value = tag?.trim()?.takeIf { it.isNotEmpty() } ?: Locale.getDefault().toLanguageTag()
  val locale = Locale.forLanguageTag(value)
  if (locale.language.isEmpty() || locale.language == "und") {
    throw VoiceException("ERR_INVALID_LOCALE", "Locale '$value' is not a valid BCP 47 language tag.")
  }
  return locale
}

fun normalizedTag(locale: Locale): String = locale.toLanguageTag()

fun sameLanguage(requested: Locale, candidate: String): Boolean {
  val other = Locale.forLanguageTag(candidate)
  if (requested.language != other.language) return false
  if (requested.country.isNotEmpty() && other.country.isNotEmpty() && requested.country != other.country) {
    return false
  }
  return true
}

class VoiceEvents(private val sender: (String, Map<String, Any?>) -> Unit) {
  var enabled = true

  private fun emit(type: String, fields: Map<String, Any?> = emptyMap()) {
    if (!enabled) return
    val payload = LinkedHashMap<String, Any?>()
    payload["type"] = type
    payload["timestamp"] = System.currentTimeMillis()
    fields.forEach { (key, value) ->
      if (value != null) payload[key] = value
    }
    sender("onVoiceEvent", payload)
  }

  fun listeningStarted(sessionId: String) {
    emit("listeningStarted", mapOf("sessionId" to sessionId))
  }

  fun listeningStopped(sessionId: String, message: String? = null) {
    emit("listeningStopped", mapOf("sessionId" to sessionId, "message" to message))
  }

  fun recognition(
    sessionId: String,
    phase: String,
    text: String,
    alternatives: List<String>,
    confidence: Double?,
    locale: String
  ) {
    emit(
      phase,
      mapOf(
        "sessionId" to sessionId,
        "text" to text,
        "alternatives" to alternatives,
        "confidence" to confidence,
        "locale" to locale
      )
    )
  }

  fun speechStarted(utteranceId: String, priority: String) {
    emit("speechStarted", mapOf("utteranceId" to utteranceId, "priority" to priority))
  }

  fun speechFinished(utteranceId: String, priority: String) {
    emit("speechFinished", mapOf("utteranceId" to utteranceId, "priority" to priority))
  }

  fun speechStopped(utteranceId: String, priority: String, message: String? = null) {
    emit("speechStopped", mapOf("utteranceId" to utteranceId, "priority" to priority, "message" to message))
  }

  fun routeChanged(route: String, message: String? = null) {
    emit("routeChanged", mapOf("route" to route, "message" to message))
  }

  fun error(
    operation: String,
    error: VoiceException,
    sessionId: String? = null,
    utteranceId: String? = null
  ) {
    if (error.eventEmitted) return
    error.eventEmitted = true
    if (enabled) {
      emit(
        "error",
        mapOf(
          "operation" to operation,
          "code" to error.code,
          "message" to (error.message ?: error.code),
          "sessionId" to sessionId,
          "utteranceId" to utteranceId
        )
      )
    }
  }
}
