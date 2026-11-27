import CoreGraphics
import ExpoModulesCore
import Foundation
import ImageIO
import Metal

private final class PendingGeneration {
    let requestId: String
    let promise: Promise
    var streamedText = ""

    init(requestId: String, promise: Promise) {
        self.requestId = requestId
        self.promise = promise
    }
}

private struct DecodedRgbImage {
    let width: UInt32
    let height: UInt32
    let pixels: [UInt8]
}

private func nativeCallback(
    context: UnsafeMutableRawPointer?,
    requestId: UInt64,
    kind: SonarTensorFoldEventKind,
    tokenIds: UnsafePointer<UInt32>?,
    tokenCount: Int,
    text: UnsafePointer<CChar>?,
    textLength: Int,
    reason: SonarTensorFoldFinishReason,
    message: UnsafePointer<CChar>?
) {
    guard let context else { return }
    Unmanaged<TensorFoldEngineModule>.fromOpaque(context).takeUnretainedValue()
        .handleNativeEvent(
            requestId: requestId,
            kind: kind,
            text: text,
            textLength: textLength,
            reason: reason,
            message: message
        )
}

public final class TensorFoldEngineModule: Module {
    private let engineQueue = DispatchQueue(label: "sonar.tensorfold.engine", qos: .userInitiated)
    private let requestLock = NSLock()
    private let stateLock = NSLock()
    private var nativeEngine: SonarTensorFoldEngine?
    private var loadedModelType: String = "lfm3_vl"
    private var loadedHasVision: Bool = false
    private var requests = [UInt64: PendingGeneration]()
    private var nativeRequestIds = [String: UInt64]()
    private var nextRequestId: UInt64 = 1
    private var loading = false
    private var installingModelId: String?
    private var receivedByPath = [String: Int64]()
    private var installationTotalBytes: Int64 = 0
    private var lastError: String?
    private var loadedInstallationId: String?
    private let defaultsKey = "TensorFoldEngine.selectedInstallation.v2"
    private let defaultModelId = "lfm3-vl-2b"
    private let installSize: Int64 = 1_609_116_269

    public required init(appContext: AppContext) {
        super.init(appContext: appContext)
    }

    deinit {
        engineQueue.sync {
            requestLock.lock()
            for nativeId in requests.keys { nativeEngine.map { sonar_tf_cancel($0, nativeId) } }
            requestLock.unlock()
        }
        if let nativeEngine { sonar_tf_close(nativeEngine) }
    }

    public func definition() -> ModuleDefinition {
        Name("TensorFoldEngine")
        Events("onEngineEvent")

        AsyncFunction("getCapabilities") { () -> [String: Any] in
            let device = MTLCreateSystemDefaultDevice()
            let enoughMemory = ProcessInfo.processInfo.physicalMemory >= 4 * 1024 * 1024 * 1024
            let reason: String?
            if device == nil {
                reason = "No Metal device is available. No inference was started."
            } else if !enoughMemory {
                reason = "TensorFold Mobile LFM3-VL-2B requires at least 4 GiB of physical memory."
            } else {
                reason = nil
            }
            return [
                "available": device != nil && enoughMemory,
                "platform": "ios",
                "backend": "metal",
                "vision": device != nil && enoughMemory,
                "modelId": self.defaultModelId,
                "installSizeBytes": self.installSize,
                "reason": reason ?? NSNull(),
            ]
        }

        AsyncFunction("getStatus") { () -> [String: Any] in self.currentStatus() }

        AsyncFunction("installManifest") { (manifest: [String: Any], promise: Promise) in
            self.engineQueue.async { self.install(manifest, promise: promise) }
        }
        AsyncFunction("cancelInstall") { (modelId: String) -> Bool in
            ModelInstaller.shared.cancel(modelId: modelId)
        }
        AsyncFunction("loadModel") { (installationId: String?, promise: Promise) in
            self.engineQueue.async { self.load(installationId, promise: promise) }
        }
        AsyncFunction("unloadModel") { (promise: Promise) in
            self.engineQueue.async { self.unload(promise: promise) }
        }
        AsyncFunction("generate") { (request: [String: Any], promise: Promise) in
            self.engineQueue.async { self.generate(request, promise: promise) }
        }
        AsyncFunction("cancel") { (requestId: String, promise: Promise) in
            self.engineQueue.async {
                self.requestLock.lock()
                let nativeId = self.nativeRequestIds[requestId]
                self.requestLock.unlock()
                guard let nativeId, let nativeEngine = self.nativeEngine else {
                    promise.resolve(nil)
                    return
                }
                sonar_tf_cancel(nativeEngine, nativeId)
                promise.resolve(nil)
            }
        }
    }

