import CryptoKit
import Foundation

public final class VisionInstaller: @unchecked Sendable {
  private let fileManager = FileManager.default
  private let modelDirectory: URL
  private let modelURL: URL
  private let metadataURL: URL
  private let lifecycleLock = NSLock()
  private var installationActive = false
  private var cancellationRequested = false
  private var activeDownload: VisionDownloadDelegate?

  public init() throws {
    guard let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      throw VisionFailure("E_INSTALL_DIRECTORY", "Application Support is unavailable.")
    }
    modelDirectory = support
      .appendingPathComponent("TensorFoldVision/models", isDirectory: true)
      .appendingPathComponent(VisionModel.id, isDirectory: true)
      .appendingPathComponent(VisionModel.revision, isDirectory: true)
    modelURL = modelDirectory.appendingPathComponent(VisionModel.fileName)
    metadataURL = modelDirectory.appendingPathComponent("installation.json")
  }

  public func installedModelPath() -> String? {
    guard isRegularFile(modelURL), fileManager.fileExists(atPath: metadataURL.path) else { return nil }
    guard let attributes = try? fileManager.attributesOfItem(atPath: modelURL.path),
          let size = attributes[.size] as? NSNumber,
          size.int64Value == VisionModel.sizeBytes else { return nil }
    return modelURL.path
  }

  public func verifiedModelPath() throws -> String {
    guard installedModelPath() != nil else {
      throw VisionFailure("E_MODEL_NOT_INSTALLED", "SmolVLM2-500M is not installed.")
    }
    try verifyMetadata()
    try verifyFile(modelURL)
    return modelURL.path
  }

  public func cancelInstall() {
    lifecycleLock.lock()
    if installationActive {
      cancellationRequested = true
    }
    let download = activeDownload
    lifecycleLock.unlock()
    download?.cancel()
  }

  public func install(progress: @escaping (Int64) -> Void) throws {
    lifecycleLock.lock()
    if installationActive {
      lifecycleLock.unlock()
      throw VisionFailure("E_INSTALL_BUSY", "A model installation is already active.")
    }
    installationActive = true
    cancellationRequested = false
    lifecycleLock.unlock()
    defer {
      lifecycleLock.lock()
      installationActive = false
      activeDownload = nil
      lifecycleLock.unlock()
    }
    try installSerialized(progress: progress)
  }

  private func installSerialized(progress: @escaping (Int64) -> Void) throws {
    try throwIfCancelled()
    if installedModelPath() != nil {
      do {
        try verifyMetadata()
        try verifyFile(modelURL)
        try throwIfCancelled()
        progress(VisionModel.sizeBytes)
        return
      } catch {
        lifecycleLock.lock()
        let cancelled = cancellationRequested
        lifecycleLock.unlock()
        if cancelled { throw cancellationFailure(error) }
        // The verified staging directory replaces corrupt or incomplete state below.
      }
    }

    let parent = modelDirectory.deletingLastPathComponent()
    do {
      try fileManager.createDirectory(at: parent, withIntermediateDirectories: true)
    } catch {
      throw VisionFailure("E_INSTALL_DIRECTORY", "Could not create the model installation directory.", underlying: error)
    }
    let values = try parent.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    let available = Int64(values.volumeAvailableCapacityForImportantUsage ?? 0)
    let required = VisionModel.sizeBytes + 64 * 1024 * 1024
    if available < required {
      throw VisionFailure("E_INSTALL_SPACE", "The download needs \(required) free bytes; only \(available) are available.")
    }

    let staging = parent.appendingPathComponent(".\(VisionModel.revision).staging-\(UUID().uuidString)", isDirectory: true)
    do {
      try fileManager.createDirectory(at: staging, withIntermediateDirectories: false)
    } catch {
      throw VisionFailure("E_INSTALL_DIRECTORY", "Could not create an isolated staging directory.", underlying: error)
    }
    defer {
      if fileManager.fileExists(atPath: staging.path) { try? fileManager.removeItem(at: staging) }
    }

    do {
      progress(0)
      try download(to: staging.appendingPathComponent(VisionModel.fileName), progress: progress)
      try throwIfCancelled()
      try verifyFile(staging.appendingPathComponent(VisionModel.fileName))
      try throwIfCancelled()
      try writeMetadata(staging.appendingPathComponent("installation.json"))
      try throwIfCancelled()
      try publish(staging)
      progress(VisionModel.sizeBytes)
    } catch let failure as VisionFailure {
      throw failure
    } catch {
      throw VisionFailure("E_INSTALL", error.localizedDescription, underlying: error)
    }
  }

  private func isRegularFile(_ url: URL) -> Bool {
    guard let attributes = try? fileManager.attributesOfItem(atPath: url.path),
          let type = attributes[.type] as? FileAttributeType else { return false }
    return type == .typeRegular
  }

  private func verifyMetadata() throws {
    do {
      let data = try Data(contentsOf: metadataURL, options: [.uncached])
      guard let metadata = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            metadata["modelId"] as? String == VisionModel.id,
            metadata["installationId"] as? String == VisionModel.revision,
            metadata["file"] as? String == VisionModel.fileName,
            (metadata["sizeBytes"] as? NSNumber)?.int64Value == VisionModel.sizeBytes,
            metadata["sha256"] as? String == VisionModel.sha256 else {
        throw VisionFailure("E_MODEL_INTEGRITY", "The persisted installation metadata is invalid.")
      }
    } catch let failure as VisionFailure {
      throw failure
    } catch {
      throw VisionFailure("E_MODEL_INTEGRITY", "The persisted installation metadata is unreadable.", underlying: error)
    }
  }

  private func verifyFile(_ url: URL) throws {
    guard isRegularFile(url),
          let attributes = try? fileManager.attributesOfItem(atPath: url.path),
          let size = attributes[.size] as? NSNumber,
          size.int64Value == VisionModel.sizeBytes else {
      throw VisionFailure("E_MODEL_INTEGRITY", "The model size or file type does not match the pinned revision.")
    }
    let digest = try sha256(url)
    if digest != VisionModel.sha256 {
      throw VisionFailure("E_MODEL_INTEGRITY", "The model SHA-256 does not match the pinned revision.")
    }
  }

  private func sha256(_ url: URL) throws -> String {
    guard let input = InputStream(url: url) else {
      throw VisionFailure("E_MODEL_INTEGRITY", "The model file cannot be opened.")
    }
    input.open()
    defer { input.close() }
    var digest = SHA256()
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      let count = buffer.withUnsafeMutableBufferPointer { pointer in
        input.read(pointer.baseAddress!, maxLength: pointer.count)
      }
      if count == 0 { break }
      if count < 0 {
        throw VisionFailure("E_MODEL_INTEGRITY", "The model file could not be read completely.", underlying: input.streamError)
      }
      buffer.withUnsafeBufferPointer { pointer in
        digest.update(bufferPointer: UnsafeRawBufferPointer(start: pointer.baseAddress, count: count))
      }
    }
    return digest.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private func writeMetadata(_ url: URL) throws {
    let metadata: [String: Any] = [
      "modelId": VisionModel.id,
      "installationId": VisionModel.revision,
      "file": VisionModel.fileName,
      "sizeBytes": NSNumber(value: VisionModel.sizeBytes),
      "sha256": VisionModel.sha256,
      "installedAt": NSNumber(value: Date().timeIntervalSince1970),
    ]
    let data = try JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys])
    try data.write(to: url, options: [.atomic])
  }

  private func download(to destination: URL, progress: @escaping (Int64) -> Void) throws {
    let semaphore = DispatchSemaphore(value: 0)
    let delegate = VisionDownloadDelegate(destination: destination, progress: progress, semaphore: semaphore)
    lifecycleLock.lock()
    activeDownload = delegate
    lifecycleLock.unlock()
    let configuration = URLSessionConfiguration.default
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 60
    configuration.timeoutIntervalForResource = 3600
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: queue)
    var request = URLRequest(url: VisionModel.downloadURL)
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    let task = session.downloadTask(with: request)
    delegate.start(task)
    do {
      try throwIfCancelled()
    } catch {
      delegate.cancel()
      session.invalidateAndCancel()
      lifecycleLock.lock()
      activeDownload = nil
      lifecycleLock.unlock()
      throw error
    }
    task.resume()
    semaphore.wait()
    lifecycleLock.lock()
    activeDownload = nil
    let cancelled = cancellationRequested
    lifecycleLock.unlock()
    session.invalidateAndCancel()
    switch delegate.result {
    case .success:
      return
    case .failure(let error):
      if cancelled { throw cancellationFailure(error) }
      throw VisionFailure("E_DOWNLOAD", error.localizedDescription, underlying: error)
    case .none:
      if cancelled { throw cancellationFailure() }
      throw VisionFailure("E_DOWNLOAD", "The model download ended without a result.")
    }
  }

  private func throwIfCancelled() throws {
    lifecycleLock.lock()
    let cancelled = cancellationRequested
    lifecycleLock.unlock()
    if cancelled { throw cancellationFailure() }
  }

  private func cancellationFailure(_ cause: Error? = nil) -> VisionFailure {
    VisionFailure("E_INSTALL_CANCELLED", "Model installation was cancelled.", underlying: cause)
  }

  private func publish(_ staging: URL) throws {

    let parent = modelDirectory.deletingLastPathComponent()
    var backup: URL?
    do {
      if fileManager.fileExists(atPath: modelDirectory.path) {
        let candidate = parent.appendingPathComponent(".\(VisionModel.revision).backup-\(UUID().uuidString)", isDirectory: true)
        try fileManager.moveItem(at: modelDirectory, to: candidate)
        backup = candidate
      }
      try fileManager.moveItem(at: staging, to: modelDirectory)
      if let backup { try? fileManager.removeItem(at: backup) }
    } catch {
      if !fileManager.fileExists(atPath: modelDirectory.path), let backup {
        try? fileManager.moveItem(at: backup, to: modelDirectory)
      }
      throw VisionFailure("E_INSTALL_ATOMIC", "The staged model could not be published by atomic rename.", underlying: error)
    }
  }
}

