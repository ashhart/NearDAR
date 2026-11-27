import Foundation
import ImageIO
import Metal
import UIKit
import os

public actor VisionController {
  private let installer: VisionInstaller?
  private let installerFailure: VisionFailure?
  private let statusStore: VisionStatusStore
  private var engine: Engine?
  private var activeRequest: ActiveRequest?
  private var unloadAfterRequest = false
  private var memoryObserver: NSObjectProtocol?

  public init(emit: @escaping @Sendable ([String: Any]) -> Void) {
    statusStore = VisionStatusStore(emit: emit)
    do {
      installer = try VisionInstaller()
      installerFailure = nil
    } catch {
      installer = nil
      installerFailure = VisionFailure.wrap(error, code: "E_INSTALL_DIRECTORY", fallback: "Model storage is unavailable.")
    }
    memoryObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didReceiveMemoryWarningNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      Task { await self?.releaseForMemoryPressure() }
    }
  }

  deinit {
    if let memoryObserver { NotificationCenter.default.removeObserver(memoryObserver) }
  }

  public func capabilities() -> [String: Any] {
    let metalAvailable = MTLCreateSystemDefaultDevice() != nil
    return [
      "available": metalAvailable,
      "platform": "ios",
      "backend": "metal",
      "vision": true,
      "installSizeBytes": NSNumber(value: VisionModel.sizeBytes),
      "reason": metalAvailable
        ? "LiteRT-LM and a Metal device are present. Model initialization is confirmed by loadModel."
        : "A Metal device is required by this build's LiteRT-LM configuration.",
      "modelId": VisionModel.id,
      "revision": VisionModel.revision,
      "runtime": "LiteRT-LM",
      "runtimeVersion": VisionModel.runtimeVersion,
      "accelerator": "metal",
      "recommendedFreeMemoryBytes": NSNumber(value: VisionModel.recommendedFreeMemoryBytes),
      "supportsCancellation": true,
      "loaded": engine != nil,
    ]
  }

  public func status() -> [String: Any] {
    if let value = statusStore.value { return value }
    if engine != nil { return Self.baseStatus("ready", progress: 1) }
    if let installer, installer.installedModelPath() != nil { return Self.baseStatus("installed") }
    return Self.baseStatus("not-installed", message: installerFailure?.message, includeInstallation: false)
  }

  public func install(modelId: String?) async throws -> [String: Any] {
    if let modelId, modelId != VisionModel.id {
      throw VisionFailure("E_MODEL_ID", "Only \(VisionModel.id) is supported.")
    }
    if engine != nil { return status() }
    guard let installer else { throw installerFailure ?? VisionFailure("E_INSTALL_DIRECTORY", "Model storage is unavailable.") }
    do {
      try installer.install { [statusStore] received in
        let progress = Double(received) / Double(VisionModel.sizeBytes)
        statusStore.set(Self.baseStatus(
          "downloading",
          progress: progress,
          downloadedBytes: received,
          totalBytes: VisionModel.sizeBytes
        ))
      }
      let result = Self.baseStatus(
        "installed",
        progress: 1,
        downloadedBytes: VisionModel.sizeBytes,
        totalBytes: VisionModel.sizeBytes
      )
      statusStore.clear()
      statusStore.emit("status", status: result)
      return result
    } catch {
      let failure = VisionFailure.wrap(error, code: "E_INSTALL", fallback: "Model installation failed.")
      if failure.code == "E_INSTALL_CANCELLED" {
        statusStore.clear()
        statusStore.emit("status", status: status(), message: failure.message)
      } else {
        statusStore.set(Self.baseStatus("error", message: failure.message))
      }
      throw failure
    }
  }

  public func load(installationId: String?) async throws -> [String: Any] {
    if let installationId, installationId != VisionModel.revision {
      throw VisionFailure("E_MODEL_NOT_INSTALLED", "The requested installation is not the pinned model revision.")
    }
    if activeRequest != nil { throw VisionFailure("E_VISION_BUSY", "Finish or cancel the active scene query before loading.") }
    if engine != nil { return status() }
    guard let installer else { throw installerFailure ?? VisionFailure("E_MODEL_NOT_INSTALLED", "Model storage is unavailable.") }
    statusStore.set(Self.baseStatus("loading", progress: 0))
    do {
      let availableMemory = UInt64(os_proc_available_memory())
      if availableMemory < VisionModel.recommendedFreeMemoryBytes {
        throw VisionFailure(
          "E_MODEL_RESOURCES",
          "Model loading requires \(VisionModel.recommendedFreeMemoryBytes) currently available bytes; iOS reports \(availableMemory)."
        )
      }
      let path = try installer.verifiedModelPath()
      guard MTLCreateSystemDefaultDevice() != nil else {
        throw VisionFailure("E_MODEL_RESOURCES", "A Metal device is required by this build's LiteRT-LM configuration.")
      }
      let cacheDirectory = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        .appendingPathComponent("TensorFoldVision/runtime", isDirectory: true)
      try FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
      let config = try EngineConfig(
        modelPath: path,
        backend: .gpu,
        visionBackend: .gpu,
        maxNumTokens: 2048,
        cacheDir: cacheDirectory.path
      )
      let candidate = Engine(engineConfig: config)
      try await candidate.initialize()
      engine = candidate
      let result = Self.baseStatus("ready", progress: 1)
      statusStore.clear()
      statusStore.emit("status", status: result)
      return result
    } catch {
      engine = nil
      let failure = VisionFailure.wrap(error, code: "E_MODEL_LOAD", fallback: "LiteRT-LM could not initialize the model on this device.")
      statusStore.set(Self.baseStatus("error", message: failure.message))
      throw failure
    }
  }

  public func unload() async throws {
    unloadAfterRequest = true
    if let activeRequest { try requestTermination(requestId: activeRequest.requestId, termination: .cancelled) }
    for _ in 0..<500 {
      if activeRequest == nil { break }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    guard activeRequest == nil else {
      throw VisionFailure("E_MODEL_UNLOAD", "The active scene query did not stop within five seconds.")
    }
    statusStore.set(Self.baseStatus("unloading", progress: 0))
    engine = nil
    unloadAfterRequest = false
    statusStore.clear()
    statusStore.emit("status", status: status())
  }

  public func describe(_ input: [String: Any]) async throws -> String {
    let request = try Self.parseRequest(input)
    guard let loadedEngine = engine else {
      throw VisionFailure("E_MODEL_NOT_READY", "Call loadModel before requesting a scene description.")
    }
    guard activeRequest == nil else { throw VisionFailure("E_VISION_BUSY", "Another scene query is already running.") }
    var image: SceneImage?
    var completionError: VisionFailure?
    var generated = ""
    do {
      image = try resolveImage(request)
      let sampler = try SamplerConfig(topK: 40, topP: 0.9, temperature: 0.2, seed: 0)
      let config = ConversationConfig(samplerConfig: sampler, automaticToolCalling: false)
      let conversation = try await loadedEngine.createConversation(with: config)
      activeRequest = ActiveRequest(requestId: request.requestId, conversation: conversation)
      let timeoutTask = Task { [weak self] in
        do {
          try await Task.sleep(nanoseconds: VisionModel.queryTimeoutNanoseconds)
          await self?.expire(requestId: request.requestId)
        } catch {
          return
        }
      }
      activeRequest?.timeoutTask = timeoutTask
      statusStore.emit("started", status: status(), requestId: request.requestId)
      let contents = [Content.imageFile(image!.path), Content.text(request.prompt)]
      let stream = conversation.sendMessageStream(Message(contents: contents), maxOutputTokens: request.maxTokens)
      for try await chunk in stream {
        let delta = chunk.toString
        if !delta.isEmpty {
          generated += delta
          statusStore.emit("token", status: nil, requestId: request.requestId, message: nil, delta: delta, text: generated)
        }
      }
      if let termination = activeRequest?.termination { throw Self.terminationFailure(termination) }
    } catch {
      completionError = VisionFailure.wrap(error, code: "E_VISION_INFERENCE", fallback: "LiteRT-LM scene generation failed.")
      if let termination = activeRequest?.termination { completionError = Self.terminationFailure(termination) }
    }

    let requestId = request.requestId
    let termination = activeRequest?.termination
    activeRequest?.timeoutTask?.cancel()
    activeRequest = nil
    if let ownedURL = image?.ownedURL { try? FileManager.default.removeItem(at: ownedURL) }
    if unloadAfterRequest {
      engine = nil
      unloadAfterRequest = false
      statusStore.clear()
      statusStore.emit("status", status: status())
    }

    if let completionError {
      let event = completionError.code == "E_VISION_CANCELLED" ? "cancelled" : "error"
      statusStore.emit(event, status: status(), requestId: requestId, message: completionError.message)
      throw completionError
    }
    if let termination { throw Self.terminationFailure(termination) }
    statusStore.emit("completed", status: status(), requestId: requestId)
    return generated
  }

  public func cancel(requestId: String) throws {
    if requestId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return }
    try requestTermination(requestId: requestId, termination: .cancelled)
  }
  public nonisolated func cancelInstall() {
    installer?.cancelInstall()
  }


  public nonisolated func shutdown() {
    Task { try? await unload() }
  }

  private func expire(requestId: String) {
    try? requestTermination(requestId: requestId, termination: .timedOut)
  }

  private func releaseForMemoryPressure() async {
    if engine != nil { try? await unload() }
  }

  private func requestTermination(requestId: String, termination: Termination) throws {
    guard let activeRequest, activeRequest.requestId == requestId, activeRequest.termination == nil else { return }
    activeRequest.termination = termination
    try activeRequest.conversation.cancel()
  }

  private func resolveImage(_ request: SceneRequest) throws -> SceneImage {
    if let encoded = request.imageBase64 {
      let maximumEncodedLength = ((VisionModel.maxImageBytes + 2) / 3) * 4 + 1024
      if encoded.utf8.count > maximumEncodedLength {
        throw VisionFailure("E_IMAGE_SIZE", "The base64 image exceeds the 20 MiB input limit.")
      }
      guard let data = Data(base64Encoded: encoded, options: []) else {
        throw VisionFailure("E_IMAGE_FORMAT", "imageBase64 is not valid base64.")
      }
      if data.isEmpty || Int64(data.count) > VisionModel.maxImageBytes {
        throw VisionFailure("E_IMAGE_SIZE", "The decoded image must contain 1 through 20 MiB of data.")
      }
      let directory = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        .appendingPathComponent("TensorFoldVision/captures", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let url = directory.appendingPathComponent("\(UUID().uuidString).image")
      do {
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        try validateImage(url)
        return SceneImage(path: url.path, ownedURL: url)
      } catch {
        try? FileManager.default.removeItem(at: url)
        throw error
      }
    }

    let supplied = request.temporaryImagePath!
    let resolved: URL
    if supplied.hasPrefix("file://"), let fileURL = URL(string: supplied), fileURL.isFileURL {
      resolved = fileURL
    } else {
      resolved = URL(fileURLWithPath: supplied)
    }
    let url = resolved.standardizedFileURL.resolvingSymlinksInPath()
    let rootURLs = [
      URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true).standardizedFileURL.resolvingSymlinksInPath(),
      FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].standardizedFileURL.resolvingSymlinksInPath(),
    ]
    guard rootURLs.contains(where: { url.pathComponents.starts(with: $0.pathComponents) }) else {
      throw VisionFailure("E_IMAGE_PATH", "The image must be inside the app's temporary or cache directories.")
    }
    try validateImage(url)
    return SceneImage(path: url.path, ownedURL: nil)
  }

  private func validateImage(_ url: URL) throws {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
          let type = attributes[.type] as? FileAttributeType,
          type == .typeRegular,
          let size = attributes[.size] as? NSNumber,
          size.int64Value > 0,
          size.int64Value <= VisionModel.maxImageBytes else {
      throw VisionFailure("E_IMAGE_SIZE", "The image must be a regular file containing 1 through 20 MiB.")
    }
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
          let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
          width.intValue > 0,
          height.intValue > 0 else {
      throw VisionFailure("E_IMAGE_FORMAT", "ImageIO could not decode the image header.")
    }
  }

  private static func baseStatus(
    _ state: String,
    progress: Double? = nil,
    downloadedBytes: Int64? = nil,
    totalBytes: Int64? = nil,
    message: String? = nil,
    includeInstallation: Bool = true
  ) -> [String: Any] {
    var result: [String: Any] = [
      "state": state,
      "modelId": VisionModel.id,
      "revision": VisionModel.revision,
    ]
    if includeInstallation { result["installationId"] = VisionModel.revision }
    if let progress { result["progress"] = progress }
    if let downloadedBytes { result["downloadedBytes"] = NSNumber(value: downloadedBytes) }
    if let totalBytes { result["totalBytes"] = NSNumber(value: totalBytes) }
    if let message { result["message"] = message }
    return result
  }

  private static func parseRequest(_ input: [String: Any]) throws -> SceneRequest {
    guard let requestId = input["requestId"] as? String,
          !requestId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          let prompt = input["prompt"] as? String,
          !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw VisionFailure("E_VISION_REQUEST", "requestId and prompt must not be empty.")
    }
    if prompt.utf8.count > 8192 {
      throw VisionFailure("E_VISION_REQUEST", "prompt must not exceed 8192 UTF-8 bytes.")
    }
    guard !(input["maxTokens"] is Bool),
          let number = input["maxTokens"] as? NSNumber,
          number.doubleValue.rounded() == number.doubleValue else {
      throw VisionFailure("E_VISION_REQUEST", "maxTokens must be an integer from 1 through 256.")
    }
    let maxTokens = number.intValue
    if maxTokens < 1 || maxTokens > 256 {
      throw VisionFailure("E_VISION_REQUEST", "maxTokens must be an integer from 1 through 256.")
    }
    let base64 = input["imageBase64"] as? String
    let temporaryPath = input["temporaryImagePath"] as? String
    if (base64?.isEmpty ?? true) == (temporaryPath?.isEmpty ?? true) {
      throw VisionFailure("E_IMAGE_REQUIRED", "Supply exactly one of imageBase64 or temporaryImagePath.")
    }
    return SceneRequest(
      requestId: requestId,
      prompt: prompt,
      maxTokens: maxTokens,
      imageBase64: base64,
      temporaryImagePath: temporaryPath
    )
  }

  private static func terminationFailure(_ termination: Termination) -> VisionFailure {
    switch termination {
    case .cancelled:
      return VisionFailure("E_VISION_CANCELLED", "Scene generation was cancelled.")
    case .timedOut:
      return VisionFailure("E_VISION_TIMEOUT", "Scene generation exceeded 90 seconds and was cancelled.")
    }
  }

  private struct SceneRequest {
    let requestId: String
    let prompt: String
    let maxTokens: Int
    let imageBase64: String?
    let temporaryImagePath: String?
  }
  private struct SceneImage {
    let path: String
    let ownedURL: URL?
  }
  private final class ActiveRequest {
    let requestId: String
    let conversation: Conversation
    var termination: Termination?
    var timeoutTask: Task<Void, Never>?

    init(requestId: String, conversation: Conversation) {
      self.requestId = requestId
      self.conversation = conversation
    }
  }
  private enum Termination { case cancelled, timedOut }
}


private final class VisionStatusStore: @unchecked Sendable {
  private let lock = NSLock()
  private let emitClosure: @Sendable ([String: Any]) -> Void
  private(set) var storedValue: [String: Any]?

  var value: [String: Any]? {
    lock.lock()
    defer { lock.unlock() }
    return storedValue
  }

  init(emit: @escaping @Sendable ([String: Any]) -> Void) {
    emitClosure = emit
  }

  func set(_ status: [String: Any]) {
    lock.lock()
    storedValue = status
    lock.unlock()
    emit("status", status: status)
  }

  func clear() {
    lock.lock()
    storedValue = nil
    lock.unlock()
  }

  func emit(
    _ type: String,
    status: [String: Any]? = nil,
    requestId: String? = nil,
    message: String? = nil,
    delta: String? = nil,
    text: String? = nil
  ) {
    var event: [String: Any] = ["type": type]
    if let status { event["status"] = status }
    if let requestId { event["requestId"] = requestId }
    if let message { event["message"] = message }
    if let delta { event["delta"] = delta }
    if let text { event["text"] = text }
    emitClosure(event)
  }
}
