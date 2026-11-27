import ARKit
import CoreImage
import Foundation
import ImageIO
import UIKit
import Vision

enum PerceptionVision {
  private static let captureContext = CIContext(options: [.cacheIntermediates: false])

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

  static func people(frame: ARFrame, orientation: CGImagePropertyOrientation, timestamp: Double, settings: PerceptionSettings) throws -> [[String: Any]] {
    let detected = try peopleAndAnimals(frame: frame, orientation: orientation, timestamp: timestamp, settings: settings)
    return detected.people
  }

  /// Runs Apple Vision human + animal (dog/cat) detection in a single shared-pyramid pass on the Neural Engine.
  static func peopleAndAnimals(
    frame: ARFrame,
    orientation: CGImagePropertyOrientation,
    timestamp: Double,
    settings: PerceptionSettings
  ) throws -> (people: [[String: Any]], animals: [[String: Any]]) {
    let humanRequest = VNDetectHumanRectanglesRequest()
    humanRequest.upperBodyOnly = false
    let animalRequest = VNRecognizeAnimalsRequest()
    let handler = VNImageRequestHandler(cvPixelBuffer: frame.capturedImage, orientation: orientation, options: [:])
    try handler.perform([humanRequest, animalRequest])

    let people: [[String: Any]] = (humanRequest.results ?? []).compactMap { observation in
      buildDetectedObject(
        boundingBox: observation.boundingBox,
        label: "person",
        confidence: Double(observation.confidence),
        source: "vision-person",
        frame: frame,
        orientation: orientation,
        timestamp: timestamp,
        settings: settings
      )
    }

    let animals: [[String: Any]] = (animalRequest.results ?? []).compactMap { observation in
      guard let top = observation.labels.first, top.confidence >= 0.55 else { return nil }
      let normalized = top.identifier.lowercased()
      let label: String
      if normalized.contains("dog") { label = "dog" }
      else if normalized.contains("cat") { label = "cat" }
      else { label = "animal" }
      return buildDetectedObject(
        boundingBox: observation.boundingBox,
        label: label,
        confidence: Double(top.confidence),
        source: "vision-animal",
        frame: frame,
        orientation: orientation,
        timestamp: timestamp,
        settings: settings
      )
    }

    return (people, animals)
  }

  private static func buildDetectedObject(
    boundingBox: CGRect,
    label: String,
    confidence: Double,
    source: String,
    frame: ARFrame,
    orientation: CGImagePropertyOrientation,
    timestamp: Double,
    settings: PerceptionSettings
  ) -> [String: Any] {
    let bounds = sensorBounds(boundingBox, orientation: orientation)
    let center = Geometry.pointAt(
      nx: bounds["x"]! + bounds["width"]! / 2,
      ny: bounds["y"]! + bounds["height"]! / 2,
      z: 1,
      intrinsics: frame.camera.intrinsics,
      resolution: frame.camera.imageResolution
    )
    guard let measure = Geometry.measure(
      depth: frame.sceneDepth,
      bounds: bounds,
      camera: frame.camera,
      orientation: orientation
    ) else {
      return [
        "label": label, "confidence": confidence, "source": source,
        "cameraTimestampMs": timestamp, "bounds": bounds,
        "direction": Geometry.direction(sensorX: center.x, sensorY: center.y, z: center.z, orientation: orientation)
      ]
    }
    var object: [String: Any] = [
      "label": label, "confidence": confidence, "source": source,
      "cameraTimestampMs": timestamp, "depthTimestampMs": timestamp, "bounds": bounds,
      "direction": measure.direction, "distanceMeters": measure.distance, "robustDistanceMeters": measure.distance
    ]
    if let steps = Geometry.steps(measure.distance, settings: settings) { object["steps"] = steps }
    return object
  }

  static func text(frame: ARFrame, orientation: CGImagePropertyOrientation, settings: PerceptionSettings) throws -> [[String: Any]] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .fast
    request.usesLanguageCorrection = false
    request.minimumTextHeight = 0.015
    if !settings.ocrLanguages.isEmpty { request.recognitionLanguages = settings.ocrLanguages }
    let handler = VNImageRequestHandler(cvPixelBuffer: frame.capturedImage, orientation: orientation, options: [:])
    try handler.perform([request])
    let observations = request.results ?? []
    return observations.compactMap { observation in
      guard let candidate = observation.topCandidates(1).first else { return nil }
      let bounds = sensorBounds(observation.boundingBox, orientation: orientation)
      let measure = Geometry.measure(depth: frame.sceneDepth,
        bounds: bounds, camera: frame.camera, orientation: orientation)
      let box = observation.boundingBox
      let horizontal = box.midX < 1.0 / 3 ? "left" : box.midX > 2.0 / 3 ? "right" : nil
      let vertical = box.midY > 2.0 / 3 ? "upper" : box.midY < 1.0 / 3 ? "lower" : nil
      let bearing = [vertical, horizontal].compactMap { $0 }.joined(separator: "-")
      var result: [String: Any] = [
        "text": candidate.string, "confidence": Double(candidate.confidence), "bounds": bounds,
        "direction": ["bearing": bearing.isEmpty ? "ahead" : bearing]
      ]
      if let distance = measure?.distance { result["distanceMeters"] = distance }
      return result
    }
  }

  static func writeJPEG(frame: ARFrame, orientation: CGImagePropertyOrientation, quality: Double, timestamp: Double, maxImageLongEdge: Double?) throws -> [String: Any] {
    guard let output = renderFrame(buffer: frame.capturedImage, orientation: orientation, maxImageLongEdge: maxImageLongEdge) else {
      throw PerceptionError("E_CAPTURE", "The captured camera image could not be rendered.")
    }
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else {
      throw PerceptionError("E_CAPTURE", "A JPEG destination could not be created.")
    }
    let properties: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: min(1, max(0.1, quality))]
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
      "uri": url.absoluteURL.absoluteString, "width": output.width, "height": output.height, "rotationDegrees": 0,
      "mimeType": "image/jpeg", "cameraTimestampMs": timestamp
    ]
  }

  static func previewImage(buffer: CVPixelBuffer, orientation: CGImagePropertyOrientation) -> CGImage? {
    renderFrame(buffer: buffer, orientation: orientation, maxImageLongEdge: 384)
  }

  private static func renderFrame(buffer: CVPixelBuffer, orientation: CGImagePropertyOrientation, maxImageLongEdge: Double?) -> CGImage? {
    var image = CIImage(cvPixelBuffer: buffer).oriented(orientation)
    let longest = max(image.extent.width, image.extent.height)
    if let maxImageLongEdge, longest > maxImageLongEdge {
      let scale = maxImageLongEdge / longest
      image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    }
    return captureContext.createCGImage(image, from: image.extent)
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
