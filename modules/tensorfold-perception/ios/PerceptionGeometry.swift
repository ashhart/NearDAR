import ARKit
import Foundation
import ImageIO
import simd

struct PerceptionSettings {
  var stepLength: Double?
  var warningDistance = 2.5
  var criticalDistance = 0.9
  var maximumFrameAgeMs = 500.0
  var maximumAlignmentAgeMs = 80.0
  var proximityIntervalMs = 250.0
  var detectPeople = true
  var recognizeText = true
  var ocrLanguages: [String] = []

  init(_ values: [String: Any]?) throws {
    if let value = values?["stepLengthMeters"] as? Double {
      guard value >= 0.3, value <= 1.5 else { throw PerceptionError("E_OPTIONS", "stepLengthMeters must be between 0.3 and 1.5.") }
      stepLength = value
    }
    if let value = values?["warningDistanceMeters"] as? Double { warningDistance = value }
    if let value = values?["criticalDistanceMeters"] as? Double { criticalDistance = value }
    if let value = values?["maximumFrameAgeMs"] as? Double { maximumFrameAgeMs = value }
    if let value = values?["maximumAlignmentAgeMs"] as? Double { maximumAlignmentAgeMs = value }
    if let value = values?["proximityIntervalMs"] as? Double { proximityIntervalMs = value }
    guard warningDistance > criticalDistance, criticalDistance > 0, maximumFrameAgeMs >= 100,
      maximumAlignmentAgeMs >= 0, proximityIntervalMs >= 100 else {
      throw PerceptionError("E_OPTIONS", "Invalid distance, freshness, or proximity interval settings.")
    }
    detectPeople = values?["detectPeople"] as? Bool ?? true
    recognizeText = values?["recognizeText"] as? Bool ?? true
    ocrLanguages = values?["ocrLanguages"] as? [String] ?? []
  }
}

struct PerceptionError: Error, LocalizedError {
  let code: String
  let message: String
  var errorDescription: String { message }
  init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

enum Geometry {
  static let columns = 5
  static let rows = 3

  static func steps(_ distance: Double, settings: PerceptionSettings) -> [String: Any]? {
    guard let length = settings.stepLength else { return nil }
    return ["calibrated": true, "stepLengthMeters": length, "count": distance / length]
  }

