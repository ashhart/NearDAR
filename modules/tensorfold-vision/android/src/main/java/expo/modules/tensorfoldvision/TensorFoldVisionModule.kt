package expo.modules.tensorfoldvision

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class TensorFoldVisionModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val controller by lazy {
    VisionController(
      requireNotNull(appContext.reactContext) { "React Application Context is null" },
    ) { event -> sendEvent("onVisionEvent", event) }
  }

  override fun definition() = ModuleDefinition {
    Name("TensorFoldVision")
    Events("onVisionEvent")

    AsyncFunction("getCapabilities") { controller.capabilities() }
    AsyncFunction("getStatus") { controller.status() }

    AsyncFunction("installModel") { modelId: String?, promise: Promise ->
      scope.launch { settle(promise, "E_INSTALL") { controller.install(modelId) } }
    }

    AsyncFunction("loadModel") { installationId: String?, promise: Promise ->
      scope.launch { settle(promise, "E_MODEL_LOAD") { controller.load(installationId) } }
    }

    AsyncFunction("unloadModel") { promise: Promise ->
      scope.launch {
        try {
          controller.unload()
          promise.resolve(null)
        } catch (error: Throwable) {
          reject(promise, error, "E_MODEL_UNLOAD")
        }
      }
    }

    AsyncFunction("describeScene") { request: Map<String, Any?>, promise: Promise ->
      scope.launch { settle(promise, "E_VISION_INFERENCE") { controller.describe(request) } }
    }

    AsyncFunction("cancel") { requestId: String -> controller.cancel(requestId) }
    AsyncFunction("cancelInstall") { controller.cancelInstall() }


    OnDestroy { controller.shutdown() }
  }

  private suspend fun settle(promise: Promise, fallbackCode: String, operation: suspend () -> Any?) {
    try {
      promise.resolve(operation())
    } catch (error: Throwable) {
      reject(promise, error, fallbackCode)
    }
  }

  private fun reject(promise: Promise, error: Throwable, fallbackCode: String) {
    if (error is VisionException) promise.reject(error.code, error.message, error)
    else promise.reject(fallbackCode, error.message ?: "The vision operation failed.", error)
  }
}