private final class VisionDownloadDelegate: NSObject, URLSessionDownloadDelegate {
  private let destination: URL
  private let progress: (Int64) -> Void
  private let semaphore: DispatchSemaphore
  private let lock = NSLock()
  private var nextProgress: Int64 = 0
  private var storedResult: Result<URL, Error>?
  private var task: URLSessionDownloadTask?

  var result: Result<URL, Error>? {
    lock.lock()
    defer { lock.unlock() }
    return storedResult
  }

  init(destination: URL, progress: @escaping (Int64) -> Void, semaphore: DispatchSemaphore) {
    self.destination = destination
    self.progress = progress
    self.semaphore = semaphore
  }
  func start(_ task: URLSessionDownloadTask) {
    lock.lock()
    self.task = task
    lock.unlock()
  }

  func cancel() {
    lock.lock()
    let task = self.task
    let completed = storedResult != nil
    lock.unlock()
    if completed { return }
    finish(.failure(VisionFailure("E_INSTALL_CANCELLED", "Model installation was cancelled.")))
    task?.cancel()
  }

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64,
    totalBytesExpectedToWrite: Int64
  ) {
    if totalBytesWritten > VisionModel.sizeBytes {
      downloadTask.cancel()
      return
    }
    if totalBytesWritten >= nextProgress {
      progress(totalBytesWritten)
      nextProgress = totalBytesWritten + 1024 * 1024
    }
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    do {
      guard let response = downloadTask.response as? HTTPURLResponse, response.statusCode == 200 else {
        throw NSError(domain: "TensorFoldVision", code: 1, userInfo: [NSLocalizedDescriptionKey: "The model download did not return HTTP 200."])
      }
      if response.expectedContentLength >= 0 && response.expectedContentLength != VisionModel.sizeBytes {
        throw NSError(domain: "TensorFoldVision", code: 2, userInfo: [NSLocalizedDescriptionKey: "The server returned an unexpected model Content-Length."])
      }
      try FileManager.default.moveItem(at: location, to: destination)
    } catch {
      finish(.failure(error))
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let error {
      finish(.failure(error))
    } else {
      finish(.success(destination))
    }
  }
  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    guard request.url?.scheme?.lowercased() == "https" else {
      task.cancel()
      completionHandler(nil)
      return
    }
    completionHandler(request)
  }

  private func finish(_ value: Result<URL, Error>) {
    lock.lock()
    if storedResult != nil {
      lock.unlock()
      return
    }
    storedResult = value
    lock.unlock()
    semaphore.signal()
  }
}
