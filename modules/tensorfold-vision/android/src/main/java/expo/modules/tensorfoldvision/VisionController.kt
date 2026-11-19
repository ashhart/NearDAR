package expo.modules.tensorfoldvision

import android.app.ActivityManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.MessageCallback
import com.google.ai.edge.litertlm.SamplerConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CancellationException
import java.util.UUID

internal class VisionController(
  private val context: Context,
  private val emit: (Map<String, Any?>) -> Unit,
) {
  private val installer = VisionInstaller(context)
  private val operationMutex = Mutex()
  private val stateLock = Any()
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  @Volatile private var engine: Engine? = null
  private var statusOverride: Map<String, Any?>? = null
  private var activeRequest: ActiveRequest? = null
  private var unloadAfterRequest = false

  private val memoryCallbacks = object : ComponentCallbacks2 {
    override fun onConfigurationChanged(configuration: Configuration) = Unit
    override fun onLowMemory() = releaseForMemoryPressure()
    override fun onTrimMemory(level: Int) {
      if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) releaseForMemoryPressure()
    }
  }

  init {
    context.registerComponentCallbacks(memoryCallbacks)
  }

  fun capabilities(): Map<String, Any?> = mapOf(
    "available" to true,
    "platform" to "android",
    "vision" to true,
    "installSizeBytes" to VisionModel.SIZE_BYTES,
    "reason" to "The LiteRT-LM runtime is present. loadModel confirms CPU decoding and GPU vision on this device.",
    "modelId" to VisionModel.ID,
    "revision" to VisionModel.REVISION,
    "runtime" to "LiteRT-LM",
    "runtimeVersion" to VisionModel.RUNTIME_VERSION,
    "accelerator" to "gpu",
    "recommendedFreeMemoryBytes" to VisionModel.RECOMMENDED_FREE_MEMORY_BYTES,
    "supportsCancellation" to true,
    "loaded" to (engine != null),
  )

  fun status(): Map<String, Any?> {
    synchronized(stateLock) { statusOverride?.let { return it } }
    if (engine != null) return baseStatus("ready", progress = 1.0)
    if (installer.installedModelPath() != null) return baseStatus("installed")
    return baseStatus("not-installed", includeInstallation = false)
  }

  suspend fun install(modelId: String?): Map<String, Any?> = operationMutex.withLock {
    if (modelId != null && modelId != VisionModel.ID) {
      throw VisionException("E_MODEL_ID", "Only ${VisionModel.ID} is supported.")
    }
    if (engine != null) return@withLock status()
    try {
      installer.install { received ->
        val progress = received.toDouble() / VisionModel.SIZE_BYTES.toDouble()
        setStatus(
          baseStatus(
            "downloading",
            progress = progress,
            downloadedBytes = received,
            totalBytes = VisionModel.SIZE_BYTES,
          ),
        )
      }
      val result = baseStatus(
        "installed",
        progress = 1.0,
        downloadedBytes = VisionModel.SIZE_BYTES,
        totalBytes = VisionModel.SIZE_BYTES,
      )
      clearStatusOverride()
      emit(mapOf("type" to "status", "status" to result))
      result
    } catch (error: Throwable) {
      val failure = asVisionException(error, "E_INSTALL", "Model installation failed.")
      if (failure.code == "E_INSTALL_CANCELLED") {
        clearStatusOverride()
        emit(mapOf("type" to "status", "status" to status(), "message" to failure.message))
      } else {
        setStatus(baseStatus("error", message = failure.message))
      }
      throw failure
    }
  }

  suspend fun load(installationId: String?): Map<String, Any?> = operationMutex.withLock {
    if (installationId != null && installationId != VisionModel.REVISION) {
      throw VisionException("E_MODEL_NOT_INSTALLED", "The requested installation is not the pinned model revision.")
    }
    if (engine != null) return@withLock status()
    setStatus(baseStatus("loading", progress = 0.0))
    var candidate: Engine? = null
    try {
      requireMemory()
      val modelPath = installer.verifiedModelPath()
      val cacheDirectory = File(context.cacheDir, "TensorFoldVision/runtime")
      if (!cacheDirectory.isDirectory && !cacheDirectory.mkdirs()) {
        throw VisionException("E_MODEL_CACHE", "Could not create the LiteRT-LM compilation cache directory.")
      }
      val config = EngineConfig(
        modelPath = modelPath,
        backend = Backend.CPU(),
        visionBackend = Backend.GPU(),
        maxNumTokens = 2048,
        maxNumImages = 1,
        cacheDir = cacheDirectory.absolutePath,
      )
      val newEngine = Engine(config)
      candidate = newEngine
      newEngine.initialize()
      engine = newEngine
      val result = baseStatus("ready", progress = 1.0)
      clearStatusOverride()
      emit(mapOf("type" to "status", "status" to result))
      result
    } catch (error: Throwable) {
      candidate?.run { if (isInitialized()) close() }
      engine = null
      val failure = asVisionException(error, "E_MODEL_LOAD", "LiteRT-LM could not initialize the model on this device.")
      setStatus(baseStatus("error", message = failure.message))
      throw failure
    }
  }

  suspend fun unload() {
    synchronized(stateLock) {
      unloadAfterRequest = true
    }
    requestCancellation(null, Termination.CANCELLED)
    operationMutex.withLock {
      setStatus(baseStatus("unloading", progress = 0.0))
      engine?.close()
      engine = null
      synchronized(stateLock) { unloadAfterRequest = false }
      clearStatusOverride()
      emit(mapOf("type" to "status", "status" to status()))
    }
  }

  suspend fun describe(input: Map<String, Any?>): String {
    val request = parseRequest(input)
    return operationMutex.withLock { describeLocked(request) }
  }

  private suspend fun describeLocked(request: SceneRequest): String {
    val loadedEngine = engine
      ?: throw VisionException("E_MODEL_NOT_READY", "Call loadModel before requesting a scene description.")
    var image: SceneImage? = null
    var conversation: Conversation? = null
    try {
      val resolvedImage = resolveImage(request)
      image = resolvedImage
      val nativeConversation = loadedEngine.createConversation(
        ConversationConfig(
          samplerConfig = SamplerConfig(topK = 40, topP = 0.9, temperature = 0.2, seed = 0),
          automaticToolCalling = false,
          maxOutputToken = request.maxTokens,
        ),
      )
      conversation = nativeConversation
      emit(
        mapOf(
          "type" to "started",
          "requestId" to request.requestId,
          "status" to status(),
        ),
      )
      val generated = withTimeout(VisionModel.QUERY_TIMEOUT_MILLIS) {
        suspendCancellableCoroutine<String> { continuation ->
          synchronized(stateLock) {
            if (activeRequest != null) throw VisionException("E_VISION_BUSY", "Another scene query is already running.")
            activeRequest = ActiveRequest(request.requestId, nativeConversation)
          }
          val builder = StringBuilder()
          val callback = object : MessageCallback {
            override fun onMessage(message: Message) {
              builder.append(message.toString())
            }

            override fun onDone() {
              val termination = synchronized(stateLock) { activeRequest?.termination }
              if (continuation.isActive) {
                if (termination == null) continuation.resumeWith(Result.success(builder.toString()))
                else continuation.resumeWith(Result.failure(terminationException(termination)))
              }
            }

            override fun onError(throwable: Throwable) {
              val termination = synchronized(stateLock) { activeRequest?.termination }
              val error = if (termination != null) terminationException(termination)
              else VisionException("E_VISION_INFERENCE", throwable.message ?: "LiteRT-LM scene generation failed.", throwable)
              if (continuation.isActive) continuation.resumeWith(Result.failure(error))
            }
          }
          nativeConversation.sendMessageAsync(
            Contents.of(Content.ImageFile(resolvedImage.path), Content.Text(request.prompt)),
            callback,
            maxOutputToken = request.maxTokens,
          )
        }
      }
      val termination = synchronized(stateLock) { activeRequest?.termination }
      if (termination != null) throw terminationException(termination)
      emit(mapOf("type" to "completed", "requestId" to request.requestId, "status" to status()))
      return generated
    } catch (error: Throwable) {
      val failure = when {
        error is TimeoutCancellationException -> {
          requestCancellation(request.requestId, Termination.TIMED_OUT)
          VisionException("E_VISION_TIMEOUT", "Scene generation exceeded 90 seconds and was cancelled.", error)
        }
        error is CancellationException -> {
          val termination = synchronized(stateLock) { activeRequest?.termination } ?: Termination.CANCELLED
          terminationException(termination, error)
        }
        else -> asVisionException(error, "E_VISION_INFERENCE", "LiteRT-LM scene generation failed.")
      }
      val eventType = if (failure.code == "E_VISION_CANCELLED") "cancelled" else "error"
      emit(
        mapOf(
          "type" to eventType,
          "requestId" to request.requestId,
          "status" to status(),
          "message" to failure.message,
        ),
      )
      throw failure
    } finally {
      synchronized(stateLock) {
        if (activeRequest?.requestId == request.requestId) activeRequest = null
      }
      conversation?.run { if (isAlive) close() }
      image?.ownedFile?.delete()
      val release = synchronized(stateLock) { unloadAfterRequest }
      if (release) {
        engine?.close()
        engine = null
        synchronized(stateLock) { unloadAfterRequest = false }
        clearStatusOverride()
        emit(mapOf("type" to "status", "status" to status()))
      }
    }
  }

  fun cancel(requestId: String) {
    if (requestId.isBlank()) return
    requestCancellation(requestId, Termination.CANCELLED)
  }
  fun cancelInstall() {
    installer.cancelInstall()
  }


  fun shutdown() {
    context.unregisterComponentCallbacks(memoryCallbacks)
    scope.launch { unload() }
  }

  private fun releaseForMemoryPressure() {
    if (engine == null) return
    scope.launch { unload() }
  }

  private fun requestCancellation(requestId: String?, termination: Termination) {
    val conversation = synchronized(stateLock) {
      val active = activeRequest
      if (active == null || (requestId != null && active.requestId != requestId)) return
      if (active.termination != null) return
      active.termination = termination
      active.conversation
    }
    conversation.cancelProcess()
  }

  private fun requireMemory() {
    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
      ?: throw VisionException("E_MODEL_RESOURCES", "Android memory information is unavailable.")
    val info = ActivityManager.MemoryInfo()
    manager.getMemoryInfo(info)
    if (info.availMem < VisionModel.RECOMMENDED_FREE_MEMORY_BYTES) {
      throw VisionException(
        "E_MODEL_RESOURCES",
        "Model loading requires ${VisionModel.RECOMMENDED_FREE_MEMORY_BYTES} currently available bytes; Android reports ${info.availMem}.",
      )
    }
  }

  private fun baseStatus(
    state: String,
    progress: Double? = null,
    downloadedBytes: Long? = null,
    totalBytes: Long? = null,
    message: String? = null,
    includeInstallation: Boolean = true,
  ): Map<String, Any?> {
    val result = mutableMapOf<String, Any?>(
      "state" to state,
      "modelId" to VisionModel.ID,
      "revision" to VisionModel.REVISION,
    )
    if (includeInstallation) result["installationId"] = VisionModel.REVISION
    if (progress != null) result["progress"] = progress
    if (downloadedBytes != null) result["downloadedBytes"] = downloadedBytes
    if (totalBytes != null) result["totalBytes"] = totalBytes
    if (message != null) result["message"] = message
    return result
  }

  private fun setStatus(value: Map<String, Any?>) {
    synchronized(stateLock) { statusOverride = value }
    emit(mapOf("type" to "status", "status" to value))
  }

  private fun clearStatusOverride() {
    synchronized(stateLock) { statusOverride = null }
  }

  private fun parseRequest(input: Map<String, Any?>): SceneRequest {
    val requestId = input["requestId"] as? String
    val prompt = input["prompt"] as? String
    val maxTokensNumber = input["maxTokens"] as? Number
    val base64 = input["imageBase64"] as? String
    val temporaryPath = input["temporaryImagePath"] as? String
    if (requestId.isNullOrBlank()) throw VisionException("E_VISION_REQUEST", "requestId must not be empty.")
    if (prompt.isNullOrBlank()) throw VisionException("E_VISION_REQUEST", "prompt must not be empty.")
    if (prompt.length > 8192) throw VisionException("E_VISION_REQUEST", "prompt must not exceed 8192 characters.")
    val maxTokens = maxTokensNumber?.toInt() ?: 0
    if (maxTokensNumber == null || maxTokensNumber.toDouble() != maxTokens.toDouble() || maxTokens !in 1..256) {
      throw VisionException("E_VISION_REQUEST", "maxTokens must be an integer from 1 through 256.")
    }
    if (base64.isNullOrEmpty() == temporaryPath.isNullOrEmpty()) {
      throw VisionException("E_IMAGE_REQUIRED", "Supply exactly one of imageBase64 or temporaryImagePath.")
    }
    return SceneRequest(requestId, prompt, maxTokens, base64, temporaryPath)
  }

  private fun resolveImage(request: SceneRequest): SceneImage {
    val cacheDirectory = File(context.cacheDir, "TensorFoldVision/captures")
    if (request.imageBase64 != null) {
      val encodedLength = request.imageBase64.length.toLong()
      if (encodedLength > ((VisionModel.MAX_IMAGE_BYTES + 2L) / 3L) * 4L + 1024L) {
        throw VisionException("E_IMAGE_SIZE", "The base64 image exceeds the 20 MiB input limit.")
      }
      val bytes = try {
        Base64.decode(request.imageBase64, Base64.DEFAULT)
      } catch (error: IllegalArgumentException) {
        throw VisionException("E_IMAGE_FORMAT", "imageBase64 is not valid base64.", error)
      }
      if (bytes.isEmpty() || bytes.size.toLong() > VisionModel.MAX_IMAGE_BYTES) {
        throw VisionException("E_IMAGE_SIZE", "The decoded image must contain 1 through 20 MiB of data.")
      }
      if (!cacheDirectory.isDirectory && !cacheDirectory.mkdirs()) {
        throw VisionException("E_IMAGE_IO", "Could not create the private image directory.")
      }
      val file = File(cacheDirectory, "${UUID.randomUUID()}.image")
      try {
        FileOutputStream(file).use { it.write(bytes) }
        validateImage(file)
        return SceneImage(file.absolutePath, file)
      } catch (error: Throwable) {
        file.delete()
        throw error
      }
    }

    val rawPath = request.temporaryImagePath ?: throw VisionException("E_IMAGE_REQUIRED", "An image is required.")
    val path = if (rawPath.startsWith("file://")) Uri.parse(rawPath).path else rawPath
    if (path.isNullOrEmpty()) throw VisionException("E_IMAGE_PATH", "temporaryImagePath must be an absolute file path.")
    val file = try {
      File(path).canonicalFile
    } catch (error: Exception) {
      throw VisionException("E_IMAGE_PATH", "The temporary image path cannot be resolved.", error)
    }
    val roots = listOfNotNull(context.cacheDir.canonicalFile, context.externalCacheDir?.canonicalFile)
    if (roots.none { file.toPath().startsWith(it.toPath()) }) {
      throw VisionException("E_IMAGE_PATH", "The image must be inside the app's cache directories.")
    }
    validateImage(file)
    return SceneImage(file.absolutePath, null)
  }

  private fun validateImage(file: File) {
    if (!file.isFile || file.length() <= 0L || file.length() > VisionModel.MAX_IMAGE_BYTES) {
      throw VisionException("E_IMAGE_SIZE", "The image must be a regular file containing 1 through 20 MiB.")
    }
    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, options)
    if (options.outWidth <= 0 || options.outHeight <= 0) {
      throw VisionException("E_IMAGE_FORMAT", "Android could not decode the image header.")
    }
  }

  private fun asVisionException(error: Throwable, code: String, fallback: String): VisionException {
    if (error is VisionException) return error
    return VisionException(code, error.message ?: fallback, error)
  }

  private fun terminationException(termination: Termination, cause: Throwable? = null): VisionException {
    return when (termination) {
      Termination.CANCELLED -> VisionException("E_VISION_CANCELLED", "Scene generation was cancelled.", cause)
      Termination.TIMED_OUT -> VisionException("E_VISION_TIMEOUT", "Scene generation exceeded 90 seconds and was cancelled.", cause)
    }
  }

  private data class SceneRequest(
    val requestId: String,
    val prompt: String,
    val maxTokens: Int,
    val imageBase64: String?,
    val temporaryImagePath: String?,
  )

  private data class SceneImage(val path: String, val ownedFile: File?)
  private data class ActiveRequest(
    val requestId: String,
    val conversation: Conversation,
    var termination: Termination? = null,
  )
  private enum class Termination { CANCELLED, TIMED_OUT }
}