    private func installation() -> [String: Any]? {
        UserDefaults.standard.dictionary(forKey: defaultsKey)
    }

    private func status(
        _ state: String,
        installationId: String? = nil,
        progress: Double? = nil,
        downloadedBytes: Int64? = nil,
        totalBytes: Int64? = nil,
        message: String? = nil
    ) -> [String: Any] {
        let stored = installation()
        var result: [String: Any] = [
            "state": state,
            "modelId": stored?["modelId"] ?? defaultModelId,
        ]
        result["installationId"] = installationId ?? stored?["installationId"] ?? NSNull()
        if let progress { result["progress"] = progress }
        if let downloadedBytes { result["downloadedBytes"] = downloadedBytes }
        if let totalBytes { result["totalBytes"] = totalBytes }
        if let message { result["message"] = message }
        return result
    }

    private func currentStatus() -> [String: Any] {
        stateLock.lock()
        let isReady = nativeEngine != nil
        let isLoading = loading
        let installer = installingModelId
        let downloaded = receivedByPath.values.reduce(Int64(0), +)
        let total = installationTotalBytes
        let failure = lastError
        stateLock.unlock()
        if let installer {
            return status(
                "downloading", progress: total > 0 ? Double(downloaded) / Double(total) : nil,
                downloadedBytes: downloaded, totalBytes: total
            ).merging(["modelId": installer]) { _, new in new }
        }
        if isLoading { return status("loading") }
        if isReady {
            return status("ready", installationId: loadedInstallationId)
        }
        if let failure { return status("error", message: failure) }
        return status(installation() == nil ? "not-installed" : "installed")
    }

    private func emitStatus(_ value: [String: Any]) {
        sendEvent("onEngineEvent", ["type": "status", "status": value])
    }

    private func install(_ manifest: [String: Any], promise: Promise) {
        guard nativeEngine == nil else {
            promise.reject("E_TF_BUSY", "Unload the model before installing another checkpoint.")
            return
        }
        let modelId = manifest["modelId"] as? String ?? defaultModelId
        let files = manifest["files"] as? [[String: Any]] ?? []
        stateLock.lock()
        installingModelId = modelId
        receivedByPath = [:]
        installationTotalBytes = files.reduce(Int64(0)) { $0 + (($1["size"] as? NSNumber)?.int64Value ?? 0) }
        lastError = nil
        stateLock.unlock()
        emitStatus(currentStatus())
        do {
            let result = try ModelInstaller.shared.install(manifest) { [weak self] progress in
                guard let self else { return }
                let path = progress["filePath"] as? String ?? ""
                let received = (progress["receivedBytes"] as? NSNumber)?.int64Value ?? 0
                self.stateLock.lock()
                self.receivedByPath[path] = received
                self.stateLock.unlock()
                self.emitStatus(self.currentStatus())
            }
            let installationId = "\(result["modelId"] as? String ?? modelId)@\(result["revision"] as? String ?? "")"
            let sizeBytes = result["sizeBytes"] as? Int64 ?? installSize
            let stored: [String: Any] = [
                "installationId": installationId,
                "modelId": result["modelId"] as? String ?? modelId,
                "revision": result["revision"] as? String ?? "",
                "directory": result["directory"] as? String ?? "",
                "sizeBytes": sizeBytes,
            ]
            UserDefaults.standard.set(stored, forKey: defaultsKey)
            stateLock.lock()
            installingModelId = nil
            receivedByPath = [:]
            installationTotalBytes = 0
            lastError = nil
            stateLock.unlock()
            let status = status("installed", installationId: installationId, downloadedBytes: sizeBytes, totalBytes: sizeBytes)
            emitStatus(status)
            promise.resolve(status)
        } catch {
            stateLock.lock()
            installingModelId = nil
            receivedByPath = [:]
            installationTotalBytes = 0
            lastError = error.localizedDescription
            stateLock.unlock()
            emitStatus(currentStatus())
            promise.reject("E_TF_INSTALL", error.localizedDescription)
        }
    }

