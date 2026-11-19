import Foundation
import CryptoKit

public final class ModelInstaller {
    public static let shared = ModelInstaller()

    private static let defaultMaximumBytes: Int64 = 8 * 1024 * 1024 * 1024
    private static let hardMaximumBytes: Int64 = 16 * 1024 * 1024 * 1024

    private let installationLock = NSLock()
    private var installingModelIDs = Set<String>()
    private var cancelledModelIDs = Set<String>()
    private var activeTasks = [String: URLSessionDownloadTask]()

    public func install(
        _ input: [String: Any],
        progress: @escaping ([String: Any]) -> Void
    ) throws -> [String: Any] {
        let request = try parseRequest(input)

        installationLock.lock()
        let acquired = installingModelIDs.insert(request.modelId).inserted
        cancelledModelIDs.remove(request.modelId)
        installationLock.unlock()
        guard acquired else {
            throw ModelInstallerError("An installation for model \(request.modelId) is already in progress.")
        }
        defer {
            installationLock.lock()
            installingModelIDs.remove(request.modelId)
            cancelledModelIDs.remove(request.modelId)
            activeTasks.removeValue(forKey: request.modelId)
            installationLock.unlock()
        }

        let fileManager = FileManager.default
        guard let applicationSupport = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else {
            throw ModelInstallerError("Application Support is unavailable.")
        }

        let modelRoot = applicationSupport
            .appendingPathComponent("TensorFoldModels", isDirectory: true)
        let destination = modelRoot
            .appendingPathComponent(request.modelId, isDirectory: true)
            .appendingPathComponent(request.revision, isDirectory: true)
        let staging = destination.deletingLastPathComponent()
            .appendingPathComponent(".\(UUID().uuidString).staging", isDirectory: true)

        do {
            try fileManager.createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
        } catch {
            throw ModelInstallerError("Could not create the model directory: \(error.localizedDescription)")
        }

        if !request.overwrite, fileManager.fileExists(atPath: destination.path) {
            do {
                return try verifiedResult(
                    at: destination,
                    request: request,
                    progress: progress
                )
            } catch {
                // A complete staged download below replaces an incomplete or corrupt install.
            }
        }

        do {
            try fileManager.createDirectory(at: staging, withIntermediateDirectories: false)
        } catch {
            throw ModelInstallerError("Could not create a staging directory: \(error.localizedDescription)")
        }
        defer {
            if fileManager.fileExists(atPath: staging.path) {
                try? fileManager.removeItem(at: staging)
            }
        }

        for file in request.files {
            try checkCancelled(request.modelId)
            let fileURL = staging.appendingPathComponent(file.path)
            do {
                try fileManager.createDirectory(
                    at: fileURL.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
            } catch {
                throw ModelInstallerError("Could not create a directory for \(file.path): \(error.localizedDescription)")
            }

            report(progress, modelId: request.modelId, file: file, receivedBytes: 0, state: "started")
            try download(file, to: fileURL, modelId: request.modelId, progress: progress)
            try checkCancelled(request.modelId)
            report(
                progress,
                modelId: request.modelId,
                file: file,
                receivedBytes: file.size,
                state: "verifying"
            )
            try verify(file, at: fileURL, modelId: request.modelId)
            report(
                progress,
                modelId: request.modelId,
                file: file,
                receivedBytes: file.size,
                state: "completed"
            )
        }

        try checkCancelled(request.modelId)
        do {
            if fileManager.fileExists(atPath: destination.path) {
                _ = try fileManager.replaceItemAt(
                    destination,
                    withItemAt: staging,
                    backupItemName: nil,
                    options: []
                )
            } else {
                try fileManager.moveItem(at: staging, to: destination)
            }
        } catch {
            throw ModelInstallerError("Could not publish model \(request.modelId): \(error.localizedDescription)")
        }

        return [
            "modelId": request.modelId,
            "revision": request.revision,
            "directory": destination.path,
            "sizeBytes": request.totalSize
        ]
    }
    public func cancel(modelId: String) -> Bool {
        installationLock.lock()
        guard installingModelIDs.contains(modelId) else {
            installationLock.unlock()
            return false
        }
        cancelledModelIDs.insert(modelId)
        let task = activeTasks[modelId]
        installationLock.unlock()
        task?.cancel()
        return true
    }

    private func checkCancelled(_ modelId: String) throws {
        installationLock.lock()
        let cancelled = cancelledModelIDs.contains(modelId)
        installationLock.unlock()
        if cancelled { throw ModelInstallerError("Model installation cancelled.") }
    }

    private func registerTask(_ modelId: String, task: URLSessionDownloadTask?) {
        installationLock.lock()
        activeTasks[modelId] = task
        installationLock.unlock()
    }


    private func parseRequest(_ input: [String: Any]) throws -> InstallRequest {
        guard let modelId = input["modelId"] as? String, !modelId.isEmpty else {
            throw ModelInstallerError("modelId must be a nonempty string.")
        }
        guard let revision = input["revision"] as? String, !revision.isEmpty else {
            throw ModelInstallerError("revision must be a nonempty string.")
        }
        try validateRelativePath(modelId, field: "modelId")
        try validateRelativePath(revision, field: "revision")

        guard let rawFiles = input["files"] as? [[String: Any]], !rawFiles.isEmpty else {
            throw ModelInstallerError("files must be a nonempty array of file descriptors.")
        }

        let requestedMaximum: Int64
        if let value = input["maxTotalBytes"] {
            requestedMaximum = try integerBytes(
                value,
                field: "maxTotalBytes",
                capAtHardMaximum: true
            )
        } else {
            requestedMaximum = ModelInstaller.defaultMaximumBytes
        }
        let maximumBytes = min(requestedMaximum, ModelInstaller.hardMaximumBytes)

        var files = [ManifestFile]()
        var paths = Set<String>()
        var totalSize: Int64 = 0
        files.reserveCapacity(rawFiles.count)

        for descriptor in rawFiles {
            guard let path = descriptor["path"] as? String, !path.isEmpty else {
                throw ModelInstallerError("Every file must have a nonempty string path.")
            }
            try validateRelativePath(path, field: "file path")
            guard paths.insert(path).inserted else {
                throw ModelInstallerError("The manifest contains duplicate file path \(path).")
            }

            guard let urlString = descriptor["url"] as? String,
                  let url = URL(string: urlString),
                  url.scheme?.lowercased() == "https",
                  url.host != nil else {
                throw ModelInstallerError("The download URL for \(path) must be an HTTPS URL.")
            }
            guard let sizeValue = descriptor["size"] else {
                throw ModelInstallerError("A byte size is required for \(path).")
            }
            let size = try integerBytes(sizeValue, field: "size for \(path)", capAtHardMaximum: false)
            guard let digest = descriptor["sha256"] as? String,
                  digest.count >= 40,
                  digest.utf8.allSatisfy({ byte in
                      (48...57).contains(byte) || (97...102).contains(byte)
                  }) else {
                throw ModelInstallerError("A lowercase hexadecimal SHA256 digest is required for \(path).")
            }

            guard size <= ModelInstaller.hardMaximumBytes - totalSize else {
                throw ModelInstallerError("The manifest exceeds the 16 GiB hard size limit.")
            }
            totalSize += size
            guard totalSize <= maximumBytes else {
                throw ModelInstallerError("The manifest size \(totalSize) bytes exceeds the allowed total of \(maximumBytes) bytes.")
            }
            files.append(ManifestFile(path: path, url: url, size: size, sha256: digest))
        }

        guard paths.contains("config.json") else {
            throw ModelInstallerError("The manifest must contain config.json.")
        }
        guard paths.contains("tokenizer.json") || paths.contains("tokenizer.model") else {
            throw ModelInstallerError("The manifest must contain tokenizer.json or tokenizer.model.")
        }

        let overwrite: Bool
        if let value = input["overwrite"] {
            guard let flag = value as? Bool else {
                throw ModelInstallerError("overwrite must be a Boolean value.")
            }
            overwrite = flag
        } else {
            overwrite = false
        }

        return InstallRequest(
            modelId: modelId,
            revision: revision,
            files: files,
            overwrite: overwrite,
            totalSize: totalSize
        )
    }

    private func validateRelativePath(_ path: String, field: String) throws {
        guard !path.hasPrefix("/"), !path.contains("\\"), !path.contains("\0") else {
            throw ModelInstallerError("The \(field) \(path) must be a relative path without backslashes.")
        }
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.isEmpty,
              components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw ModelInstallerError("The \(field) \(path) contains an invalid path component.")
        }
    }

