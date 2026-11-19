import Foundation

public enum VisionModel {
  public static let id = "SmolVLM2-500M"
  public static let revision = "8dbba113efdeca80107357d76ab00fc0c71048fd"
  public static let fileName = "SmolVLM2-500M.litertlm"
  public static let sizeBytes: Int64 = 363_085_824
  public static let sha256 = "7b432bbc0a5c54ba15ecb2f039a7711c1cfb1fe38badec01397a076b5043f74e"
  public static let downloadURL = URL(string: "https://huggingface.co/litert-community/SmolVLM2-500M/resolve/\(revision)/\(fileName)")!
  public static let runtimeVersion = "0.19.1"
  public static let recommendedFreeMemoryBytes: UInt64 = 1_500_000_000
  public static let maxImageBytes: Int64 = 20 * 1024 * 1024
  public static let queryTimeoutNanoseconds: UInt64 = 90_000_000_000
}

public struct VisionFailure: Error {
  public let code: String
  public let message: String
  public let underlying: Error?

  public init(_ code: String, _ message: String, underlying: Error? = nil) {
    self.code = code
    self.message = message
    self.underlying = underlying
  }

  public static func wrap(_ error: Error, code: String, fallback: String) -> VisionFailure {
    if let failure = error as? VisionFailure { return failure }
    let description = error.localizedDescription
    return VisionFailure(code, description.isEmpty ? fallback : description, underlying: error)
  }
}