    private func load(_ requestedId: String?, promise: Promise) {
        if nativeEngine != nil {
            promise.resolve(status("ready", installationId: loadedInstallationId))
            return
        }
        guard let stored = installation(), let directory = stored["directory"] as? String,
              let installationId = stored["installationId"] as? String else {
            promise.reject("E_TF_NOT_INSTALLED", "Install the pinned TensorFold model before loading it.")
            return
        }
        guard requestedId == nil || requestedId == installationId else {
            promise.reject("E_TF_NOT_FOUND", "Only the pinned installed checkpoint can be loaded.")
            return
        }
        stateLock.lock()
        loading = true
        lastError = nil
        stateLock.unlock()
        emitStatus(currentStatus())
        var error = [CChar](repeating: 0, count: 8192)
        // Mobile-sized context window (2048 tokens) with 0 MiB prompt-cache overhead keeps Metal RAM lean on iPhones.
        let opened = directory.withCString { path in
            sonar_tf_open(path, 2048, 0, &error, error.count)
        }
        stateLock.lock()
        loading = false
        if let opened {
            nativeEngine = opened
            loadedInstallationId = installationId
            let infoRaw = String(cString: sonar_tf_info_json(opened))
            if let data = infoRaw.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                loadedModelType = json["modelType"] as? String ?? "lfm3_vl"
                loadedHasVision = json["vision"] as? Bool ?? false
            }
        } else {
            lastError = String(cString: error)
        }
        stateLock.unlock()
        let current = currentStatus()
        emitStatus(current)
        if opened == nil {
            promise.reject("E_TF_LOAD", String(cString: error))
        } else {
            promise.resolve(current)
        }
    }

    private func unload(promise: Promise) {
        requestLock.lock()
        let active = !requests.isEmpty
        requestLock.unlock()
        guard !active else {
            promise.reject("E_TF_BUSY", "Cancel the active generation before unloading the model.")
            return
        }
        emitStatus(status("unloading", installationId: loadedInstallationId))
        stateLock.lock()
        let opened = nativeEngine
        nativeEngine = nil
        loadedInstallationId = nil
        loadedHasVision = false
        stateLock.unlock()
        if let opened { sonar_tf_close(opened) }
        emitStatus(status("installed"))
        promise.resolve(nil)
    }

    private func generate(_ request: [String: Any], promise: Promise) {
        guard let nativeEngine else {
            promise.reject("E_TF_NOT_LOADED", "Load the TensorFold model before generation.")
            return
        }
        guard let requestId = request["requestId"] as? String, !requestId.isEmpty,
              let prompt = request["prompt"] as? String,
              let system = request["system"] as? String,
              let maxTokensNumber = request["maxTokens"] as? NSNumber,
              let temperatureNumber = request["temperature"] as? NSNumber else {
            promise.reject("E_TF_REQUEST", "requestId, prompt, system, maxTokens and temperature are required.")
            return
        }
        let maxTokens = maxTokensNumber.intValue
        let temperature = temperatureNumber.doubleValue
        guard maxTokens >= 1 && maxTokens <= 1024 && maxTokensNumber.doubleValue == Double(maxTokens),
              temperature.isFinite && temperature >= 0 && temperature <= 4 else {
            promise.reject("E_TF_REQUEST", "maxTokens must be 1...1024 and temperature must be finite within 0...4.")
            return
        }
        requestLock.lock()
        let busy = !requests.isEmpty
        requestLock.unlock()
        guard !busy else {
            promise.reject("E_TF_BUSY", "This phone engine admits one generation at a time.")
            return
        }

        // Optional image input for TensorFold native Metal vision (LFM3-VL-2B)
        var decodedImage: DecodedRgbImage?
        let temporaryPath = request["temporaryImagePath"] as? String
        let imageBase64 = request["imageBase64"] as? String
        if (temporaryPath != nil && !(temporaryPath?.isEmpty ?? true)) || (imageBase64 != nil && !(imageBase64?.isEmpty ?? true)) {
            guard loadedHasVision else {
                promise.reject("E_TF_NO_VISION", "The loaded TensorFold checkpoint does not have a vision tower.")
                return
            }
            do {
                decodedImage = try decodeRgbImage(temporaryPath: temporaryPath, imageBase64: imageBase64, maxLongEdge: 512)
            } catch {
                promise.reject("E_TF_IMAGE", "Could not decode scene image for TensorFold vision: \(error.localizedDescription)")
                return
            }
        }

        let maxImageTokens = UInt32(max(64, min(256, (request["maxImageTokens"] as? NSNumber)?.intValue ?? 192)))
        let formatted = formatPrompt(system: system, prompt: prompt, hasImage: decodedImage != nil)
        guard formatted.utf8.count <= 256 * 1024 else {
            promise.reject("E_TF_REQUEST", "Prompt and system text exceed 256 KiB.")
            return
        }

        let nativeId = nextRequestId
        nextRequestId &+= 1
        let pending = PendingGeneration(requestId: requestId, promise: promise)
        let context = Unmanaged.passUnretained(self).toOpaque()
        requestLock.lock()
        requests[nativeId] = pending
        nativeRequestIds[requestId] = nativeId
        requestLock.unlock()

        var error = [CChar](repeating: 0, count: 2048)
        let accepted: Int32 = formatted.withCString { text in
            if let img = decodedImage {
                return img.pixels.withUnsafeBufferPointer { pixelBuf in
                    sonar_tf_generate_vision(
                        nativeEngine, nativeId, text, formatted.utf8.count,
                        pixelBuf.baseAddress, img.width, img.height, maxImageTokens,
                        UInt32(maxTokens),
                        temperature > 0 ? 1 : 0, temperature, 40, 0.95, 0, nativeId,
                        nativeCallback, context, &error, error.count
                    )
                }
            }
            return sonar_tf_generate(
                nativeEngine, nativeId, text, formatted.utf8.count, UInt32(maxTokens),
                temperature > 0 ? 1 : 0, temperature, 40, 0.95, 0, nativeId,
                nativeCallback, context, &error, error.count
            )
        }
        if accepted != 0 {
            requestLock.lock()
            requests.removeValue(forKey: nativeId)
            nativeRequestIds.removeValue(forKey: requestId)
            requestLock.unlock()
            promise.reject("E_TF_REQUEST", String(cString: error))
        }
    }

    private func formatPrompt(system: String, prompt: String, hasImage: Bool) -> String {
        if loadedModelType == "lfm3_vl" || loadedModelType == "lfm3" {
            let visionPrefix = hasImage ? "<|vision_start|><|image|><|vision_end|>" : ""
            return "<|startoftext|><|im_start|>system\n\(system)<|im_end|>\n<|im_start|>user\n\(visionPrefix)\(prompt)<|im_end|>\n<|im_start|>assistant\n<think></think>"
        }
        return "<|im_start|>system\n\(system)<|im_end|>\n<|im_start|>user\n\(prompt)<|im_end|>\n<|im_start|>assistant\n"
    }

    private func decodeRgbImage(temporaryPath: String?, imageBase64: String?, maxLongEdge: Int) throws -> DecodedRgbImage {
        let source: CGImageSource
        if let temporaryPath, !temporaryPath.isEmpty {
            let url: URL
            if temporaryPath.hasPrefix("file://"), let parsed = URL(string: temporaryPath), parsed.isFileURL {
                url = parsed
            } else {
                url = URL(fileURLWithPath: temporaryPath)
            }
            guard let created = CGImageSourceCreateWithURL(url as CFURL, nil) else {
                throw NSError(domain: "TensorFoldEngine", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not open image file."])
            }
            source = created
        } else if let imageBase64, let data = Data(base64Encoded: imageBase64) {
            guard let created = CGImageSourceCreateWithData(data as CFData, nil) else {
                throw NSError(domain: "TensorFoldEngine", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not decode base64 image."])
            }
            source = created
        } else {
            throw NSError(domain: "TensorFoldEngine", code: 3, userInfo: [NSLocalizedDescriptionKey: "No valid image source supplied."])
        }

        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxLongEdge,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
            ?? CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw NSError(domain: "TensorFoldEngine", code: 4, userInfo: [NSLocalizedDescriptionKey: "ImageIO failed to decode CGImage."])
        }

        let width = cgImage.width
        let height = cgImage.height
        guard width > 0, height > 0 else {
            throw NSError(domain: "TensorFoldEngine", code: 5, userInfo: [NSLocalizedDescriptionKey: "Decoded image has zero dimensions."])
        }

        let bytesPerRow = width * 4
        var rgba = [UInt8](repeating: 0, count: height * bytesPerRow)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
        let drew = rgba.withUnsafeMutableBytes { ptr -> Bool in
            guard let ctx = CGContext(
                data: ptr.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: colorSpace,
                bitmapInfo: bitmapInfo
            ) else { return false }
            ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drew else {
            throw NSError(domain: "TensorFoldEngine", code: 6, userInfo: [NSLocalizedDescriptionKey: "CGContext failed to render RGB pixels."])
        }

        var rgb = [UInt8](repeating: 0, count: width * height * 3)
        var src = 0
        var dst = 0
        let totalPixels = width * height
        for _ in 0..<totalPixels {
            rgb[dst] = rgba[src]
            rgb[dst + 1] = rgba[src + 1]
            rgb[dst + 2] = rgba[src + 2]
            src += 4
            dst += 3
        }
        return DecodedRgbImage(width: UInt32(width), height: UInt32(height), pixels: rgb)
    }

    fileprivate func handleNativeEvent(
        requestId: UInt64,
        kind: SonarTensorFoldEventKind,
        text: UnsafePointer<CChar>?,
        textLength: Int,
        reason: SonarTensorFoldFinishReason,
        message: UnsafePointer<CChar>?
    ) {
        let value = decode(text, length: textLength)
        if kind.rawValue == 1 {
            requestLock.lock()
            let pending = requests[requestId]
            if let delta = value, !delta.isEmpty {
                pending?.streamedText += delta
            }
            let accumulated = pending?.streamedText ?? ""
            requestLock.unlock()
            if let pending, let delta = value, !delta.isEmpty {
                sendEvent("onEngineEvent", [
                    "type": "token",
                    "requestId": pending.requestId,
                    "token": delta,
                    "text": accumulated,
                ])
            }
            return
        }
        requestLock.lock()
        let pending = requests.removeValue(forKey: requestId)
        if let pending { nativeRequestIds.removeValue(forKey: pending.requestId) }
        requestLock.unlock()
        guard let pending else { return }
        let fullText = value ?? pending.streamedText
        let diagnostic = message.map { String(cString: $0) }
        if reason.rawValue == 2 {
            sendEvent("onEngineEvent", ["type": "cancelled", "requestId": pending.requestId])
            pending.promise.reject("E_TF_CANCELLED", "Generation cancelled.")
        } else if reason.rawValue == 3 {
            var event: [String: Any] = ["type": "error", "requestId": pending.requestId]
            if let diagnostic { event["message"] = diagnostic }
            sendEvent("onEngineEvent", event)
            pending.promise.reject("E_TF_GENERATE", diagnostic ?? "TensorFold generation failed.")
        } else {
            var event: [String: Any] = ["type": "completed", "requestId": pending.requestId]
            if let diagnostic { event["message"] = diagnostic }
            sendEvent("onEngineEvent", event)
            pending.promise.resolve(fullText)
        }
    }

    private func decode(_ text: UnsafePointer<CChar>?, length: Int) -> String? {
        guard let text, length > 0 else { return nil }
        let bytes = UnsafeRawPointer(text).assumingMemoryBound(to: UInt8.self)
        return String(decoding: UnsafeBufferPointer(start: bytes, count: length), as: UTF8.self)
    }
}
