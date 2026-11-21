import CoreVideo
import Foundation
import ImageIO

struct PerceptionFrameClock {
  private let unixOffset: TimeInterval

  init(uptime: TimeInterval = ProcessInfo.processInfo.systemUptime, date: Date = Date()) {
    unixOffset = date.timeIntervalSince1970 - uptime
  }

  func unixMilliseconds(for timestamp: TimeInterval) -> Double { (unixOffset + timestamp) * 1_000 }

  static func ageMilliseconds(of timestamp: TimeInterval, at uptime: TimeInterval) -> Double {
    (uptime - timestamp) * 1_000
  }

  static func isFresh(_ age: Double, maximum: Double) -> Bool { age >= -100 && age <= maximum }
}

enum CameraImage {
  static func project(_ point: SIMD3<Double>, focalLength: SIMD2<Double>, principalPoint: SIMD2<Double>, size: CGSize) -> SIMD2<Double> {
    let cameraXY = SIMD2(point.x, -point.y)
    return (cameraXY / point.z * focalLength + principalPoint) / SIMD2(Double(size.width), Double(size.height))
  }

  static func upright(_ sensor: SIMD2<Double>, orientation: CGImagePropertyOrientation) -> SIMD2<Double> {
    switch orientation {
    case .right: return SIMD2(-sensor.y, sensor.x)
    case .left: return SIMD2(sensor.y, -sensor.x)
    case .down: return -sensor
    default: return sensor
    }
  }
}

struct DepthMap {
  let depth: CVPixelBuffer
  let confidence: CVPixelBuffer
  let width: Int
  let height: Int

  static func aligns(width: Int, height: Int, imageSize: CGSize) -> Bool {
    guard width > 0, height > 0, imageSize.width > 0, imageSize.height > 0 else { return false }
    let cameraAspect = imageSize.width / imageSize.height
    let depthAspect = Double(width) / Double(height)
    return abs(cameraAspect - depthAspect) / cameraAspect < 0.08
  }

  init?(depth: CVPixelBuffer, confidence: CVPixelBuffer?, imageSize: CGSize) {
    let width = CVPixelBufferGetWidth(depth)
    let height = CVPixelBufferGetHeight(depth)
    let format = CVPixelBufferGetPixelFormatType(depth)
    guard Self.aligns(width: width, height: height, imageSize: imageSize),
      format == kCVPixelFormatType_DepthFloat32 || format == kCVPixelFormatType_OneComponent32Float,
      let confidence, CVPixelBufferGetPixelFormatType(confidence) == kCVPixelFormatType_OneComponent8,
      CVPixelBufferGetWidth(confidence) == width, CVPixelBufferGetHeight(confidence) == height,
      CVPixelBufferGetBytesPerRow(depth) >= width * MemoryLayout<Float>.stride,
      CVPixelBufferGetBytesPerRow(depth).isMultiple(of: MemoryLayout<Float>.stride),
      CVPixelBufferGetBytesPerRow(confidence) >= width else { return nil }
    self.depth = depth
    self.confidence = confidence
    self.width = width
    self.height = height
  }

  func read<T>(_ body: (Samples) -> T) -> T? {
    guard CVPixelBufferLockBaseAddress(depth, .readOnly) == kCVReturnSuccess else { return nil }
    defer { CVPixelBufferUnlockBaseAddress(depth, .readOnly) }
    guard CVPixelBufferLockBaseAddress(confidence, .readOnly) == kCVReturnSuccess else { return nil }
    defer { CVPixelBufferUnlockBaseAddress(confidence, .readOnly) }
    guard let depths = CVPixelBufferGetBaseAddress(depth)?.assumingMemoryBound(to: Float.self),
      let levels = CVPixelBufferGetBaseAddress(confidence)?.assumingMemoryBound(to: UInt8.self) else { return nil }
    return body(Samples(width: width, height: height, depths: depths, levels: levels,
      depthStride: CVPixelBufferGetBytesPerRow(depth) / MemoryLayout<Float>.stride,
      confidenceStride: CVPixelBufferGetBytesPerRow(confidence)))
  }

  struct Samples {
    let width: Int
    let height: Int
    fileprivate let depths: UnsafePointer<Float>
    fileprivate let levels: UnsafePointer<UInt8>
    fileprivate let depthStride: Int
    fileprivate let confidenceStride: Int

    func sample(x: Int, y: Int, minimumConfidence: UInt8 = 1) -> (metres: Float, confidence: UInt8)? {
      let level = levels[y * confidenceStride + x]
      let value = depths[y * depthStride + x]
      guard level >= minimumConfidence, level <= 2, value.isFinite, (0.15...20).contains(value) else { return nil }
      return (value, level)
    }

    func corroborates(x: Double, y: Double, expectedDepth: Float) -> Bool {
      guard x >= 0, x < 1, y >= 0, y < 1, expectedDepth.isFinite, (0.35...5).contains(expectedDepth) else { return false }
      let centreX = Int(x * Double(width))
      let centreY = Int(y * Double(height))
      let tolerance = max(0.15, expectedDepth * 0.08)
      var agreeing = 0
      var foreground = 0
      var measured = 0
      for row in max(0, centreY - 2)...min(height - 1, centreY + 2) {
        for column in max(0, centreX - 2)...min(width - 1, centreX + 2) {
          guard let reading = sample(x: column, y: row, minimumConfidence: 2) else { continue }
          measured += 1
          if abs(reading.metres - expectedDepth) <= tolerance { agreeing += 1 }
          if reading.metres < expectedDepth - tolerance { foreground += 1 }
        }
      }
      return agreeing >= 5 && agreeing * 2 > measured && foreground < 3
    }
  }
}

struct SeatAlignmentDwell {
  private var firstMatch: TimeInterval?
  private var lastMatch: TimeInterval?

  mutating func observe(timestamp: TimeInterval, matching: Bool) -> Bool {
    guard matching, timestamp.isFinite else {
      firstMatch = nil
      lastMatch = nil
      return false
    }
    if let lastMatch {
      if timestamp <= lastMatch || timestamp - lastMatch > 0.12 { firstMatch = timestamp }
    }
    if firstMatch == nil { firstMatch = timestamp }
    lastMatch = timestamp
    return timestamp - (firstMatch ?? timestamp) >= 0.25
  }
}
