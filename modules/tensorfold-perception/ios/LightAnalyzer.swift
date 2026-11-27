import CoreVideo
import Foundation

struct LightAnalysis: Equatable {
  let ambientLuma: Double
  let lightingState: String // "dark" | "dim" | "good"
  let sampleCount: Int

  var luma: Double { ambientLuma }
}

/// Fast strided mean luma estimator over CVPixelBuffer plane 0 (Y-plane on YCbCr) or BGRA/RGBA/8-bit fallback.
enum LightAnalyzer {
  static let darkThreshold: Double = 0.14
  static let dimThreshold: Double = 0.28

  static func lightingState(forLuma luma: Double) -> String {
    if luma < darkThreshold { return "dark" }
    if luma < dimThreshold { return "dim" }
    return "good"
  }

  static func analyze(pixelBuffer: CVPixelBuffer, targetSamplesPerAxis: Int = 24) -> LightAnalysis? {
    guard CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly) == kCVReturnSuccess else { return nil }
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

    let axisSamples = max(4, targetSamplesPerAxis)
    let pixelFormat = CVPixelBufferGetPixelFormatType(pixelBuffer)

    if CVPixelBufferIsPlanar(pixelBuffer), CVPixelBufferGetPlaneCount(pixelBuffer) > 0 {
      let width = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
      let height = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
      let bytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
      guard width > 0, height > 0, bytesPerRow >= width,
        let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0)?.assumingMemoryBound(to: UInt8.self) else {
        return nil
      }
      let isVideoRange =
        pixelFormat == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange ||
        pixelFormat == kCVPixelFormatType_420YpCbCr8Planar
      let stepX = max(1, width / axisSamples)
      let stepY = max(1, height / axisSamples)

      var sum = 0.0
      var count = 0
      for y in stride(from: 0, to: height, by: stepY) {
        let rowOffset = y * bytesPerRow
        for x in stride(from: 0, to: width, by: stepX) {
          let raw = Double(base[rowOffset + x])
          let normalized = isVideoRange ? max(0.0, min(1.0, (raw - 16.0) / 219.0)) : (raw / 255.0)
          sum += normalized
          count += 1
        }
      }
      guard count > 0 else { return nil }
      let mean = max(0.0, min(1.0, sum / Double(count)))
      return LightAnalysis(ambientLuma: mean, lightingState: lightingState(forLuma: mean), sampleCount: count)
    }

    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
    guard width > 0, height > 0,
      let base = CVPixelBufferGetBaseAddress(pixelBuffer)?.assumingMemoryBound(to: UInt8.self) else {
      return nil
    }

    let stepX = max(1, width / axisSamples)
    let stepY = max(1, height / axisSamples)
    var sum = 0.0
    var count = 0

    switch pixelFormat {
    case kCVPixelFormatType_32BGRA:
      guard bytesPerRow >= width * 4 else { return nil }
      for y in stride(from: 0, to: height, by: stepY) {
        let rowOffset = y * bytesPerRow
        for x in stride(from: 0, to: width, by: stepX) {
          let idx = rowOffset + x * 4
          let b = Double(base[idx])
          let g = Double(base[idx + 1])
          let r = Double(base[idx + 2])
          sum += (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
          count += 1
        }
      }
    case kCVPixelFormatType_32RGBA:
      guard bytesPerRow >= width * 4 else { return nil }
      for y in stride(from: 0, to: height, by: stepY) {
        let rowOffset = y * bytesPerRow
        for x in stride(from: 0, to: width, by: stepX) {
          let idx = rowOffset + x * 4
          let r = Double(base[idx])
          let g = Double(base[idx + 1])
          let b = Double(base[idx + 2])
          sum += (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
          count += 1
        }
      }
    case kCVPixelFormatType_32ARGB:
      guard bytesPerRow >= width * 4 else { return nil }
      for y in stride(from: 0, to: height, by: stepY) {
        let rowOffset = y * bytesPerRow
        for x in stride(from: 0, to: width, by: stepX) {
          let idx = rowOffset + x * 4
          let r = Double(base[idx + 1])
          let g = Double(base[idx + 2])
          let b = Double(base[idx + 3])
          sum += (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
          count += 1
        }
      }
    case kCVPixelFormatType_OneComponent8:
      guard bytesPerRow >= width else { return nil }
      for y in stride(from: 0, to: height, by: stepY) {
        let rowOffset = y * bytesPerRow
        for x in stride(from: 0, to: width, by: stepX) {
          sum += Double(base[rowOffset + x]) / 255.0
          count += 1
        }
      }
    default:
      // Fallback: treat tightly packed 4-byte pixels as BGRA if bytesPerRow accommodates 4 bytes/px.
      guard bytesPerRow >= width * 4 else { return nil }
      for y in stride(from: 0, to: height, by: stepY) {
        let rowOffset = y * bytesPerRow
        for x in stride(from: 0, to: width, by: stepX) {
          let idx = rowOffset + x * 4
          let b = Double(base[idx])
          let g = Double(base[idx + 1])
          let r = Double(base[idx + 2])
          sum += (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
          count += 1
        }
      }
    }

    guard count > 0 else { return nil }
    let mean = max(0.0, min(1.0, sum / Double(count)))
    return LightAnalysis(ambientLuma: mean, lightingState: lightingState(forLuma: mean), sampleCount: count)
  }
}
