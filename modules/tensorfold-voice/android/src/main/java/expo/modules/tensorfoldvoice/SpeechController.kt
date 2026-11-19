package expo.modules.tensorfoldvoice

import android.content.Context
import android.media.AudioAttributes
import android.os.Bundle
import android.os.Handler
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import java.util.UUID

class SpeechController(
  context: Context,
  private val routes: AudioRouteController,
  private val handler: Handler,
  private val events: VoiceEvents,
  private val interruptListening: () -> Unit
) {
  private enum class Priority(val wireValue: String, val rank: Int) {
    AMBIENT("ambient", 0),
    ANSWER("answer", 1),
    URGENT("urgent", 2);

    companion object {
      fun parse(value: String?): Priority = when (value) {
        null -> ANSWER
        "ambient" -> AMBIENT
        "answer" -> ANSWER
        "urgent" -> URGENT
        else -> throw VoiceException("ERR_INVALID_SPEECH_PRIORITY", "priority must be 'ambient', 'answer', or 'urgent'.")
      }
    }
  }

  private inner class Utterance(
    val publicId: String,
    val nativeId: String,
    val text: String,
    val priority: Priority,
    val speakerFallback: Boolean,
    val voice: Voice,
    val rate: Float,
    val pitch: Float,
    val volume: Float
  ) {
    var terminal = false
    var failure: VoiceException? = null
  }

  private lateinit var engine: TextToSpeech
  private var destroyed = false
  private var ready = false
  private var initializationError: VoiceException? = null
  private val pending = mutableListOf<Utterance>()
  private val activeByNativeId = mutableMapOf<String, Utterance>()
  private var current: Utterance? = null

  private val audioAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_ASSISTANT)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()

  init {
    try {
      engine = TextToSpeech(context) { status ->
        if (destroyed) return@TextToSpeech
        if (status == TextToSpeech.SUCCESS) {
          val attributesResult = engine.setAudioAttributes(audioAttributes)
          if (attributesResult == TextToSpeech.SUCCESS) {
            ready = true
          } else {
            failInitialization(ttsResultError(attributesResult, "Unable to set speech audio attributes"))
          }
        } else {
          failInitialization(VoiceException("ERR_TTS_INITIALIZATION_FAILED", "The Android text-to-speech engine failed to initialize with status $status."))
        }
      }
      engine.setOnUtteranceProgressListener(
        object : UtteranceProgressListener() {
          override fun onStart(utteranceId: String?) {
            utteranceId ?: return
            handler.post { handleStart(utteranceId) }
          }

          override fun onDone(utteranceId: String?) {
            utteranceId ?: return
            handler.post { handleDone(utteranceId) }
          }

          @Deprecated("Deprecated in Android")
          override fun onError(utteranceId: String?) {
            utteranceId ?: return
            handler.post { handleError(utteranceId, TextToSpeech.ERROR) }
          }

          override fun onError(utteranceId: String?, errorCode: Int) {
            utteranceId ?: return
            handler.post { handleError(utteranceId, errorCode) }
          }

          override fun onStop(utteranceId: String?, interrupted: Boolean) {
            utteranceId ?: return
            handler.post { handleStop(utteranceId, interrupted) }
          }
        }
      )
    } catch (error: Exception) {
      failInitialization(VoiceException("ERR_TTS_INITIALIZATION_FAILED", "Unable to initialize Android text-to-speech: ${error.message}", error))
    }
  }

  private fun failInitialization(error: VoiceException) {
    ready = false
    initializationError = error
    events.error("initializeTextToSpeech", error)
  }

  fun speak(text: String, options: SpeakOptions): Map<String, Any?> {
    if (destroyed) throw VoiceException("ERR_MODULE_DESTROYED", "The voice module has been destroyed.")
    if (!ready) {
      val error = initializationError
      if (error != null) throw VoiceException(error.code, error.message ?: error.code, error)
      throw VoiceException("ERR_TTS_NOT_READY", "The Android text-to-speech engine is still initializing.")
    }
    if (text.isBlank()) throw VoiceException("ERR_INVALID_SPEECH_TEXT", "Speech text must not be empty or blank.")
    val maximumLength = TextToSpeech.getMaxSpeechInputLength()
    if (text.length > maximumLength) {
      throw VoiceException("ERR_SPEECH_TEXT_TOO_LONG", "Speech text has ${text.length} characters; Android allows at most $maximumLength per utterance.")
    }

    val suppliedId = options.utteranceId
    if (suppliedId != null && suppliedId.isBlank()) {
      throw VoiceException("ERR_INVALID_UTTERANCE_ID", "utteranceId must not be blank.")
    }
    val publicId = suppliedId ?: UUID.randomUUID().toString()
    if (activeByNativeId.values.any { it.publicId == publicId }) {
      throw VoiceException("ERR_DUPLICATE_UTTERANCE_ID", "Utterance '$publicId' is already queued or speaking.")
    }

    val priority = Priority.parse(options.priority)
    val interrupt = options.interrupt
    val voice = selectVoice(options)
    val rate = boundedFloat(options.rate, "rate", 1f, minimum = 0.25, maximum = 2.0)
    val pitch = boundedFloat(options.pitch, "pitch", 1f, minimum = 0.5, maximum = 2.0)
    val volume = boundedFloat(options.volume, "volume", 1f, unitInterval = true)
    val utterance = Utterance(
      publicId,
      UUID.randomUUID().toString(),
      text,
      priority,
      options.speakerFallback,
      voice,
      rate,
      pitch,
      volume
    )

    interruptListening()
    if (interrupt) {
      stopAll("Interrupted by a newer utterance.")
    }
    insertByPriority(utterance)
    activeByNativeId[utterance.nativeId] = utterance
    drainQueue()
    utterance.failure?.let { throw it }
    return mapOf(
      "utteranceId" to publicId,
      "voiceIdentifier" to voice.name,
      "locale" to normalizedTag(voice.locale)
    )
  }

  private fun boundedFloat(
    value: Double?,
    name: String,
    default: Float,
    minimum: Double? = null,
    maximum: Double? = null,
    unitInterval: Boolean = false
  ): Float {
    if (value == null) return default
    val converted = value.toFloat()
    val invalid = !value.isFinite() || !converted.isFinite() ||
      (minimum != null && value < minimum) ||
      (maximum != null && value > maximum) ||
      (unitInterval && value !in 0.0..1.0)
    if (invalid) {
      val requirement = if (unitInterval) "between 0 and 1" else "finite and between $minimum and $maximum"
      throw VoiceException("ERR_INVALID_SPEECH_PARAMETER", "$name must be $requirement.")
    }
    return converted
  }

  private fun selectVoice(options: SpeakOptions): Voice {
    val allVoices = try {
      engine.voices ?: throw VoiceException("ERR_TTS_VOICES_UNAVAILABLE", "The active text-to-speech engine did not expose its voices.")
    } catch (error: Exception) {
      if (error is VoiceException) throw error
      throw VoiceException("ERR_TTS_VOICES_UNAVAILABLE", "Unable to enumerate text-to-speech voices: ${error.message}", error)
    }

    val requestedVoiceId = options.voiceIdentifier
    if (requestedVoiceId != null) {
      if (requestedVoiceId.isBlank()) throw VoiceException("ERR_INVALID_VOICE_IDENTIFIER", "voiceIdentifier must not be blank.")
      val voice = allVoices.firstOrNull { it.name == requestedVoiceId }
        ?: throw VoiceException("ERR_VOICE_UNAVAILABLE", "Voice '$requestedVoiceId' is not available from the active engine.")
      requireOfflineVoice(voice)
      options.locale?.let {
        val requestedLocale = requireLocale(it)
        if (!sameLanguage(requestedLocale, normalizedTag(voice.locale))) {
          throw VoiceException("ERR_VOICE_LOCALE_MISMATCH", "Voice '$requestedVoiceId' does not provide locale '${normalizedTag(requestedLocale)}'.")
        }
      }
      return voice
    }

    val requestedLocale = requireLocale(options.locale)
    val requestedTag = normalizedTag(requestedLocale)
    val availability = try {
      engine.isLanguageAvailable(requestedLocale)
    } catch (error: Exception) {
      throw VoiceException("ERR_TTS_LOCALE_UNAVAILABLE", "Unable to check locale '$requestedTag': ${error.message}", error)
    }
    if (availability == TextToSpeech.LANG_MISSING_DATA) {
      throw VoiceException("ERR_TTS_OFFLINE_DATA_MISSING", "Voice data for locale '$requestedTag' is not installed.")
    }
    if (availability < 0) {
      throw VoiceException("ERR_TTS_LOCALE_UNAVAILABLE", "Locale '$requestedTag' is unavailable from the active text-to-speech engine.")
    }

    val candidates = allVoices.filter {
      isOfflineVoice(it) && sameLanguage(requestedLocale, normalizedTag(it.locale))
    }
    if (candidates.isEmpty()) {
      throw VoiceException("ERR_TTS_OFFLINE_DATA_MISSING", "No installed offline voice is available for locale '$requestedTag'. Network voices are not used.")
    }
    return candidates.sortedWith(
      compareByDescending<Voice> { normalizedTag(it.locale).equals(requestedTag, ignoreCase = true) }
        .thenByDescending { it.locale.country == requestedLocale.country }
        .thenByDescending { it.quality }
        .thenBy { it.latency }
        .thenBy { it.name }
    ).first()
  }

  private fun requireOfflineVoice(voice: Voice) {
    if (voice.isNetworkConnectionRequired) {
      throw VoiceException("ERR_NETWORK_VOICE_NOT_ALLOWED", "Voice '${voice.name}' requires a network connection. Choose an installed offline voice.")
    }
    if (voice.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) == true) {
      throw VoiceException("ERR_TTS_OFFLINE_DATA_MISSING", "Voice '${voice.name}' is not installed on this device.")
    }
    requireLocale(normalizedTag(voice.locale))
  }

  private fun isOfflineVoice(voice: Voice): Boolean {
    return !voice.isNetworkConnectionRequired &&
      voice.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) != true
  }

  private fun insertByPriority(utterance: Utterance) {
    val index = pending.indexOfFirst { it.priority.rank < utterance.priority.rank }
    if (index < 0) pending.add(utterance) else pending.add(index, utterance)
  }

  private fun drainQueue() {
    if (destroyed || !ready) return
    while (current == null && pending.isNotEmpty()) {
      val utterance = pending.removeAt(0)
      current = utterance
      try {
        dispatch(utterance)
      } catch (error: Exception) {
        val voiceError = error as? VoiceException
          ?: VoiceException("ERR_TTS_QUEUE_FAILED", "Unable to queue utterance '${utterance.publicId}': ${error.message}", error)
        failUtterance(utterance, voiceError)
      }
    }
    if (current == null && pending.isEmpty()) routes.restoreSpeech()
  }

  private fun dispatch(utterance: Utterance) {
    routes.prepareSpeech(utterance.speakerFallback)
    checkEngineResult(engine.setVoice(utterance.voice), "setVoice")
    checkEngineResult(engine.setSpeechRate(utterance.rate), "setSpeechRate")
    checkEngineResult(engine.setPitch(utterance.pitch), "setPitch")
    checkEngineResult(engine.setAudioAttributes(audioAttributes), "setAudioAttributes")
    val parameters = Bundle().apply {
      putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, utterance.volume)
    }
    checkEngineResult(
      engine.speak(utterance.text, TextToSpeech.QUEUE_FLUSH, parameters, utterance.nativeId),
      "speak"
    )
  }

  private fun checkEngineResult(result: Int, operation: String) {
    if (result != TextToSpeech.SUCCESS) throw ttsResultError(result, "Android text-to-speech $operation failed")
  }

  private fun failUtterance(utterance: Utterance, error: VoiceException) {
    if (utterance.terminal) return
    utterance.terminal = true
    utterance.failure = error
    if (current === utterance) current = null
    pending.removeAll { it === utterance }
    activeByNativeId.remove(utterance.nativeId)
    events.error("speak", error, utteranceId = utterance.publicId)
    events.speechStopped(utterance.publicId, utterance.priority.wireValue, error.message ?: error.code)
  }

  private fun handleStart(nativeId: String) {
    if (destroyed) return
    val utterance = activeByNativeId[nativeId] ?: return
    if (current !== utterance || utterance.terminal) return
    events.speechStarted(utterance.publicId, utterance.priority.wireValue)
  }

  private fun handleDone(nativeId: String) {
    if (destroyed) return
    val utterance = activeByNativeId[nativeId] ?: return
    if (current !== utterance || utterance.terminal) return
    utterance.terminal = true
    activeByNativeId.remove(nativeId)
    current = null
    events.speechFinished(utterance.publicId, utterance.priority.wireValue)
    drainQueue()
  }

  private fun handleStop(nativeId: String, interrupted: Boolean) {
    if (destroyed) return
    val utterance = activeByNativeId[nativeId] ?: return
    if (utterance.terminal) return
    utterance.terminal = true
    activeByNativeId.remove(nativeId)
    if (current === utterance) current = null
    pending.removeAll { it === utterance }
    events.speechStopped(utterance.publicId, utterance.priority.wireValue, if (interrupted) "Interrupted." else "Cancelled.")
    drainQueue()
  }

  private fun handleError(nativeId: String, errorCode: Int) {
    if (destroyed) return
    val utterance = activeByNativeId[nativeId] ?: return
    if (utterance.terminal) return
    val error = ttsResultError(errorCode, "Text-to-speech synthesis failed")
    utterance.terminal = true
    utterance.failure = error
    activeByNativeId.remove(nativeId)
    if (current === utterance) current = null
    pending.removeAll { it === utterance }
    events.error("synthesizeSpeech", error, utteranceId = utterance.publicId)
    events.speechStopped(utterance.publicId, utterance.priority.wireValue, error.message ?: error.code)
    drainQueue()
  }

  fun stopSpeaking() {
    stopAll("Stopped by caller.")
  }

  fun stopForNoisyOutput() {
    try {
      if (activeByNativeId.values.any { !it.speakerFallback }) {
        stopAll("Headphones were disconnected and speaker fallback was disabled.")
      } else if (activeByNativeId.isNotEmpty()) {
        routes.prepareSpeech(true)
      }
    } catch (error: VoiceException) {
      events.error("stopSpeaking", error)
    }
  }

  private fun stopAll(reason: String) {
    if (destroyed) return
    val utterances = buildList {
      current?.let { add(it) }
      addAll(pending)
    }.distinctBy { it.nativeId }
    if (utterances.isEmpty()) {
      routes.restoreSpeech()
      return
    }
    try {
      if (::engine.isInitialized) {
        val result = engine.stop()
        if (result != TextToSpeech.SUCCESS) {
          throw ttsResultError(result, "Unable to stop and flush Android text-to-speech")
        }
      }
    } finally {
      routes.restoreSpeech()
    }
    // Native stop succeeded before terminal events flush callback state.
    pending.clear()
    current = null
    activeByNativeId.clear()
    utterances.forEach {
      if (!it.terminal) {
        it.terminal = true
        events.speechStopped(it.publicId, it.priority.wireValue, reason)
      }
    }
  }

  private fun ttsResultError(result: Int, prefix: String): VoiceException {
    val (code, detail) = when (result) {
      TextToSpeech.ERROR_NETWORK,
      TextToSpeech.ERROR_NETWORK_TIMEOUT -> "ERR_NETWORK_VOICE_NOT_ALLOWED" to "The engine requested network synthesis, which this module does not allow."
      TextToSpeech.ERROR_NOT_INSTALLED_YET -> "ERR_TTS_OFFLINE_DATA_MISSING" to "The selected offline voice data is not installed."
      TextToSpeech.ERROR_INVALID_REQUEST -> "ERR_TTS_INVALID_REQUEST" to "The synthesis request was invalid."
      TextToSpeech.ERROR_OUTPUT -> "ERR_TTS_AUDIO_OUTPUT" to "The selected audio output failed."
      TextToSpeech.ERROR_SERVICE -> "ERR_TTS_SERVICE" to "The text-to-speech service failed."
      TextToSpeech.ERROR_SYNTHESIS -> "ERR_TTS_SYNTHESIS" to "The text-to-speech engine could not synthesize the text."
      else -> "ERR_TTS_FAILED" to "The engine returned error code $result."
    }
    return VoiceException(code, "$prefix: $detail")
  }

  fun offlineSpeechStatus(): Pair<Boolean, String?> {
    if (destroyed) return false to "The voice module has been destroyed."
    if (!ready) {
      return false to (initializationError?.message ?: "The Android text-to-speech engine is still initializing.")
    }
    val hasOfflineVoice = try {
      engine.voices?.any { isOfflineVoice(it) } == true
    } catch (error: Exception) {
      throw VoiceException("ERR_TTS_VOICES_UNAVAILABLE", "Unable to enumerate offline voices: ${error.message}", error)
    }
    return hasOfflineVoice to if (hasOfflineVoice) null else "No installed offline text-to-speech voice is available."
  }

  fun destroy() {
    if (destroyed) return
    try {
      stopAll("Voice module was destroyed.")
    } catch (error: VoiceException) {
      events.error("shutdownTextToSpeech", error)
    }
    destroyed = true
    ready = false
    if (::engine.isInitialized) engine.shutdown()
  }
}
