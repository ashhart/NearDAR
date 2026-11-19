package expo.modules.tensorfoldvision

internal object VisionModel {
  const val ID = "SmolVLM2-500M"
  const val REVISION = "8dbba113efdeca80107357d76ab00fc0c71048fd"
  const val FILE_NAME = "SmolVLM2-500M.litertlm"
  const val SIZE_BYTES = 363_085_824L
  const val SHA256 = "7b432bbc0a5c54ba15ecb2f039a7711c1cfb1fe38badec01397a076b5043f74e"
  const val DOWNLOAD_URL =
    "https://huggingface.co/litert-community/SmolVLM2-500M/resolve/$REVISION/$FILE_NAME"
  const val RUNTIME_VERSION = "0.19.1"
  const val RECOMMENDED_FREE_MEMORY_BYTES = 1_500_000_000L
  const val MAX_IMAGE_BYTES = 20L * 1024L * 1024L
  const val QUERY_TIMEOUT_MILLIS = 90_000L
}

internal class VisionException(
  val code: String,
  override val message: String,
  cause: Throwable? = null,
) : Exception(message, cause)
