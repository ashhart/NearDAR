import ARKit
import CoreImage
import Foundation
import ImageIO
import UIKit
import Vision

enum PerceptionVision {
  static func interfaceOrientation() -> CGImagePropertyOrientation {
    let readOrientation = {
      let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
      switch scene?.interfaceOrientation {
      case .portraitUpsideDown: return CGImagePropertyOrientation.left
      case .landscapeLeft: return CGImagePropertyOrientation.up
      case .landscapeRight: return CGImagePropertyOrientation.down
      default: return CGImagePropertyOrientation.right
      }
    }
    return Thread.isMainThread ? readOrientation() : DispatchQueue.main.sync(execute: readOrientation)
  }

  static func rotation(_ orientation: CGImagePropertyOrientation) -> Int {
    switch orientation {
    case .right: return 90
    case .left: return 270
    case .down: return 180
    default: return 0
    }
  }

  static func sensorBounds(_ observation: CGRect, orientation: CGImagePropertyOrientation) -> [String: Double] {
    let x = observation.origin.x
    let y = 1 - observation.origin.y - observation.height
    let width = observation.width
    let height = observation.height
    switch orientation {
    case .right:
      return ["x": y, "y": 1 - x - width, "width": height, "height": width]
    case .left:
      return ["x": 1 - y - height, "y": x, "width": height, "height": width]
    case .down:
      return ["x": 1 - x - width, "y": 1 - y - height, "width": width, "height": height]
    default:
      return ["x": x, "y": y, "width": width, "height": height]
    }
  }

  static func people(frame: ARFrame, settings: PerceptionSettings) throws -> [[String: Any]] {
    let request = VNDetectHumanRectanglesRequest()
    request.upperBodyOnly = false
    let orientation = interfaceOrientation()
    let handler = VNImageRequestHandler(cvPixelBuffer: frame.capturedImage, orientation: orientation, options: [:])
    try handler.perform([request])
    let observations = request.results ?? []
    let timestamp = Geometry.timestamp(frame.timestamp)
    return observations.compactMap { observation in
      let bounds = sensorBounds(observation.boundingBox, orientation: orientation)
      guard let measure = Geometry.measure(depth: frame.sceneDepth,
        bounds: bounds, intrinsics: frame.camera.intrinsics, resolution: frame.camera.imageResolution, settings: settings) else {
        return [
          "label": "person", "confidence": Double(observation.confidence), "source": "vision-person",
          "cameraTimestampMs": timestamp, "bounds": bounds,
          "direction": Geometry.direction(normalizedX: bounds["x"]! + bounds["width"]! / 2,
            normalizedY: bounds["y"]! + bounds["height"]! / 2, distance: 1,
            intrinsics: frame.camera.intrinsics, imageWidth: Int(frame.camera.imageResolution.width), imageHeight: Int(frame.camera.imageResolution.height))
        ] as [String: Any]?
      }
      var object: [String: Any] = [
        "label": "person", "confidence": Double(observation.confidence), "source": "vision-person",
        "cameraTimestampMs": timestamp, "depthTimestampMs": timestamp, "bounds": bounds,
        "direction": measure.direction, "distanceMeters": measure.distance, "robustDistanceMeters": measure.distance
      ]
      if let steps = Geometry.steps(measure.distance, settings: settings) { object["steps"] = steps }
      return object
    }
  }

  static func text(frame: ARFrame, settings: PerceptionSettings) throws -> [[String: Any]] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .fast
    request.usesLanguageCorrection = false
    request.minimumTextHeight = 0.015
    if !settings.ocrLanguages.isEmpty { request.recognitionLanguages = settings.ocrLanguages }
    let orientation = interfaceOrientation()
    let handler = VNImageRequestHandler(cvPixelBuffer: frame.capturedImage, orientation: orientation, options: [:])
    try handler.perform([request])
    let observations = request.results ?? []
    return observations.compactMap { observation in
      guard let candidate = observation.topCandidates(1).first else { return nil }
      let bounds = sensorBounds(observation.boundingBox, orientation: orientation)
      let measure = Geometry.measure(depth: frame.sceneDepth,
        bounds: bounds, intrinsics: frame.camera.intrinsics, resolution: frame.camera.imageResolution, settings: settings)
      let nx = bounds["x"]! + bounds["width"]! / 2
      let ny = bounds["y"]! + bounds["height"]! / 2
      let direction = measure?.direction ?? Geometry.direction(normalizedX: nx, normalizedY: ny, distance: 1,
        intrinsics: frame.camera.intrinsics, imageWidth: Int(frame.camera.imageResolution.width), imageHeight: Int(frame.camera.imageResolution.height))
      var result: [String: Any] = [
        "text": candidate.string, "confidence": Double(candidate.confidence), "bounds": bounds, "direction": direction
      ]
      if let distance = measure?.distance { result["distanceMeters"] = distance }
      return result
    }
  }

  static func writeJPEG(frame: ARFrame, quality: Double) throws -> [String: Any] {
    let image = CIImage(cvPixelBuffer: frame.capturedImage)
    let context = CIContext(options: [.cacheIntermediates: false])
    guard let output = context.createCGImage(image, from: image.extent) else {
      throw PerceptionError("E_CAPTURE", "The captured camera image could not be rendered.")
    }
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else {
      throw PerceptionError("E_CAPTURE", "A JPEG destination could not be created.")
    }
    let orientation = interfaceOrientation()
    let properties: [CFString: Any] = [
      kCGImageDestinationLossyCompressionQuality: min(1, max(0.1, quality)),
      kCGImagePropertyOrientation: Int(orientation.rawValue)
    ]
    CGImageDestinationAddImage(destination, output, properties as CFDictionary)
    guard CGImageDestinationFinalize(destination) else {
      throw PerceptionError("E_CAPTURE", "The camera image could not be encoded as JPEG.")
    }
    let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("TensorFoldPerception", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent("\(UUID().uuidString).jpg")
    try (data as Data).write(to: url, options: .atomic)
    pruneCaptures(directory: directory, keeping: url)
    return [
      "uri": url.absoluteURL.absoluteString, "width": CVPixelBufferGetWidth(frame.capturedImage),
      "height": CVPixelBufferGetHeight(frame.capturedImage), "rotationDegrees": rotation(orientation),
      "mimeType": "image/jpeg", "cameraTimestampMs": Geometry.timestamp(frame.timestamp)
    ]
  }

  static func pruneCaptures(directory: URL, keeping: URL? = nil) {
    guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return }
    for file in files where file.pathExtension == "jpg" && file != keeping { try? FileManager.default.removeItem(at: file) }
  }

  static func releaseCapture(_ uri: String, directory: URL) -> Bool {
    guard let url = URL(string: uri), url.isFileURL else { return false }
    let target = url.standardizedFileURL.path
    let base = directory.standardizedFileURL.path
    guard target.hasPrefix(base + "/"), url.lastPathComponent.hasSuffix(".jpg") else { return false }
    guard FileManager.default.fileExists(atPath: target) else { return false }
    try? FileManager.default.removeItem(at: url)
    return !FileManager.default.fileExists(atPath: target)
  }
}
