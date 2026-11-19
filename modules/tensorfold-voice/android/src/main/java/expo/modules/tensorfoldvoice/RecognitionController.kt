package expo.modules.tensorfoldvoice

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.annotation.RequiresApi
import expo.modules.kotlin.Promise
import java.util.Locale
import java.util.UUID

class RecognitionController(
  private val context: Context,
  private val routes: AudioRouteController,
  private val events: VoiceEvents
) {
  private enum class Stage {
    REQUESTING_PERMISSION,
    CHECKING_SUPPORT,
    STARTING,
    CAPTURING
  }

  private inner class Session(
    val id: String,
    val locale: Locale,
    val silenceTimeoutMs: Int?,
    val preferBluetoothMicrophone: Boolean,
    var promise: Promise?,
    var stage: Stage
  ) {
    var recognizer: SpeechRecognizer? = null
  }

  private var activeSession: Session? = null
  private var foreground = true
  private var destroyed = false

  fun begin(options: ListeningOptions): String {
    if (destroyed) throw VoiceException("ERR_MODULE_DESTROYED", "The voice module has been destroyed.")
    if (activeSession != null) {
      throw VoiceException("ERR_RECOGNITION_BUSY", "A recognition session is already active or waiting for permission.")
    }
    if (!foreground) {
      throw VoiceException("ERR_ACTIVITY_BACKGROUNDED", "Recognition cannot start while the activity is in the background.")
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      throw VoiceException("ERR_ON_DEVICE_RECOGNITION_UNSUPPORTED", "On-device speech recognition requires Android 12 (API 31) or newer. No network recognizer is available.")
    }
    if (!isOnDeviceRecognitionAvailable()) {
      throw VoiceException("ERR_ON_DEVICE_RECOGNITION_UNAVAILABLE", "No on-device speech recognition service is installed or enabled.")
    }
    if (!routes.hasMicrophoneHardware()) {
      throw VoiceException("ERR_MICROPHONE_UNAVAILABLE", "No microphone input is currently available.")
    }

    val locale = requireLocale(options.locale)
    val silenceTimeoutMs = options.silenceTimeoutMs
    if (silenceTimeoutMs != null && silenceTimeoutMs <= 0) {
      throw VoiceException("ERR_INVALID_SILENCE_TIMEOUT", "silenceTimeoutMs must be greater than zero.")
    }

    val id = UUID.randomUUID().toString()
    activeSession = Session(
      id,
      locale,
      silenceTimeoutMs,
      options.preferBluetoothMicrophone,
      null,
      Stage.REQUESTING_PERMISSION
    )
    return id
  }

  fun attachPromise(sessionId: String, promise: Promise) {
    val session = activeSession
    if (session?.id != sessionId || session.stage != Stage.REQUESTING_PERMISSION) {
      promise.reject("ERR_RECOGNITION_CANCELLED", "The recognition request was cancelled before permission could be requested.", null)
      return
    }
    session.promise = promise
  }

  fun failStart(sessionId: String, error: VoiceException) {
    val session = activeSession ?: return
    if (session.id == sessionId) fail(session, error)
  }

  fun permissionResult(sessionId: String, granted: Boolean, message: String?) {
    val session = activeSession ?: return
    if (session.id != sessionId || session.stage != Stage.REQUESTING_PERMISSION) return
    if (!granted) {
      fail(
        session,
        VoiceException("ERR_MICROPHONE_PERMISSION_DENIED", message ?: "RECORD_AUDIO permission was denied. On-device recognition cannot capture audio.")
      )
      return
    }
    if (destroyed) {
      cancel(session, "Voice module was destroyed.")
      return
    }
    if (!foreground) {
      cancel(session, "Activity entered the background.")
      return
    }
    startAfterPermission(session)
  }

  private fun startAfterPermission(session: Session) {
    if (activeSession !== session || session.stage != Stage.REQUESTING_PERMISSION) return
    try {
      val recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
      session.recognizer = recognizer
      recognizer.setRecognitionListener(SessionListener(session))
      session.stage = Stage.CHECKING_SUPPORT
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        checkLocaleSupport(session, recognizer)
      } else {
        startCapture(session)
      }
    } catch (error: Exception) {
      fail(session, asVoiceException("ERR_ON_DEVICE_RECOGNITION_UNAVAILABLE", "Unable to create the on-device recognizer", error))
    }
  }

  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  private fun checkLocaleSupport(session: Session, recognizer: SpeechRecognizer) {
    try {
      recognizer.checkRecognitionSupport(
        recognitionIntent(session),
        context.mainExecutor,
        object : RecognitionSupportCallback {
          override fun onSupportResult(recognitionSupport: RecognitionSupport) {
            if (activeSession !== session || session.stage != Stage.CHECKING_SUPPORT) return
            val requestedTag = normalizedTag(session.locale)
            when {
              recognitionSupport.installedOnDeviceLanguages.any { sameLanguage(session.locale, it) } ->
                startCapture(session)
              recognitionSupport.pendingOnDeviceLanguages.any { sameLanguage(session.locale, it) } ->
                fail(
                  session,
                  VoiceException("ERR_RECOGNITION_MODEL_DOWNLOAD_PENDING", "The offline recognition model for '$requestedTag' is still downloading.")
                )
              recognitionSupport.supportedOnDeviceLanguages.any { sameLanguage(session.locale, it) } ->
                fail(
                  session,
                  VoiceException("ERR_RECOGNITION_MODEL_MISSING", "The offline recognition model for '$requestedTag' is supported but is not installed.")
                )
              else ->
                fail(
                  session,
                  VoiceException("ERR_RECOGNITION_LOCALE_UNAVAILABLE", "On-device recognition is unavailable for locale '$requestedTag'.")
                )
            }
          }

          override fun onError(error: Int) {
            if (activeSession !== session || session.stage != Stage.CHECKING_SUPPORT) return
            fail(session, recognitionError(error, "The recognition locale support check failed"))
          }
        }
      )
    } catch (error: Exception) {
      fail(session, asVoiceException("ERR_RECOGNITION_SUPPORT_CHECK_FAILED", "Unable to check offline recognition support", error))
    }
  }

  private fun startCapture(session: Session) {
    if (activeSession !== session || destroyed) return
    try {
      routes.prepareRecognition(session.preferBluetoothMicrophone)
      session.stage = Stage.STARTING
      val recognizer = session.recognizer
        ?: throw VoiceException("ERR_ON_DEVICE_RECOGNITION_UNAVAILABLE", "The on-device recognizer was lost before capture started.")
      session.stage = Stage.CAPTURING
      recognizer.startListening(recognitionIntent(session))
      val promise = session.promise
      session.promise = null
      promise?.resolve(
        mapOf(
          "sessionId" to session.id,
          "locale" to normalizedTag(session.locale)
        )
      )
    } catch (error: Exception) {
      val voiceError = error as? VoiceException
        ?: asVoiceException("ERR_RECOGNITION_START_FAILED", "Unable to start on-device recognition", error)
      fail(session, voiceError)
    }
  }

  private fun recognitionIntent(session: Session): Intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
    putExtra(RecognizerIntent.EXTRA_LANGUAGE, normalizedTag(session.locale))
    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5)
    putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
    session.silenceTimeoutMs?.let {
      putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, it)
      putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, it)
    }
  }

  private inner class SessionListener(private val session: Session) : RecognitionListener {
    private fun isCurrent(): Boolean = activeSession === session && !destroyed

    override fun onReadyForSpeech(params: Bundle?) {
      if (isCurrent()) events.listeningStarted(session.id)
    }

    override fun onBeginningOfSpeech() = Unit

    override fun onRmsChanged(rmsdB: Float) = Unit

    override fun onBufferReceived(buffer: ByteArray?) = Unit

    override fun onEndOfSpeech() = Unit

    override fun onError(error: Int) {
      if (isCurrent()) fail(session, recognitionError(error, "On-device recognition failed"))
    }

    override fun onResults(results: Bundle?) {
      if (!isCurrent()) return
      emitRecognition(session, "final", results)
      finish(session, null)
    }

    override fun onPartialResults(partialResults: Bundle?) {
      if (isCurrent()) emitRecognition(session, "partial", partialResults)
    }

    override fun onEvent(eventType: Int, params: Bundle?) = Unit
  }

  private fun emitRecognition(session: Session, phase: String, bundle: Bundle?) {
    val values = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
    val scores = bundle?.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)
    val confidence = scores?.firstOrNull()?.takeIf { it in 0f..1f }?.toDouble()
    events.recognition(
      session.id,
      phase,
      values.firstOrNull().orEmpty(),
      values.drop(1),
      confidence,
      normalizedTag(session.locale)
    )
  }

  fun stopListening() {
    activeSession?.let { cancel(it, "Stopped by caller.") }
  }

  fun interruptForSpeech() {
    activeSession?.let { cancel(it, "Speech synthesis interrupted listening.") }
  }

  fun background() {
    foreground = false
    activeSession?.let { cancel(it, "Activity entered the background.") }
  }

  fun foreground() {
    foreground = true
  }

  private fun fail(session: Session, error: VoiceException) {
    if (activeSession !== session) return
    val starting = session.promise != null
    events.error(if (starting) "startListening" else "recognition", error, sessionId = session.id)
    session.promise?.reject(error)
    session.promise = null
    finish(session, error.message ?: error.code)
  }

  private fun cancel(session: Session, message: String) {
    if (activeSession !== session) return
    session.promise?.reject(
      "ERR_RECOGNITION_CANCELLED",
      "Recognition was cancelled before capture started.",
      null
    )
    session.promise = null
    finish(session, message)
  }

  private fun finish(session: Session, message: String?) {
    if (activeSession !== session) return
    activeSession = null
    val recognizer = session.recognizer
    session.recognizer = null
    try {
      if (session.stage == Stage.CAPTURING) recognizer?.stopListening() else recognizer?.cancel()
    } catch (_: Exception) {
      try {
        recognizer?.cancel()
      } catch (_: Exception) {
      }
    }
    try {
      recognizer?.destroy()
    } catch (_: Exception) {
    }
    routes.restoreRecognition()
    events.listeningStopped(session.id, message)
  }

  fun isOnDeviceRecognitionAvailable(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || destroyed) return false
    return try {
      SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
    } catch (_: Exception) {
      false
    }
  }

  private fun recognitionError(error: Int, prefix: String): VoiceException {
    val (code, detail) = when (error) {
      SpeechRecognizer.ERROR_AUDIO -> "ERR_RECOGNITION_AUDIO" to "Audio capture failed."
      SpeechRecognizer.ERROR_CLIENT -> "ERR_RECOGNITION_CLIENT" to "The on-device recognizer reported a client error."
      SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "ERR_MICROPHONE_PERMISSION_DENIED" to "RECORD_AUDIO permission is insufficient."
      SpeechRecognizer.ERROR_NETWORK,
      SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "ERR_ON_DEVICE_RECOGNITION_NETWORK_ERROR" to "The on-device recognizer reported a network error. No network fallback was attempted."
      SpeechRecognizer.ERROR_NO_MATCH -> "ERR_RECOGNITION_NO_MATCH" to "No speech recognition result matched."
      SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "ERR_RECOGNITION_SPEECH_TIMEOUT" to "No speech input arrived before the recognition timeout."
      SpeechRecognizer.ERROR_RECOGNIZER_BUSY,
      SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> "ERR_RECOGNITION_BUSY" to "The on-device recognizer is busy."
      SpeechRecognizer.ERROR_SERVER,
      SpeechRecognizer.ERROR_SERVER_DISCONNECTED -> "ERR_OFFLINE_RECOGNIZER_UNAVAILABLE" to "The on-device recognition service disconnected or failed."
      SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED -> "ERR_RECOGNITION_LOCALE_UNAVAILABLE" to "The requested locale is not supported by the on-device recognizer."
      SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "ERR_RECOGNITION_MODEL_MISSING" to "The requested locale's offline recognition model is not installed."
      SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT -> "ERR_RECOGNITION_SUPPORT_CHECK_FAILED" to "The on-device recognizer cannot report locale support."
      SpeechRecognizer.ERROR_CANNOT_LISTEN_TO_DOWNLOAD_EVENTS -> "ERR_RECOGNITION_SUPPORT_CHECK_FAILED" to "The on-device recognizer cannot monitor offline model availability."
      else -> "ERR_RECOGNITION_FAILED" to "The on-device recognizer returned error code $error."
    }
    return VoiceException(code, "$prefix: $detail")
  }

  private fun asVoiceException(code: String, prefix: String, error: Exception): VoiceException {
    return error as? VoiceException ?: VoiceException(code, "$prefix: ${error.message ?: error.javaClass.simpleName}", error)
  }

  fun destroy() {
    if (destroyed) return
    activeSession?.let { cancel(it, "Voice module was destroyed.") }
    destroyed = true
  }
}