    private func integerBytes(
        _ value: Any,
        field: String,
        capAtHardMaximum: Bool
    ) throws -> Int64 {
        guard !(value is Bool), let number = value as? NSNumber else {
            throw ModelInstallerError("The \(field) must be a nonnegative integer.")
        }
        let doubleValue = number.doubleValue
        guard doubleValue.isFinite,
              doubleValue >= 0,
              doubleValue.rounded(.towardZero) == doubleValue else {
            throw ModelInstallerError("The \(field) must be a nonnegative integer.")
        }
        if !capAtHardMaximum, doubleValue > Double(ModelInstaller.hardMaximumBytes) {
            throw ModelInstallerError("The \(field) exceeds the 16 GiB hard size limit.")
        }
        return Int64(min(doubleValue, Double(ModelInstaller.hardMaximumBytes)))
    }

    private func download(
        _ file: ManifestFile,
        to destination: URL,
        modelId: String,
        progress: @escaping ([String: Any]) -> Void
    ) throws {
        let delegate = ModelDownloadDelegate(
            file: file,
            destination: destination,
            modelId: modelId,
            progress: progress
        )
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(
            configuration: configuration,
            delegate: delegate,
            delegateQueue: delegateQueue
        )
        defer {
            registerTask(modelId, task: nil)
            session.finishTasksAndInvalidate()
        }

        try checkCancelled(modelId)
        let task = session.downloadTask(with: file.url)
        registerTask(modelId, task: task)
        try checkCancelled(modelId)
        task.resume()
        do {
            try delegate.wait()
        } catch {
            try checkCancelled(modelId)
            throw error
        }
    }

