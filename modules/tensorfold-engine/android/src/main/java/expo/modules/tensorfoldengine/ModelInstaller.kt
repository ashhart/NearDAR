package expo.modules.tensorfoldengine

import android.content.Context
import java.io.IOException
import java.math.BigDecimal
import java.net.HttpURLConnection
import java.net.URI
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import java.util.UUID

internal object ModelInstaller {
    private const val DEFAULT_MAX_TOTAL_BYTES = 8L * 1024 * 1024 * 1024
    private const val HARD_MAX_TOTAL_BYTES = 16L * 1024 * 1024 * 1024
    private const val BUFFER_SIZE = 64 * 1024
    private const val MAX_REDIRECTS = 5

    private val lock = Any()
    private val activeInstalls = mutableMapOf<String, HttpURLConnection?>()
    private val cancelledModelIds = mutableSetOf<String>()

    fun install(
        context: Context,
        input: Map<String, Any?>,
        progress: (Map<String, Any?>) -> Unit,
    ): Map<String, Any?> {
        val request = parseRequest(input)
        synchronized(lock) {
            if (activeInstalls.containsKey(request.modelId)) {
                throw IllegalStateException("An install for ${request.modelId} is already running")
            }
            activeInstalls[request.modelId] = null
            cancelledModelIds.remove(request.modelId)
        }
        try {
            return installSerialized(context, request, progress)
        } catch (error: Throwable) {
            if (isCancelled(request.modelId)) {
                throw IOException("Model installation cancelled", error)
            }
            throw error
        } finally {
            synchronized(lock) {
                activeInstalls.remove(request.modelId)
                cancelledModelIds.remove(request.modelId)
            }
        }
    }

    fun cancel(modelId: String): Boolean {
        val connection = synchronized(lock) {
            if (!activeInstalls.containsKey(modelId)) return false
            cancelledModelIds.add(modelId)
            activeInstalls[modelId]
        }
        connection?.disconnect()
        return true
    }

    private fun installSerialized(
        context: Context,
        request: InstallRequest,
        progress: (Map<String, Any?>) -> Unit,
    ): Map<String, Any?> {
        val root = context.filesDir.toPath()
            .resolve("TensorFoldModels")
            .toAbsolutePath()
            .normalize()
        val directory = root.resolve(request.modelId).resolve(request.revision).normalize()
        if (!directory.startsWith(root) || directory == root) {
            throw IllegalArgumentException("Model identity resolves outside the model root")
        }

        if (Files.exists(directory, LinkOption.NOFOLLOW_LINKS) && !request.overwrite) {
            if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) {
                throw IllegalStateException("The existing model path is not a directory")
            }
            for (file in request.files) {
                throwIfCancelled(request.modelId)
                emit(progress, request.modelId, file.path, 0, file.sizeBytes, "verifying")
                verifyExisting(directory.resolve(file.path).normalize(), file, request.modelId)
                emit(
                    progress,
                    request.modelId,
                    file.path,
                    file.sizeBytes,
                    file.sizeBytes,
                    "completed",
                )
            }
            return result(request, directory)
        }

        Files.createDirectories(directory.parent)
        val staging = directory.resolveSibling(
            ".${directory.fileName}.staging-${UUID.randomUUID()}",
        )
        Files.createDirectory(staging)

