package expo.modules.tensorfoldperception

import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import expo.modules.kotlin.functions.Queues
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TensorFoldPerceptionModule : Module() {
  private val controller by lazy {
    ArcorePerceptionController(
      requireNotNull(appContext.reactContext) { "React Application Context is null" },
      { appContext.currentActivity }
    ) { name, body ->
      when (name) {
        "onSnapshot" -> sendEvent("onPerceptionEvent", mapOf("type" to "snapshot", "snapshot" to PerceptionContract.snapshot(body)))
        "onWarning" -> sendEvent("onPerceptionEvent", mapOf("type" to "warning", "warning" to PerceptionContract.warning(body)))
        "onStatus" -> PerceptionContract.statusMessage(body)?.let { sendEvent("onPerceptionEvent", mapOf("type" to "status", "message" to it)) }
        "onError" -> sendEvent("onPerceptionEvent", mapOf("type" to "error", "message" to (body["message"] as? String ?: "Perception failed.")))
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("TensorFoldPerception")
    Events("onPerceptionEvent")

    AsyncFunction("getCapabilities") { controller.capabilities() }

    AsyncFunction("isForeground") {
      val activity = appContext.currentActivity
      activity != null && !activity.isFinishing && !activity.isDestroyed && activity.hasWindowFocus()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("getStatus") { promise: Promise ->
      controller.getStatus { promise.resolve(it) }
    }

    AsyncFunction("startSession") { options: Map<String, Any?>?, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("E_CONTEXT", "React Application Context is null.", null)
        return@AsyncFunction
      }
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
        controller.start(options, completion(promise))
        return@AsyncFunction
      }
      val permissions = appContext.permissions
      if (permissions == null) {
        promise.reject("E_PERMISSIONS", "The Expo permissions module is unavailable.", null)
        return@AsyncFunction
      }
      permissions.askForPermissions({ response ->
        if (response[Manifest.permission.CAMERA]?.status == PermissionsStatus.GRANTED) {
          controller.start(options, completion(promise))
        } else {
          promise.reject("E_CAMERA_PERMISSION", "Camera access is required for on-device perception.", null)
        }
      }, Manifest.permission.CAMERA)
    }

    AsyncFunction("stopSession") { promise: Promise ->
      controller.stop { promise.resolve(null) }
    }

    AsyncFunction("captureScene") { options: Map<String, Any?>?, promise: Promise ->
      controller.capture(options, completion(promise, convertSnapshot = true))
    }

    AsyncFunction("releaseCapture") { uri: String, promise: Promise ->
      controller.release(uri) { promise.resolve(it) }
    }
    OnActivityEntersBackground {
      sendEvent("onPerceptionEvent", mapOf("type" to "lifecycle", "foreground" to false))
    }
    OnActivityEntersForeground {
      sendEvent("onPerceptionEvent", mapOf("type" to "lifecycle", "foreground" to true))
    }

    OnDestroy { controller.shutdown() }
  }

  private fun completion(promise: Promise, convertSnapshot: Boolean = false): (Result<Map<String, Any?>>) -> Unit = { result ->
    result.fold(
      onSuccess = { promise.resolve(if (convertSnapshot) PerceptionContract.snapshot(it) else null) },
      onFailure = { error ->
        if (error is PerceptionException) promise.reject(error.code, error.message ?: "Perception failed.", error)
        else promise.reject("E_PERCEPTION", error.message ?: "Perception failed.", error)
      }
    )
  }
}
