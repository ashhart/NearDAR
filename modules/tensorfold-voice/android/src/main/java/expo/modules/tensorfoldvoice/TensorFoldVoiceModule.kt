package expo.modules.tensorfoldvoice

import android.Manifest
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Queues
import androidx.core.content.ContextCompat

class TensorFoldVoiceModule : Module() {
  private val handler = Handler(Looper.getMainLooper())
  private lateinit var events: VoiceEvents
  private lateinit var routes: AudioRouteController
  private lateinit var recognition: RecognitionController
  private lateinit var speech: SpeechController
  private var initialized = false
  private var destroyed = false

  override fun definition() = ModuleDefinition {
    Name("TensorFoldVoice")
    Events("onVoiceEvent")

    OnCreate {
      val context = requireNotNull(appContext.reactContext) { "React Application Context is null" }
      events = VoiceEvents { name, payload -> sendEvent(name, payload) }
      routes = AudioRouteController(context, handler, events) {
        if (::speech.isInitialized) speech.stopForNoisyOutput()
      }
      recognition = RecognitionController(context, routes, events)
      speech = SpeechController(context, routes, handler, events) {
        if (::recognition.isInitialized) recognition.interruptForSpeech()
      }
      routes.start()
      initialized = true
    }

    AsyncFunction("getCapabilities") {
      nativeCall("getCapabilities") {
        requireInitialized()
        val onDeviceRecognition = recognition.isOnDeviceRecognitionAvailable()
        val (offlineSpeech, offlineReason) = speech.offlineSpeechStatus()
        val context = appContext.reactContext
          ?: throw VoiceException("ERR_CONTEXT_UNAVAILABLE", "The Android runtime context is unavailable.")
        val microphonePermission = ContextCompat.checkSelfPermission(
          context,
          Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
        val reason = when {
          !onDeviceRecognition && !offlineSpeech ->
            "On-device recognition is unavailable. ${offlineReason ?: "No offline speech voice is available."}"
          !onDeviceRecognition -> "On-device speech recognition is unavailable on this device or Android version."
          !offlineSpeech -> offlineReason
          !microphonePermission -> "Microphone permission is not granted. Recognition will request it when started."
          else -> null
        }
        buildMap<String, Any?> {
          put("available", onDeviceRecognition && offlineSpeech && !destroyed)
          put("onDeviceRecognition", onDeviceRecognition)
          put("offlineSpeech", offlineSpeech)
          put("route", routes.route())
          if (reason != null) put("reason", reason)
        }
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("startListening") { options: ListeningOptions, promise: Promise ->
      val sessionId = try {
        requireInitialized()
        recognition.begin(options)
      } catch (error: Exception) {
        rejectStart(null, error, promise)
        return@AsyncFunction
      }
      recognition.attachPromise(sessionId, promise)
      val context = appContext.reactContext
      if (context != null && ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
        recognition.permissionResult(sessionId, true, null)
        return@AsyncFunction
      }
      val permissions = appContext.permissions
      if (permissions == null) {
        recognition.failStart(
          sessionId,
          VoiceException("ERR_PERMISSIONS_UNAVAILABLE", "Expo Permissions is not linked, so RECORD_AUDIO cannot be requested.")
        )
        return@AsyncFunction
      }
      try {
        permissions.askForPermissions(
          PermissionsResponseListener { response ->
            handler.post {
              if (destroyed) return@post
              val granted = response[Manifest.permission.RECORD_AUDIO]?.status == PermissionsStatus.GRANTED
              recognition.permissionResult(
                sessionId,
                granted,
                if (granted) null else "RECORD_AUDIO permission was denied. On-device recognition requires microphone access."
              )
            }
          },
          Manifest.permission.RECORD_AUDIO
        )
      } catch (error: Exception) {
        recognition.failStart(
          sessionId,
          VoiceException("ERR_PERMISSION_REQUEST_FAILED", "Unable to request RECORD_AUDIO permission: ${error.message}", error)
        )
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stopListening") {
      nativeCall("stopListening") {
        requireInitialized()
        recognition.stopListening()
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("speak") { text: String, options: SpeakOptions ->
      nativeCall("speak", options.utteranceId) {
        requireInitialized()
        speech.speak(text, options)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stopSpeaking") {
      nativeCall("stopSpeaking") {
        requireInitialized()
        speech.stopSpeaking()
      }
    }.runOnQueue(Queues.MAIN)

    OnActivityEntersBackground {
      if (initialized && !destroyed) recognition.background()
    }

    OnActivityEntersForeground {
      if (initialized && !destroyed) {
        recognition.foreground()
        routes.resume()
      }
    }

    OnDestroy {
      if (initialized) {
        recognition.destroy()
        speech.destroy()
        routes.destroy()
      }
      destroyed = true
      if (::events.isInitialized) events.enabled = false
    }
  }

  private fun requireInitialized() {
    if (destroyed) throw VoiceException("ERR_MODULE_DESTROYED", "The voice module has been destroyed.")
    if (!initialized) throw VoiceException("ERR_MODULE_NOT_READY", "The voice module has not finished initializing.")
  }

  private fun <T> nativeCall(operation: String, utteranceId: String? = null, block: () -> T): T {
    try {
      return block()
    } catch (error: Exception) {
      val voiceError = error as? VoiceException
        ?: VoiceException("ERR_NATIVE_VOICE_OPERATION", "$operation failed: ${error.message}", error)
      if (::events.isInitialized) events.error(operation, voiceError, utteranceId = utteranceId)
      throw voiceError
    }
  }

  private fun rejectStart(sessionId: String?, error: Exception, promise: Promise) {
    val voiceError = error as? VoiceException
      ?: VoiceException("ERR_RECOGNITION_START_FAILED", "Unable to start on-device recognition: ${error.message}", error)
    if (::events.isInitialized) events.error("startListening", voiceError, sessionId = sessionId)
    promise.reject(voiceError)
  }
}
