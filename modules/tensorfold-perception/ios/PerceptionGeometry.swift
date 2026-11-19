import ARKit
import Foundation
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

  static func timestamp(_ captureSeconds: Double) -> Double {
    let uptime = ProcessInfo.processInfo.systemUptime
    return (Date.timeIntervalSinceReferenceDate - uptime + captureSeconds) * 1000
  }

  static func steps(_ distance: Double, settings: PerceptionSettings) -> [String: Any]? {
    guard let length = settings.stepLength else { return nil }
    return ["calibrated": true, "stepLengthMeters": length, "count": distance / length]
  }

  static func direction(x: Double, y: Double, z: Double) -> [String: Any] {
    let yaw = atan2(x, max(z, 0.0001)) * 180 / Double.pi
    let pitch = atan2(-y, max(z, 0.0001)) * 180 / Double.pi
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

  static func direction(normalizedX: Double, normalizedY: Double, distance: Double, intrinsics: simd_float3x3, imageWidth: Int, imageHeight: Int) -> [String: Any] {
    let x = (Double(normalizedX) * Double(imageWidth) - Double(intrinsics[2, 0])) / Double(intrinsics[0, 0]) * distance
    let y = (Double(normalizedY) * Double(imageHeight) - Double(intrinsics[2, 1])) / Double(intrinsics[1, 1]) * distance
    return direction(x: x, y: y, z: distance)
  }

  static func analyze(depth: ARDepthData?, camera: ARCamera, timestampMs: Double, settings: PerceptionSettings) -> (obstacles: [[String: Any]], confidence: Double, valid: Bool, aligned: Bool) {
    guard let depth else { return ([], 0, false, false) }
    let width = CVPixelBufferGetWidth(depth.depthMap)
    let height = CVPixelBufferGetHeight(depth.depthMap)
    let expectedAspect = Double(camera.imageResolution.width) / Double(camera.imageResolution.height)
    let actualAspect = Double(width) / Double(height)
    guard abs(expectedAspect - actualAspect) / expectedAspect < 0.08 else { return ([], 0, false, false) }
    CVPixelBufferLockBaseAddress(depth.depthMap, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(depth.depthMap, .readOnly) }
    let hasConfidence = depth.confidenceMap != nil
    if hasConfidence { CVPixelBufferLockBaseAddress(depth.confidenceMap!, .readOnly) }
    defer { if hasConfidence { CVPixelBufferUnlockBaseAddress(depth.confidenceMap!, .readOnly) } }
    guard let base = CVPixelBufferGetBaseAddress(depth.depthMap)?.assumingMemoryBound(to: Float.self) else { return ([], 0, false, true) }
    let rowStride = CVPixelBufferGetBytesPerRow(depth.depthMap) / MemoryLayout<Float>.size
    let confidenceBase = depth.confidenceMap.flatMap { CVPixelBufferGetBaseAddress($0) }?.assumingMemoryBound(to: UInt8.self)
    let confidenceStride = depth.confidenceMap.map { CVPixelBufferGetBytesPerRow($0) } ?? 0
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
            let pixel = base[y * rowStride + x]
            let confidence = confidenceBase.map { Int($0[y * confidenceStride + x]) }
            guard pixel.isFinite, pixel >= 0.15, pixel <= 20, confidence == nil || confidence! >= 1 else { continue }
            samples.append(Double(pixel))
            let measuredConfidence = confidence.map { Double($0) / 2 } ?? 0
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
          "direction": direction(x: Double(point.x), y: Double(point.y), z: Double(point.z))
        ]
        if let steps = steps(nearest, settings: settings) { obstacle["steps"] = steps }
        obstacles.append(obstacle)
      }
    }
    let validity = totalSamples > 0 ? Double(totalValid) / Double(totalSamples) : 0
    let meanConfidence = totalValid > 0 ? confidenceSum / Double(totalValid) : 0
    return (obstacles, validity * meanConfidence, totalValid >= 20, true)
  }

  static func pointAt(nx: Double, ny: Double, z: Double, intrinsics: simd_float3x3, resolution: CGSize) -> SIMD3<Double> {
    let x = (nx * Double(resolution.width) - Double(intrinsics[2, 0])) / Double(intrinsics[0, 0]) * z
    let y = (ny * Double(resolution.height) - Double(intrinsics[2, 1])) / Double(intrinsics[1, 1]) * z
    return SIMD3(x, y, z)
  }

  static func measure(depth: ARDepthData?, bounds: [String: Double], intrinsics: simd_float3x3, resolution: CGSize, settings: PerceptionSettings) -> (distance: Double, direction: [String: Any], confidence: Double)? {
    guard let depth else { return nil }
    let width = CVPixelBufferGetWidth(depth.depthMap)
    let height = CVPixelBufferGetHeight(depth.depthMap)
    CVPixelBufferLockBaseAddress(depth.depthMap, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(depth.depthMap, .readOnly) }
    let confidenceMap = depth.confidenceMap
    if let confidenceMap { CVPixelBufferLockBaseAddress(confidenceMap, .readOnly) }
    defer { if let confidenceMap { CVPixelBufferUnlockBaseAddress(confidenceMap, .readOnly) } }
    guard let base = CVPixelBufferGetBaseAddress(depth.depthMap)?.assumingMemoryBound(to: Float.self) else { return nil }
    let stride = CVPixelBufferGetBytesPerRow(depth.depthMap) / MemoryLayout<Float>.size
    let confidence = confidenceMap.flatMap { CVPixelBufferGetBaseAddress($0) }?.assumingMemoryBound(to: UInt8.self)
    let confidenceStride = confidenceMap.map { CVPixelBufferGetBytesPerRow($0) } ?? 0
    let x0 = max(0, min(width - 1, Int(bounds["x"]! * Double(width))))
    let y0 = max(0, min(height - 1, Int(bounds["y"]! * Double(height))))
    let x1 = max(x0 + 1, min(width, Int((bounds["x"]! + bounds["width"]!) * Double(width))))
    let y1 = max(y0 + 1, min(height, Int((bounds["y"]! + bounds["height"]!) * Double(height))))
    var values: [Double] = []
    var confidenceSum = 0.0
    for y in y0..<y1 {
      for x in x0..<x1 {
        let c = confidence.map { Int($0[y * confidenceStride + x]) }
        let value = Double(base[y * stride + x])
        guard c == nil || c! >= 1, value >= 0.15, value <= 20, value.isFinite else { continue }
        values.append(value)
        confidenceSum += c.map { Double($0) / 2 } ?? 0
      }
    }
    guard values.count >= 3 else { return nil }
    values.sort()
    let median = values[values.count / 2]
    let nx = bounds["x"]! + bounds["width"]! / 2
    let ny = bounds["y"]! + bounds["height"]! / 2
    let point = pointAt(nx: nx, ny: ny, z: median, intrinsics: intrinsics, resolution: resolution)
    return (median, direction(x: Double(point.x), y: Double(point.y), z: median), confidenceSum / Double(values.count))
  }

  static func nullable(_ value: Any?) -> Any { value ?? NSNull() }

  static func sectorName(row: Int, column: Int) -> String {
    let vertical = row == 0 ? "upper-" : (row == 2 ? "lower-" : "")
    let horizontal = column == 0 ? "far-left" : (column == 1 ? "left" : (column == 2 ? "center" : (column == 3 ? "right" : "far-right")))
    return vertical + horizontal
  }
}

