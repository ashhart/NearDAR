package expo.modules.tensorfoldvision

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

internal class VisionInstaller(private val context: Context) {
  private val installActive = AtomicBoolean(false)
  private val cancelRequested = AtomicBoolean(false)
  @Volatile private var activeConnection: HttpURLConnection? = null

  private val modelRoot = File(context.filesDir, "TensorFoldVision/models")
  private val modelDirectory = File(modelRoot, "${VisionModel.ID}/${VisionModel.REVISION}")
  private val modelFile = File(modelDirectory, VisionModel.FILE_NAME)
  private val metadataFile = File(modelDirectory, "installation.json")

  fun installedModelPath(): String? {
    if (!modelFile.isFile || Files.isSymbolicLink(modelFile.toPath())) return null
    if (modelFile.length() != VisionModel.SIZE_BYTES) return null
    if (!metadataFile.isFile) return null
    return modelFile.absolutePath
  }

  fun verifiedModelPath(): String {
    val path = installedModelPath()
      ?: throw VisionException("E_MODEL_NOT_INSTALLED", "SmolVLM2-500M is not installed.")
    verifyMetadata()
    verifyFile(modelFile)
    return path
  }

  fun cancelInstall() {
    if (!installActive.get()) return
    cancelRequested.set(true)
    activeConnection?.disconnect()
  }

  fun install(progress: (receivedBytes: Long) -> Unit) {
    if (!installActive.compareAndSet(false, true)) {
      throw VisionException("E_INSTALL_BUSY", "A model installation is already active.")
    }
    cancelRequested.set(false)
    try {
      installSerialized(progress)
    } finally {
      activeConnection = null
      installActive.set(false)
    }
  }

  private fun installSerialized(progress: (receivedBytes: Long) -> Unit) {
    throwIfCancelled()
    if (installedModelPath() != null) {
      try {
        verifyMetadata()
        verifyFile(modelFile)
        throwIfCancelled()
        progress(VisionModel.SIZE_BYTES)
        return
      } catch (error: VisionException) {
        if (cancelRequested.get()) throw error
        // The verified staging directory replaces corrupt or incomplete state below.
      }
    }

    val parent = modelDirectory.parentFile
    if (!parent.isDirectory && !parent.mkdirs()) {
      throw VisionException("E_INSTALL_DIRECTORY", "Could not create the model installation directory.")
    }
    throwIfCancelled()
    val availableBytes = parent.usableSpace
    val requiredBytes = VisionModel.SIZE_BYTES + 64L * 1024L * 1024L
    if (availableBytes < requiredBytes) {
      throw VisionException(
        "E_INSTALL_SPACE",
        "The download needs $requiredBytes free bytes; only $availableBytes are available.",
      )
    }

    val staging = File(parent, ".${VisionModel.REVISION}.staging-${UUID.randomUUID()}")
    if (!staging.mkdir()) {
      throw VisionException("E_INSTALL_DIRECTORY", "Could not create an isolated staging directory.")
    }
    try {
      throwIfCancelled()
      download(staging, progress)
      throwIfCancelled()
      val stagedModel = File(staging, VisionModel.FILE_NAME)
      verifyFile(stagedModel)
      throwIfCancelled()
      writeMetadata(File(staging, "installation.json"))
      throwIfCancelled()
      publish(staging)
      progress(VisionModel.SIZE_BYTES)
    } catch (error: Throwable) {
      if (cancelRequested.get()) throw cancellationFailure(error)
      if (error is VisionException) throw error
      throw VisionException("E_INSTALL", error.message ?: "Could not install the vision model.", error)
    } finally {
      if (staging.exists()) staging.deleteRecursively()
    }
  }

  private fun verifyMetadata() {
    try {
      val metadata = JSONObject(metadataFile.readText())
      require(metadata.getString("modelId") == VisionModel.ID)
      require(metadata.getString("installationId") == VisionModel.REVISION)
      require(metadata.getString("file") == VisionModel.FILE_NAME)
      require(metadata.getLong("sizeBytes") == VisionModel.SIZE_BYTES)
      require(metadata.getString("sha256") == VisionModel.SHA256)
    } catch (error: Throwable) {
      throw VisionException("E_MODEL_INTEGRITY", "The persisted installation metadata is invalid.", error)
    }
  }

