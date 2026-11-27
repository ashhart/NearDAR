package expo.modules.tensorfoldengine

import android.content.pm.PackageManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class TensorFoldEngineModule : Module() {
    companion object {
        private const val DEFAULT_MODEL_ID = "lfm3-vl-2b"
        private const val INSTALL_SIZE_BYTES = 1_609_116_269L

        private val nativeLoadFailure: String? = try {
            System.loadLibrary("tensorfold_jni")
            null
        } catch (error: Throwable) {
            "TensorFold native library failed to load: ${error.message ?: error.javaClass.simpleName}"
        }
    }

    private fun hasVulkanHardware(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
        val pm = appContext.reactContext?.packageManager ?: return false
        return try {
            pm.hasSystemFeature(PackageManager.FEATURE_VULKAN_HARDWARE_LEVEL)
        } catch (_: Exception) {
            false
        }
    }

    private val limitation: String by lazy {
        val vulkanStatus = if (hasVulkanHardware()) "Vulkan hardware detected" else "Vulkan hardware unavailable"
        val nativeMessage = if (nativeLoadFailure != null) {
            nativeLoadFailure
        } else {
            try {
                val capabilities = JSONObject(nativeCapabilitiesJson())
                capabilities.optJSONArray("limitations")?.optString(0)?.takeIf { it.isNotBlank() }
                    ?: "TensorFold Vulkan serving for LFM3-VL-2B is not enabled in this Android build."
            } catch (error: Throwable) {
                "TensorFold native capability probe failed: ${error.message ?: error.javaClass.simpleName}"
            }
        }
        "$nativeMessage ($vulkanStatus; NearDar uses the on-device LiteRT-LM vision runtime on Android.)"
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
                "backend" to "vulkan",
                "vision" to false,
                "modelId" to DEFAULT_MODEL_ID,
                "installSizeBytes" to INSTALL_SIZE_BYTES,
                "vulkanHardwareSupported" to hasVulkanHardware(),
                "reason" to limitation,
            )
        }
        AsyncFunction("getStatus") {
            mapOf(
                "state" to "not-installed",
                "modelId" to DEFAULT_MODEL_ID,
                "message" to limitation,
            )
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
            // No Android TensorFold checkpoint is loaded; safe no-op so cleanup never crashes.
        }
        AsyncFunction<Unit, Map<String, Any?>>("generate") { _: Map<String, Any?> ->
            throw unavailable
        }
        AsyncFunction<Unit, String>("cancel") { _: String ->
            // No Android TensorFold generation can be active; safe no-op so cleanup never crashes.
        }
    }
}
