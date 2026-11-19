package expo.modules.tensorfoldengine

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class TensorFoldEngineModule : Module() {
    companion object {
        private val nativeLoadFailure: String? = try {
            System.loadLibrary("tensorfold_jni")
            null
        } catch (error: UnsatisfiedLinkError) {
            "TensorFold native library failed to load: ${error.message}"
        }
    }

    private val limitation: String by lazy {
        nativeLoadFailure ?: run {
            val capabilities = JSONObject(nativeCapabilitiesJson())
            capabilities.optJSONArray("limitations")?.optString(0)
                ?: "This TensorFold revision has no Android model engine."
        }
    }

    private val unavailable get() = IllegalStateException(limitation)

    private external fun nativeCapabilitiesJson(): String

    override fun definition() = ModuleDefinition {
        Name("TensorFoldEngine")
        Events("onEngineEvent")

        AsyncFunction("getCapabilities") {
            mapOf(
                "available" to false,
                "platform" to "android",
                "vision" to false,
                "installSizeBytes" to 1_749_077_616L,
                "reason" to limitation,
            )
        }
        AsyncFunction("getStatus") {
            mapOf("state" to "not-installed", "message" to limitation)
        }
        AsyncFunction<Unit, Map<String, Any?>>("installManifest") { _: Map<String, Any?> ->
            throw unavailable
        }
        AsyncFunction("cancelInstall") { modelId: String ->
            ModelInstaller.cancel(modelId)
        }
        AsyncFunction<Unit, String?>("loadModel") { _: String? ->
            throw unavailable
        }
        AsyncFunction<Unit>("unloadModel") {
            throw unavailable
        }
        AsyncFunction<Unit, Map<String, Any?>>("generate") { _: Map<String, Any?> ->
            throw unavailable
        }
        AsyncFunction<Unit, String>("cancel") { _: String ->
            throw unavailable
        }
    }
}