  private fun verifyFile(file: File) {
    if (!file.isFile || Files.isSymbolicLink(file.toPath())) {
      throw VisionException("E_MODEL_INTEGRITY", "The model is not a regular file.")
    }
    if (file.length() != VisionModel.SIZE_BYTES) {
      throw VisionException("E_MODEL_INTEGRITY", "The model size does not match the pinned revision.")
    }
    val actual = sha256(file)
    if (actual != VisionModel.SHA256) {
      throw VisionException("E_MODEL_INTEGRITY", "The model SHA-256 does not match the pinned revision.")
    }
  }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        if (count > 0) digest.update(buffer, 0, count)
      }
    }
    return hex(digest.digest())
  }

  private fun writeMetadata(file: File) {
    val metadata = JSONObject()
      .put("modelId", VisionModel.ID)
      .put("installationId", VisionModel.REVISION)
      .put("file", VisionModel.FILE_NAME)
      .put("sizeBytes", VisionModel.SIZE_BYTES)
      .put("sha256", VisionModel.SHA256)
      .put("installedAt", System.currentTimeMillis() / 1000L)
      .toString()
    FileOutputStream(file).use { output ->
      output.write(metadata.toByteArray(Charsets.UTF_8))
      output.fd.sync()
    }
  }

  private fun download(staging: File, progress: (receivedBytes: Long) -> Unit) {
    var currentUri = httpsUri(VisionModel.DOWNLOAD_URL)
    var redirects = 0
    var nextProgress = 0L
    progress(0L)

    while (true) {
      throwIfCancelled()
      val connection = currentUri.toURL().openConnection() as HttpURLConnection
      activeConnection = connection
      try {
        throwIfCancelled()
        connection.requestMethod = "GET"
        connection.instanceFollowRedirects = false
        connection.useCaches = false
        connection.connectTimeout = 30_000
        connection.readTimeout = 60_000
        connection.setRequestProperty("Accept-Encoding", "identity")

        when (val responseCode = connection.responseCode) {
          in REDIRECT_CODES -> {
            if (redirects == 5) throw IOException("The model download exceeded five redirects.")
            val location = connection.getHeaderField("Location")
              ?: throw IOException("A download redirect omitted its Location header.")
            currentUri = httpsUri(currentUri.resolve(location).toString())
            redirects += 1
            continue
          }
          HttpURLConnection.HTTP_OK -> {
            val contentLength = connection.contentLengthLong
            if (contentLength >= 0L && contentLength != VisionModel.SIZE_BYTES) {
              throw IOException("The server returned an unexpected model Content-Length.")
            }
            val destination = File(staging, VisionModel.FILE_NAME)
            val digest = MessageDigest.getInstance("SHA-256")
            var received = 0L
            FileOutputStream(destination).use { output ->
              connection.inputStream.use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                  throwIfCancelled()
                  val count = input.read(buffer)
                  if (count < 0) break
                  if (count == 0) continue
                  received += count
                  if (received > VisionModel.SIZE_BYTES) throw IOException("The model download exceeded its pinned size.")
                  output.write(buffer, 0, count)
                  digest.update(buffer, 0, count)
                  if (received >= nextProgress) {
                    progress(received)
                    nextProgress = received + 1024L * 1024L
                  }
                }
              }
              output.fd.sync()
            }
            if (received != VisionModel.SIZE_BYTES) throw IOException("The model download ended before its pinned size.")
            if (hex(digest.digest()) != VisionModel.SHA256) throw IOException("The downloaded model failed SHA-256 verification.")
            progress(received)
            return
          }
          else -> throw IOException("The model download returned HTTP $responseCode.")
        }
      } finally {
        activeConnection = null
        connection.disconnect()
      }
    }
  }

  private fun hex(bytes: ByteArray): String {
    val output = CharArray(bytes.size * 2)
    val alphabet = "0123456789abcdef"
    for (index in bytes.indices) {
      val value = bytes[index].toInt() and 0xff
      output[index * 2] = alphabet[value ushr 4]
      output[index * 2 + 1] = alphabet[value and 0x0f]
    }
    return String(output)
  }

  private fun throwIfCancelled() {
    if (cancelRequested.get()) throw cancellationFailure()
  }

  private fun cancellationFailure(cause: Throwable? = null): VisionException {
    return VisionException("E_INSTALL_CANCELLED", "Model installation was cancelled.", cause)
  }

  private fun httpsUri(value: String): URI {
    val uri = try {
      URI(value)
    } catch (error: Exception) {
      throw VisionException("E_INSTALL_URL", "The model or redirect URL is invalid.", error)
    }
    if (!uri.scheme.equals("https", ignoreCase = true) || uri.host.isNullOrEmpty()) {
      throw VisionException("E_INSTALL_URL", "Model downloads and redirects must use HTTPS.")
    }
    return uri
  }

  private fun publish(staging: File) {
    val parent = modelDirectory.parentFile
    var backup: File? = null
    try {
      if (Files.exists(modelDirectory.toPath(), LinkOption.NOFOLLOW_LINKS)) {
        backup = File(parent, ".${VisionModel.REVISION}.backup-${UUID.randomUUID()}")
        atomicMove(modelDirectory, backup)
      }
      atomicMove(staging, modelDirectory)
      backup?.deleteRecursively()
    } catch (error: Throwable) {
      if (!modelDirectory.exists() && backup?.exists() == true) {
        try {
          atomicMove(backup, modelDirectory)
        } catch (restoreError: Throwable) {
          error.addSuppressed(restoreError)
        }
      }
      throw VisionException("E_INSTALL_ATOMIC", "The staged model could not be published atomically.", error)
    }
  }

  private fun atomicMove(source: File, destination: File) {
    try {
      Files.move(source.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE)
    } catch (error: AtomicMoveNotSupportedException) {
      throw IOException("Atomic rename is unavailable on the application filesystem.", error)
    }
  }

  private companion object {
    val REDIRECT_CODES = setOf(301, 302, 303, 307, 308)
  }
}