    private func verifiedResult(
        at directory: URL,
        request: InstallRequest,
        progress: @escaping ([String: Any]) -> Void
    ) throws -> [String: Any] {
        for file in request.files {
            try checkCancelled(request.modelId)
            report(
                progress,
                modelId: request.modelId,
                file: file,
                receivedBytes: file.size,
                state: "verifying"
            )
            try verify(file, at: directory.appendingPathComponent(file.path), modelId: request.modelId)
            report(
                progress,
                modelId: request.modelId,
                file: file,
                receivedBytes: file.size,
                state: "completed"
            )
        }
        return [
            "modelId": request.modelId,
            "revision": request.revision,
            "directory": directory.path,
            "sizeBytes": request.totalSize
        ]
    }

    private func verify(_ file: ManifestFile, at url: URL, modelId: String) throws {
        let values: URLResourceValues
        do {
            values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        } catch {
            throw ModelInstallerError("Could not inspect \(file.path): \(error.localizedDescription)")
        }
        guard values.isRegularFile == true, let actualSize = values.fileSize else {
            throw ModelInstallerError("The downloaded path \(file.path) is not a regular file.")
        }
        guard Int64(actualSize) == file.size else {
            throw ModelInstallerError("Unexpected size for \(file.path): expected \(file.size) bytes, found \(actualSize).")
        }

        let digest: String
        do {
            digest = try sha256(of: url, modelId: modelId)
        } catch {
            throw ModelInstallerError("Could not hash \(file.path): \(error.localizedDescription)")
        }
        guard digest == file.sha256 else {
            throw ModelInstallerError("SHA256 verification failed for \(file.path).")
        }
    }

    private func sha256(of url: URL, modelId: String) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            try checkCancelled(modelId)
            let data = try handle.read(upToCount: 1024 * 1024) ?? Data()
            if data.isEmpty {
                break
            }
            hasher.update(data: data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func report(
        _ progress: @escaping ([String: Any]) -> Void,
        modelId: String,
        file: ManifestFile,
        receivedBytes: Int64,
        state: String
    ) {
        progress([
            "operation": "install",
            "modelId": modelId,
            "filePath": file.path,
            "receivedBytes": receivedBytes,
            "totalBytes": file.size,
            "state": state
        ])
    }
}

private struct InstallRequest {
    let modelId: String
    let revision: String
    let files: [ManifestFile]
    let overwrite: Bool
    let totalSize: Int64
}

private struct ManifestFile {
    let path: String
    let url: URL
    let size: Int64
    let sha256: String
}

private struct ModelInstallerError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }


    var errorDescription: String? {
        message
    }
}

private final class ModelDownloadDelegate: NSObject, URLSessionDownloadDelegate {
    private let file: ManifestFile
    private let destination: URL
    private let modelId: String
    private let progress: ([String: Any]) -> Void
    private let completion = DispatchSemaphore(value: 0)
    private var storedFile = false
    private var resultError: ModelInstallerError?

    init(
        file: ManifestFile,
        destination: URL,
        modelId: String,
        progress: @escaping ([String: Any]) -> Void
    ) {
        self.file = file
        self.destination = destination
        self.modelId = modelId
        self.progress = progress
    }

    func wait() throws {
        completion.wait()
        if let error = resultError {
            throw error
        }
        guard storedFile else {
            throw ModelInstallerError("The download for \(file.path) completed without a file.")
        }
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        progress([
            "operation": "install",
            "modelId": modelId,
            "filePath": file.path,
            "receivedBytes": totalBytesWritten,
            "totalBytes": file.size,
            "state": "downloading"
        ])
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard request.url?.scheme?.lowercased() == "https" else {
            if resultError == nil {
                resultError = ModelInstallerError("The download for \(file.path) attempted a non-HTTPS redirect.")
            }
            task.cancel()
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        guard resultError == nil else {
            return
        }
        guard let response = downloadTask.response as? HTTPURLResponse else {
            resultError = ModelInstallerError("The download for \(file.path) did not return an HTTP response.")
            return
        }
        guard let finalURL = response.url, finalURL.scheme?.lowercased() == "https" else {
            resultError = ModelInstallerError("The download for \(file.path) ended on a non-HTTPS URL.")
            return
        }
        guard (200...299).contains(response.statusCode) else {
            resultError = ModelInstallerError("The download for \(file.path) returned HTTP status \(response.statusCode).")
            return
        }

        do {
            try FileManager.default.moveItem(at: location, to: destination)
            storedFile = true
        } catch {
            resultError = ModelInstallerError("Could not store \(file.path): \(error.localizedDescription)")
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        if resultError == nil, let error = error {
            resultError = ModelInstallerError("The download for \(file.path) failed: \(error.localizedDescription)")
        }
        completion.signal()
    }
}