        try {
            var completedBytes = 0L
            for (file in request.files) {
                throwIfCancelled(request.modelId)
                val destination = staging.resolve(file.path).normalize()
                if (!destination.startsWith(staging)) {
                    throw IllegalArgumentException("Invalid model file path: ${file.path}")
                }
                download(
                    file = file,
                    destination = destination,
                    completedBytes = completedBytes,
                    maxTotalBytes = request.maxTotalBytes,
                    modelId = request.modelId,
                    progress = progress,
                )
                completedBytes += file.sizeBytes
            }
            throwIfCancelled(request.modelId)

            publish(staging, directory)
            return result(request, directory)
        } catch (error: Throwable) {
            try {
                deleteRecursively(staging)
            } catch (cleanupError: Throwable) {
                error.addSuppressed(cleanupError)
            }
            throw error
        }
    }
    private fun isCancelled(modelId: String): Boolean = synchronized(lock) {
        cancelledModelIds.contains(modelId)
    }

    private fun throwIfCancelled(modelId: String) {
        if (isCancelled(modelId)) throw IOException("Model installation cancelled")
    }

    private fun registerConnection(modelId: String, connection: HttpURLConnection?) {
        synchronized(lock) {
            if (activeInstalls.containsKey(modelId)) activeInstalls[modelId] = connection
        }
    }


    private fun parseRequest(input: Map<String, Any?>): InstallRequest {
        val modelId = input["modelId"] as? String
            ?: throw IllegalArgumentException("modelId must be a string")
        val revision = input["revision"] as? String
            ?: throw IllegalArgumentException("revision must be a string")
        validateRelativePath(modelId, "modelId")
        validateRelativePath(revision, "revision")

        val rawOverwrite = input["overwrite"]
        val overwrite = if (rawOverwrite == null) {
            false
        } else {
            rawOverwrite as? Boolean
                ?: throw IllegalArgumentException("overwrite must be a boolean")
        }
        val maxTotalBytes = if (input["maxTotalBytes"] == null) {
            DEFAULT_MAX_TOTAL_BYTES
        } else {
            exactLong(input["maxTotalBytes"], "maxTotalBytes")
        }
        if (maxTotalBytes < 0 || maxTotalBytes > HARD_MAX_TOTAL_BYTES) {
            throw IllegalArgumentException(
                "maxTotalBytes must be between 0 and $HARD_MAX_TOTAL_BYTES",
            )
        }

        val rawFiles = input["files"] as? List<*>
            ?: throw IllegalArgumentException("files must be an array")
        val files = ArrayList<ModelFile>(rawFiles.size)
        val paths = HashSet<String>()
        var totalBytes = 0L

        for ((index, value) in rawFiles.withIndex()) {
            val record = value as? Map<*, *>
                ?: throw IllegalArgumentException("files[$index] must be a map")
            val path = record["path"] as? String
                ?: throw IllegalArgumentException("files[$index].path must be a string")
            validateRelativePath(path, "files[$index].path")
            if (!paths.add(path)) {
                throw IllegalArgumentException("Duplicate model file path: $path")
            }

            val rawUrl = record["url"] as? String
                ?: throw IllegalArgumentException("files[$index].url must be a string")
            val url = validateHttpsUrl(rawUrl, "files[$index].url")
            val sizeBytes = exactLong(record["size"], "files[$index].size")
            if (sizeBytes < 0) {
                throw IllegalArgumentException("files[$index].size must not be negative")
            }
            val sha256 = record["sha256"] as? String
                ?: throw IllegalArgumentException("files[$index].sha256 must be a string")
            if (sha256.length !in 40..64 || sha256.any { it !in '0'..'9' && it !in 'a'..'f' }) {
                throw IllegalArgumentException(
                    "files[$index].sha256 must contain 40 to 64 lowercase hexadecimal characters",
                )
            }

            try {
                totalBytes = Math.addExact(totalBytes, sizeBytes)
            } catch (error: ArithmeticException) {
                throw IllegalArgumentException("The manifest size overflows a 64-bit integer", error)
            }
            if (totalBytes > maxTotalBytes) {
                throw IllegalArgumentException("The manifest exceeds maxTotalBytes")
            }

            files.add(ModelFile(path, url, sizeBytes, sha256))
        }

        if (paths.isEmpty() || "config.json" !in paths) {
            throw IllegalArgumentException("The manifest must include config.json")
        }
        if ("tokenizer.json" !in paths && "tokenizer.model" !in paths) {
            throw IllegalArgumentException(
                "The manifest must include tokenizer.json or tokenizer.model",
            )
        }

        return InstallRequest(
            modelId = modelId,
            revision = revision,
            files = files,
            maxTotalBytes = maxTotalBytes,
            overwrite = overwrite,
        )
    }

    private fun exactLong(value: Any?, field: String): Long {
        if (value !is Number) {
            throw IllegalArgumentException("$field must be a number")
        }
        return try {
            BigDecimal(value.toString()).longValueExact()
        } catch (error: RuntimeException) {
            throw IllegalArgumentException("$field must be an exact 64-bit integer", error)
        }
    }

    private fun validateRelativePath(value: String, field: String) {
        val windowsAbsolute = value.length >= 3 &&
            value[0].isLetter() && value[1] == ':' && value[2] == '/'
        if (
            value.isEmpty() ||
            value.startsWith('/') ||
            windowsAbsolute ||
            value.contains('\\') ||
            value.contains('\u0000') ||
            value.split('/').any { it.isEmpty() || it == "." || it == ".." }
        ) {
            throw IllegalArgumentException(
                "$field must be a nonempty relative path without traversal or backslashes",
            )
        }
    }

    private fun validateHttpsUrl(value: String, field: String): URI {
        val uri = try {
            URI(value)
        } catch (error: Exception) {
            throw IllegalArgumentException("$field must be a valid HTTPS URL", error)
        }
        if (!uri.scheme.equals("https", ignoreCase = true) || uri.host.isNullOrEmpty()) {
            throw IllegalArgumentException("$field must be an HTTPS URL")
        }
        return uri
    }

    private fun download(
        file: ModelFile,
        destination: Path,
        completedBytes: Long,
        maxTotalBytes: Long,
        modelId: String,
        progress: (Map<String, Any?>) -> Unit,
    ) {
        var currentUrl = file.url
        var redirectCount = 0

        while (true) {
            throwIfCancelled(modelId)
            val connection = currentUrl.toURL().openConnection() as HttpURLConnection
            registerConnection(modelId, connection)
            try {
                connection.requestMethod = "GET"
                connection.instanceFollowRedirects = false
                connection.useCaches = false
                connection.connectTimeout = 30_000
                connection.readTimeout = 60_000
                connection.setRequestProperty("Accept-Encoding", "identity")

                val responseCode = connection.responseCode
                if (responseCode in REDIRECT_RESPONSES) {
                    if (redirectCount == MAX_REDIRECTS) {
                        throw IOException("Too many redirects while downloading ${file.path}")
                    }
                    val location = connection.getHeaderField("Location")
                        ?: throw IOException("Redirect for ${file.path} has no Location header")
                    currentUrl = validateHttpsUrl(currentUrl.resolve(location).toString(), "Redirect URL")
                    redirectCount += 1
                    continue
                }
                if (responseCode != HttpURLConnection.HTTP_OK) {
                    throw IOException("Download of ${file.path} returned HTTP $responseCode")
                }
                if (connection.contentLengthLong >= 0 && connection.contentLengthLong != file.sizeBytes) {
                    throw IOException("Unexpected Content-Length for ${file.path}")
                }

                Files.createDirectories(destination.parent)
                val digest = MessageDigest.getInstance("SHA-256")
                var receivedBytes = 0L
                emit(progress, modelId, file.path, 0, file.sizeBytes, "downloading")

                connection.inputStream.use { input ->
                    Files.newOutputStream(
                        destination,
                        StandardOpenOption.CREATE_NEW,
                        StandardOpenOption.WRITE,
                    ).use { output ->
                        val buffer = ByteArray(BUFFER_SIZE)
                        while (true) {
                            throwIfCancelled(modelId)
                            val count = input.read(buffer)
                            throwIfCancelled(modelId)
                            if (count < 0) break
                            if (count == 0) continue

                            receivedBytes += count
                            if (receivedBytes > file.sizeBytes) {
                                throw IOException("Downloaded data exceeds the manifest size for ${file.path}")
                            }
                            if (completedBytes + receivedBytes > maxTotalBytes ||
                                completedBytes + receivedBytes > HARD_MAX_TOTAL_BYTES
                            ) {
                                throw IOException("Download exceeds the total model size limit")
                            }

                            digest.update(buffer, 0, count)
                            output.write(buffer, 0, count)
                            emit(
                                progress,
                                modelId,
                                file.path,
                                receivedBytes,
                                file.sizeBytes,
                                "downloading",
                            )
                        }
                    }
                }

                if (receivedBytes != file.sizeBytes) {
                    throw IOException(
                        "Size mismatch for ${file.path}: expected ${file.sizeBytes}, got $receivedBytes",
                    )
                }
                val actualDigest = hex(digest.digest())
                if (!actualDigest.equals(file.sha256)) {
                    throw IOException("SHA-256 mismatch for ${file.path}")
                }
                emit(
                    progress,
                    modelId,
                    file.path,
                    receivedBytes,
                    file.sizeBytes,
                    "completed",
                )
                return
            } finally {
                registerConnection(modelId, null)
                connection.disconnect()
            }
        }
    }

    private fun verifyExisting(path: Path, file: ModelFile, modelId: String) {
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            throw IOException("Existing model is missing ${file.path}")
        }
        val actualSize = Files.size(path)
        if (actualSize != file.sizeBytes) {
            throw IOException(
                "Existing size mismatch for ${file.path}: expected ${file.sizeBytes}, got $actualSize",
            )
        }

        val digest = MessageDigest.getInstance("SHA-256")
        Files.newInputStream(path, StandardOpenOption.READ).use { input ->
            val buffer = ByteArray(BUFFER_SIZE)
            while (true) {
                throwIfCancelled(modelId)
                val count = input.read(buffer)
                throwIfCancelled(modelId)
                if (count < 0) break
                if (count > 0) digest.update(buffer, 0, count)
            }
        }
        if (hex(digest.digest()) != file.sha256) {
            throw IOException("Existing SHA-256 mismatch for ${file.path}; set overwrite to reinstall")
        }
    }

    private fun publish(staging: Path, directory: Path) {
        val hadExisting = Files.exists(directory, LinkOption.NOFOLLOW_LINKS)
        val backup = directory.resolveSibling(".${directory.fileName}.backup-${UUID.randomUUID()}")

        if (hadExisting) {
            Files.move(directory, backup, StandardCopyOption.ATOMIC_MOVE)
        }
        try {
            Files.move(staging, directory, StandardCopyOption.ATOMIC_MOVE)
        } catch (error: Throwable) {
            if (hadExisting) {
                try {
                    Files.move(backup, directory, StandardCopyOption.ATOMIC_MOVE)
                } catch (rollbackError: Throwable) {
                    error.addSuppressed(rollbackError)
                }
            }
            throw error
        }

        if (hadExisting) {
            deleteRecursively(backup)
        }
    }

    private fun deleteRecursively(path: Path) {
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return
        if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
            Files.newDirectoryStream(path).use { entries ->
                for (entry in entries) {
                    deleteRecursively(entry)
                }
            }
        }
        Files.deleteIfExists(path)
    }

    private fun emit(
        progress: (Map<String, Any?>) -> Unit,
        modelId: String,
        filePath: String,
        receivedBytes: Long,
        totalBytes: Long,
        state: String,
    ) {
        progress(
            mapOf(
                "operation" to "install",
                "modelId" to modelId,
                "filePath" to filePath,
                "receivedBytes" to receivedBytes,
                "totalBytes" to totalBytes,
                "state" to state,
            ),
        )
    }

    private fun result(request: InstallRequest, directory: Path): Map<String, Any?> = mapOf(
        "modelId" to request.modelId,
        "revision" to request.revision,
        "directory" to directory.toString(),
        "sizeBytes" to request.files.sumOf { it.sizeBytes },
    )

    private fun hex(bytes: ByteArray): String {
        val digits = "0123456789abcdef"
        val result = CharArray(bytes.size * 2)
        for (index in bytes.indices) {
            val value = bytes[index].toInt() and 0xff
            result[index * 2] = digits[value ushr 4]
            result[index * 2 + 1] = digits[value and 0x0f]
        }
        return String(result)
    }

    private val REDIRECT_RESPONSES = setOf(301, 302, 303, 307, 308)

    private data class ModelFile(
        val path: String,
        val url: URI,
        val sizeBytes: Long,
        val sha256: String,
    )

    private data class InstallRequest(
        val modelId: String,
        val revision: String,
        val files: List<ModelFile>,
        val maxTotalBytes: Long,
        val overwrite: Boolean,
    )
}
