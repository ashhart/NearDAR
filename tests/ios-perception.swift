import CoreVideo
import Foundation

@main
struct PerceptionTests {
  static func main() {
    checkTimestamps()
    checkProjection()
    checkDepthBuffers()
    checkAlignmentDwell()
    print("iOS perception checks passed: timestamps, portrait projection, depth buffers, and alignment dwell.")
  }

  static func checkProjection() {
    let pixel = CameraImage.project(SIMD3(0, 1, 2), focalLength: SIMD2(400, 400), principalPoint: SIMD2(400, 300), size: CGSize(width: 800, height: 600))
    expect(pixel.x == 0.5 && abs(pixel.y - 1.0 / 6) < 0.0001, "A point above the camera projects above the centre of the sensor")
    expect(CameraImage.upright(SIMD2(0, -1), orientation: .right) == SIMD2(1, 0), "A sensor-up point is to the right with a portrait phone")
    expect(CameraImage.upright(SIMD2(0, 1), orientation: .right) == SIMD2(-1, 0), "A sensor-down point is to the left with a portrait phone")
  }

  static func checkTimestamps() {
    let unixTime = 1_800_000_000.0
    let clock = PerceptionFrameClock(uptime: 123, date: Date(timeIntervalSince1970: unixTime))
    expect(clock.unixMilliseconds(for: 122.75) == 1_799_999_999_750, "Frame timestamps must match Unix milliseconds used by JavaScript")
    let age = PerceptionFrameClock.ageMilliseconds(of: 122.75, at: 123)
    expect(PerceptionFrameClock.isFresh(age, maximum: 500), "A fresh frame must be usable")
    expect(!PerceptionFrameClock.isFresh(501, maximum: 500), "An old frame must be rejected")
    expect(!PerceptionFrameClock.isFresh(-101, maximum: 500), "An implausibly future frame must be rejected")
  }

  static func checkDepthBuffers() {
    let size = CGSize(width: 700, height: 700)
    let depth = buffer(7, 7, format: kCVPixelFormatType_DepthFloat32)
    let confidence = buffer(7, 7, format: kCVPixelFormatType_OneComponent8)
    fill(depth, with: Float(2))
    fill(confidence, with: UInt8(2))
    let map = DepthMap(depth: depth, confidence: confidence, imageSize: size)!
    expect(map.read { $0.corroborates(x: 0.5, y: 0.5, expectedDepth: 2) } == true, "Trusted readings on the seat surface must corroborate it")
    expect(map.read { $0.corroborates(x: 0.5, y: 0.5, expectedDepth: 3) } == false, "Foreground depth must reject a seat behind it")
    expect(map.read { $0.corroborates(x: 1, y: 0.5, expectedDepth: 2) } == false, "An off-screen target must not read the neighbouring pixel")
    fill(confidence, with: UInt8(1))
    expect(map.read { $0.sample(x: 3, y: 3)?.metres } == 2, "Medium confidence may inform ordinary depth measurements")
    expect(map.read { $0.corroborates(x: 0.5, y: 0.5, expectedDepth: 2) } == false, "Medium confidence is insufficient for an alignment tap")
    fill(confidence, with: UInt8(0))
    expect(map.read { $0.sample(x: 3, y: 3) == nil } == true, "Low confidence cannot become a depth measurement")
    fill(confidence, with: UInt8(2))
    fill(depth, with: Float.nan)
    expect(map.read { $0.sample(x: 3, y: 3) == nil } == true, "Invalid depth cannot become a measurement")
    expect(DepthMap(depth: depth, confidence: nil, imageSize: size) == nil, "Missing confidence must disable depth guidance")
    expect(DepthMap(depth: depth, confidence: buffer(4, 4, format: kCVPixelFormatType_OneComponent8), imageSize: size) == nil, "Mismatched dimensions must be rejected before indexing")
    expect(DepthMap(depth: depth, confidence: depth, imageSize: size) == nil, "Unexpected confidence pixel formats must be rejected")
    expect(DepthMap(depth: depth, confidence: confidence, imageSize: CGSize(width: 1600, height: 900)) == nil, "Depth must be registered to the camera image")
  }

  static func checkAlignmentDwell() {
    var dwell = SeatAlignmentDwell()
    for timestamp in [1.0, 1.1, 1.2] {
      expect(!dwell.observe(timestamp: timestamp, matching: true), "Alignment must dwell before confirmation")
    }
    expect(!dwell.observe(timestamp: 1.3, matching: false), "Loss of depth agreement must reset the dwell")
    expect(!dwell.observe(timestamp: 1.4, matching: true), "A reacquired target must start a new dwell")
    expect(!dwell.observe(timestamp: 2.0, matching: true), "A gap in frames cannot count as a steady alignment")
    expect(!dwell.observe(timestamp: 2.1, matching: true), "Confirmation must still wait for the full dwell")
    expect(!dwell.observe(timestamp: 2.2, matching: true), "A short confirmed interval remains pending")
    expect(!dwell.observe(timestamp: 2.2, matching: true), "A duplicate frame must not advance confirmation")
    expect(!dwell.observe(timestamp: 2.3, matching: true), "A duplicate frame must reset the interval")
    expect(!dwell.observe(timestamp: 2.4, matching: true), "A reset dwell must start from the repeated frame")
    expect(dwell.observe(timestamp: 2.5, matching: true), "Sustained agreement across fresh frames should confirm alignment")
  }

  static func buffer(_ width: Int, _ height: Int, format: OSType) -> CVPixelBuffer {
    var pixels: CVPixelBuffer?
    expect(CVPixelBufferCreate(nil, width, height, format, nil, &pixels) == kCVReturnSuccess, "Allocate a Core Video fixture")
    return pixels!
  }

  static func fill<T>(_ buffer: CVPixelBuffer, with value: T) {
    expect(CVPixelBufferLockBaseAddress(buffer, []) == kCVReturnSuccess, "Lock a Core Video fixture")
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    let bytes = CVPixelBufferGetBaseAddress(buffer)!
    for row in 0..<CVPixelBufferGetHeight(buffer) {
      let pixels = bytes.advanced(by: row * CVPixelBufferGetBytesPerRow(buffer)).assumingMemoryBound(to: T.self)
      for column in 0..<CVPixelBufferGetWidth(buffer) { pixels[column] = value }
    }
  }

  static func expect(_ passes: Bool, _ message: String) {
    if !passes { fatalError(message) }
  }
}