  static func direction(sensorX: Double, sensorY: Double, z: Double, orientation: CGImagePropertyOrientation) -> [String: Any] {
    let upright = CameraImage.upright(SIMD2(sensorX, sensorY), orientation: orientation)
    let yaw = atan2(upright.x, max(z, 0.0001)) * 180 / Double.pi
    let pitch = atan2(-upright.y, max(z, 0.0001)) * 180 / Double.pi
    var bearing = "ahead"
    if yaw < -12 && pitch > 18 { bearing = "upper-left" }
    else if yaw > 12 && pitch > 18 { bearing = "upper-right" }
    else if yaw < -12 && pitch < -18 { bearing = "lower-left" }
    else if yaw > 12 && pitch < -18 { bearing = "lower-right" }
    else if yaw < -12 { bearing = "left" }
    else if yaw > 12 { bearing = "right" }
    else if pitch > 18 { bearing = "above" }
    else if pitch < -18 { bearing = "below" }
    let reference = abs(yaw) >= 8 ? yaw : (pitch >= 0 ? 0 : 180)
    let normalized = (reference.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
    let clock = Int((normalized / 30).rounded()) % 12
    return ["bearing": bearing, "clockSector": clock == 0 ? 12 : clock, "yawDegrees": yaw, "pitchDegrees": pitch]
  }

  static func analyze(depth: ARDepthData?, camera: ARCamera, orientation: CGImagePropertyOrientation, settings: PerceptionSettings) -> (obstacles: [[String: Any]], confidence: Double, valid: Bool, aligned: Bool) {
    guard let depth else { return ([], 0, false, false) }
    let aligned = DepthMap.aligns(width: CVPixelBufferGetWidth(depth.depthMap), height: CVPixelBufferGetHeight(depth.depthMap), imageSize: camera.imageResolution)
    guard aligned else { return ([], 0, false, false) }
    guard let map = DepthMap(depth: depth.depthMap, confidence: depth.confidenceMap, imageSize: camera.imageResolution),
      let result = map.read({ analyze(samples: $0, camera: camera, orientation: orientation, settings: settings) }) else {
      return ([], 0, false, true)
    }
    return result
  }

  private static func analyze(samples depth: DepthMap.Samples, camera: ARCamera, orientation: CGImagePropertyOrientation, settings: PerceptionSettings) -> (obstacles: [[String: Any]], confidence: Double, valid: Bool, aligned: Bool) {
    let width = depth.width
    let height = depth.height
    var obstacles: [[String: Any]] = []
    var totalSamples = 0
    var totalValid = 0
    var confidenceSum = 0.0
    var samples: [Double] = []
    samples.reserveCapacity((width / columns + 1) * (height / rows + 1))
    for row in 0..<rows {
      for column in 0..<columns {
        let x0 = column * width / columns
        let x1 = (column + 1) * width / columns
        let y0 = row * height / rows
        let y1 = (row + 1) * height / rows
        samples.removeAll(keepingCapacity: true)
        var sectorConfidence = 0.0
        for y in y0..<y1 {
          for x in x0..<x1 {
            guard let sample = depth.sample(x: x, y: y) else { continue }
            samples.append(Double(sample.metres))
            let measuredConfidence = Double(sample.confidence) / 2
            sectorConfidence += measuredConfidence
            confidenceSum += measuredConfidence
          }
        }
        totalSamples += max(1, (x1 - x0) * (y1 - y0))
        totalValid += samples.count
        let required = max(3, ((x1 - x0) * (y1 - y0)) / 20)
        guard samples.count >= required else { continue }
        samples.sort()
        let nearest = samples[max(0, Int(Double(samples.count - 1) * 0.1))]
        let median = samples[samples.count / 2]
        let high = samples[min(samples.count - 1, Int(Double(samples.count - 1) * 0.9))]
        let meanConfidence = sectorConfidence / Double(samples.count)
        let nx = Double(column) / Double(columns) + 0.5 / Double(columns)
        let ny = Double(row) / Double(rows) + 0.5 / Double(rows)
        let point = pointAt(nx: nx, ny: ny, z: nearest, intrinsics: camera.intrinsics, resolution: camera.imageResolution)
        var obstacle: [String: Any] = [
          "sector": sectorName(row: row, column: column),
          "nearestDistanceMeters": nearest,
          "robustDistanceMeters": median,
          "spreadMeters": high - nearest,
          "validPixelFraction": Double(samples.count) / Double((x1 - x0) * (y1 - y0)),
          "meanConfidence": meanConfidence,
          "nearestPoint": ["x": point.x, "y": point.y, "z": point.z],
          "bounds": ["x": Double(column) / Double(columns), "y": Double(row) / Double(rows), "width": 1.0 / Double(columns), "height": 1.0 / Double(rows)],
          "direction": direction(sensorX: point.x, sensorY: point.y, z: point.z, orientation: orientation)
        ]
        if let steps = steps(nearest, settings: settings) { obstacle["steps"] = steps }
        obstacles.append(obstacle)
      }
    }
    let validity = totalSamples > 0 ? Double(totalValid) / Double(totalSamples) : 0
    let meanConfidence = totalValid > 0 ? confidenceSum / Double(totalValid) : 0
    return (obstacles, validity * meanConfidence, totalValid >= 20 && !obstacles.isEmpty, true)
  }

  static func pointAt(nx: Double, ny: Double, z: Double, intrinsics: simd_float3x3, resolution: CGSize) -> SIMD3<Double> {
    let x = (nx * Double(resolution.width) - Double(intrinsics[2, 0])) / Double(intrinsics[0, 0]) * z
    let y = (ny * Double(resolution.height) - Double(intrinsics[2, 1])) / Double(intrinsics[1, 1]) * z
    return SIMD3(x, y, z)
  }

  static func project(_ cameraPoint: SIMD3<Double>, camera: ARCamera) -> SIMD2<Double> {
    let intrinsics = camera.intrinsics
    return CameraImage.project(cameraPoint, focalLength: SIMD2(Double(intrinsics[0, 0]), Double(intrinsics[1, 1])),
      principalPoint: SIMD2(Double(intrinsics[2, 0]), Double(intrinsics[2, 1])), size: camera.imageResolution)
  }

  static func measure(depth: ARDepthData?, bounds: [String: Double], camera: ARCamera, orientation: CGImagePropertyOrientation) -> (distance: Double, direction: [String: Any])? {
    guard let depth, let map = DepthMap(depth: depth.depthMap, confidence: depth.confidenceMap, imageSize: camera.imageResolution),
      let x = bounds["x"], let y = bounds["y"], let width = bounds["width"], let height = bounds["height"],
      x.isFinite, y.isFinite, width.isFinite, height.isFinite else { return nil }
    let left = max(0, x), top = max(0, y)
    let right = min(1, x + width), bottom = min(1, y + height)
    guard left < right, top < bottom else { return nil }
    let x0 = Int(left * Double(map.width)), x1 = Int(ceil(right * Double(map.width)))
    let y0 = Int(top * Double(map.height)), y1 = Int(ceil(bottom * Double(map.height)))
    guard let values = map.read({ pixels in
      var readings: [Float] = []
      for row in y0..<y1 {
        for column in x0..<x1 {
          if let reading = pixels.sample(x: column, y: row) { readings.append(reading.metres) }
        }
      }
      return readings.sorted()
    }), values.count >= max(3, (x1 - x0) * (y1 - y0) / 20) else { return nil }
    let z = Double(values[values.count / 2])
    let point = pointAt(nx: (left + right) / 2, ny: (top + bottom) / 2, z: z, intrinsics: camera.intrinsics, resolution: camera.imageResolution)
    return (simd_length(point), direction(sensorX: point.x, sensorY: point.y, z: z, orientation: orientation))
  }

  static func depthConfirms(cameraPoint: SIMD3<Double>, frame: ARFrame) -> Bool {
    guard (0.35...5).contains(cameraPoint.z) else { return false }
    guard let depth = frame.sceneDepth,
      let map = DepthMap(depth: depth.depthMap, confidence: depth.confidenceMap, imageSize: frame.camera.imageResolution) else { return false }
    let pixel = project(cameraPoint, camera: frame.camera)
    return map.read { $0.corroborates(x: pixel.x, y: pixel.y, expectedDepth: Float(cameraPoint.z)) } ?? false
  }

  static func nullable(_ value: Any?) -> Any { value ?? NSNull() }

  static func sectorName(row: Int, column: Int) -> String {
    let vertical = row == 0 ? "upper-" : (row == 2 ? "lower-" : "")
    let horizontal = column == 0 ? "far-left" : (column == 1 ? "left" : (column == 2 ? "center" : (column == 3 ? "right" : "far-right")))
    return vertical + horizontal
  }
}

