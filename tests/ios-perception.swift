import CoreVideo
import Foundation
import simd

@main
struct PerceptionTests {
  static func main() {
    checkTimestamps()
    checkProjection()
    checkDepthBuffers()
    checkAlignmentDwell()
    checkLiveObstacleIdentity()
    checkCorridorAnalyzer()
    checkApproachDoorwaysAndStandby()
    print("iOS perception checks passed: timestamps, portrait projection, depth buffers, alignment dwell, obstacle identity, corridor analyzer, approach velocity, doorways, and standby.")
  }

  static func checkLiveObstacleIdentity() {
    let sector = ["x": 0.4, "y": 0.4, "width": 0.2, "height": 0.2]
    let obstacle: [String: Any] = [
      "bounds": sector, "nearestDistanceMeters": 1.0, "spreadMeters": 0.12, "meanConfidence": 0.9
    ]
    let wall: [String: Any] = [
      "source": "arkit-mesh-classification", "label": "wall", "bounds": sector,
      "center": ["z": 1.08], "confidence": 0.82
    ]
    expect(LiveObstacleIdentity.label(obstacle: obstacle, objects: [wall]) == "wall", "A reliable mesh at the measured obstacle can supply its label")
    var other = wall
    other["center"] = ["z": 1.6]
    expect(LiveObstacleIdentity.label(obstacle: obstacle, objects: [other]) == nil, "A mesh behind the measured obstacle must not supply its label")
    other = wall
    other["bounds"] = ["x": 0.82, "y": 0.4, "width": 0.15, "height": 0.2]
    expect(LiveObstacleIdentity.label(obstacle: obstacle, objects: [other]) == nil, "A mesh in another sector must not supply its label")
    other = wall
    other["label"] = "door"
    expect(LiveObstacleIdentity.label(obstacle: obstacle, objects: [wall, other]) == nil, "Competing labels must fall back to an unnamed warning")
    other = wall
    other["confidence"] = 0.5
    expect(LiveObstacleIdentity.label(obstacle: obstacle, objects: [other]) == nil, "A low-confidence mesh must not supply a label")
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

  static func checkCorridorAnalyzer() {
    let w = 96
    let h = 72
    let imageSize = CGSize(width: 960, height: 720)
    // Intrinsics for ~70 deg horizontal FOV: fx = fy = 650, cx = 480, cy = 360
    let intrinsics = simd_float3x3(columns: (
      SIMD3<Float>(650, 0, 0),
      SIMD3<Float>(0, 650, 0),
      SIMD3<Float>(480, 360, 1)
    ))
    // Level landscape-aligned camera facing North (-Z) at y = 1.15m above floor (y = 0)
    let levelNorth = simd_float4x4(columns: (
      SIMD4<Float>(1, 0, 0, 0),
      SIMD4<Float>(0, 1, 0, 0),
      SIMD4<Float>(0, 0, 1, 0),
      SIMD4<Float>(0, 1.15, 0, 1)
    ))

    // Heading & pitch extraction
    let headingN = CorridorAnalyzer.cameraHeadingDegrees(transform: levelNorth)!
    expect(abs(headingN) < 0.01 || abs(headingN - 360) < 0.01, "Identity transform (-Z forward) should face North (0 deg)")
    // Facing East (+X): forward = -col2 = (1,0,0) => col2 = (-1,0,0), col0 = (0,0,1), col1 = (0,1,0)
    let levelEast = simd_float4x4(columns: (
      SIMD4<Float>(0, 0, 1, 0),
      SIMD4<Float>(0, 1, 0, 0),
      SIMD4<Float>(-1, 0, 0, 0),
      SIMD4<Float>(0, 1.15, 0, 1)
    ))
    let headingE = CorridorAnalyzer.cameraHeadingDegrees(transform: levelEast)!
    expect(abs(headingE - 90) < 0.01, "East-facing transform should report 90 degrees heading")

    // Pitch down 45 deg -> too-low
    let radDown = Float(-45.0 * Double.pi / 180.0)
    let tiltedDown = simd_float4x4(columns: (
      SIMD4<Float>(1, 0, 0, 0),
      SIMD4<Float>(0, cos(radDown), sin(radDown), 0),
      SIMD4<Float>(0, -sin(radDown), cos(radDown), 0),
      SIMD4<Float>(0, 1.15, 0, 1)
    ))
    expect(CorridorAnalyzer.aimState(pitchDegrees: CorridorAnalyzer.cameraPitchDegrees(transform: tiltedDown)) == "too-low", "Downward tilt should coach camera aim")

    let depth = buffer(w, h, format: kCVPixelFormatType_DepthFloat32)
    let conf = buffer(w, h, format: kCVPixelFormatType_OneComponent8)
    fill(conf, with: UInt8(2))

    // 1. Open corridor ahead (4.0m everywhere)
    fill(depth, with: Float(4.0))
    let map = DepthMap(depth: depth, confidence: conf, imageSize: imageSize)!
    let openResult = map.read { samples in
      CorridorAnalyzer.analyze(samples: samples, intrinsics: intrinsics, imageSize: imageSize, cameraTransform: levelNorth, headingAligned: true, knownFloorY: 0)
    }!
    expect(openResult.valid && openResult.corridorState == "clear", "4m uniform depth should report a clear corridor")
    expect(abs(openResult.recommendedHeadingOffsetDeg) < 0.1, "Clear corridor should recommend heading straight ahead")
    expect(openResult.hazards.isEmpty, "Clear corridor at 4m should produce no hazards")

    // 2. Obstacle blocking left and center (1.0m), open on right (4.0m) -> recommend steering right
    fillWith(depth) { x, _ in
      return x < Int(Double(w) * 0.62) ? Float(1.0) : Float(4.0)
    }
    let steerRight = map.read { samples in
      CorridorAnalyzer.analyze(samples: samples, intrinsics: intrinsics, imageSize: imageSize, cameraTransform: levelNorth, headingAligned: true, knownFloorY: 0)
    }!
    expect(steerRight.corridorState == "narrow", "Blocked center with open right should be narrow")
    expect(steerRight.recommendedHeadingOffsetDeg >= 15, "Blocked left/center should recommend steering right, got \(steerRight.recommendedHeadingOffsetDeg)")
    expect(steerRight.hazards.contains(where: { $0.kind == "obstacle" }), "Obstacle at 1.0m should produce an obstacle hazard")

    // 3. Fully blocked wall at 0.8m -> blocked + urgent obstacle
    fill(depth, with: Float(0.8))
    let blocked = map.read { samples in
      CorridorAnalyzer.analyze(samples: samples, intrinsics: intrinsics, imageSize: imageSize, cameraTransform: levelNorth, headingAligned: true, knownFloorY: 0)
    }!
    expect(blocked.corridorState == "blocked", "Wall at 0.8m across all sectors should report blocked")
    expect(blocked.hazards.contains(where: { $0.kind == "obstacle" && $0.severity == "urgent" }), "0.8m wall should trigger urgent severity")

    // 4. Head-height overhang (top rows at 1.2m, torso rows at 4.0m) -> head-height hazard
    fillWith(depth) { x, y in
      let centerX = abs(x - w / 2) < w / 4
      if centerX && y < h / 3 { return Float(1.2) }
      return Float(4.0)
    }
    let overhang = map.read { samples in
      CorridorAnalyzer.analyze(samples: samples, intrinsics: intrinsics, imageSize: imageSize, cameraTransform: levelNorth, headingAligned: true, knownFloorY: 0)
    }!
    expect(overhang.hazards.contains(where: { $0.kind == "head-height" }), "Close top-band obstacle with open torso below should detect head-height hazard")

    // 5. Floor drop-off / step-down ahead: camera pitched slightly down (-25 deg) seeing floor at y=0 near (0.8..1.2m) and dropping to y=-0.45m ahead (1.4..2.0m)
    let radFloor = Float(-25.0 * Double.pi / 180.0)
    let pitchedForFloor = simd_float4x4(columns: (
      SIMD4<Float>(1, 0, 0, 0),
      SIMD4<Float>(0, cos(radFloor), sin(radFloor), 0),
      SIMD4<Float>(0, -sin(radFloor), cos(radFloor), 0),
      SIMD4<Float>(0, 1.15, 0, 1)
    ))
    let forwardWorld = -SIMD3<Float>(pitchedForFloor.columns.2.x, pitchedForFloor.columns.2.y, pitchedForFloor.columns.2.z)
    let horizLen = hypot(forwardWorld.x, forwardWorld.z)
    let horizFwd = SIMD2<Float>(forwardWorld.x / horizLen, forwardWorld.z / horizLen)
    fillWith(depth) { x, y in
      let nx = (Float(x) + 0.5) / Float(w)
      let ny = (Float(y) + 0.5) / Float(h)
      let rayCam = SIMD3<Float>((nx * 960 - 480) / 650, -((ny * 720 - 360) / 650), -1.0)
      let rayWorld = SIMD3<Float>(
        pitchedForFloor.columns.0.x * rayCam.x + pitchedForFloor.columns.1.x * rayCam.y + pitchedForFloor.columns.2.x * rayCam.z,
        pitchedForFloor.columns.0.y * rayCam.x + pitchedForFloor.columns.1.y * rayCam.y + pitchedForFloor.columns.2.y * rayCam.z,
        pitchedForFloor.columns.0.z * rayCam.x + pitchedForFloor.columns.1.z * rayCam.y + pitchedForFloor.columns.2.z * rayCam.z
      )
      guard rayWorld.y < -0.05 else { return Float(4.5) }
      // Intersect with y = 0 first to find fwd distance
      let tFlat = (0.0 - 1.15) / rayWorld.y
      let fwdFlat = (rayWorld.x * tFlat) * horizFwd.x + (rayWorld.z * tFlat) * horizFwd.y
      if fwdFlat >= 0.65 && fwdFlat < 1.25 { return tFlat }
      if fwdFlat >= 1.25 && fwdFlat <= 2.3 {
        // Drop floor to y = -0.45m
        return (-0.45 - 1.15) / rayWorld.y
      }
      return Float(4.5)
    }
    let dropOff = map.read { samples in
      CorridorAnalyzer.analyze(samples: samples, intrinsics: intrinsics, imageSize: imageSize, cameraTransform: pitchedForFloor, headingAligned: true, knownFloorY: 0)
    }!
    expect(dropOff.hazards.contains(where: { $0.kind == "drop-off" || $0.kind == "step-down" }), "Sudden floor drop ahead should trigger drop-off or step-down hazard")
  }

  static func checkApproachDoorwaysAndStandby() {
    func makeSectors(_ clearances: [Double]) -> [CorridorSector] {
      (0..<7).map { i in
        CorridorSector(
          index: i,
          centerDegrees: CorridorAnalyzer.sectorCenters[i],
          label: CorridorAnalyzer.sectorLabels[i],
          clearanceMeters: clearances[i],
          sampleCount: 12,
          confidence: 0.9
        )
      }
    }

    func camAt(z: Float, pitchDeg: Double = 0) -> simd_float4x4 {
      let rad = Float(pitchDeg * Double.pi / 180.0)
      return simd_float4x4(columns: (
        SIMD4<Float>(1, 0, 0, 0),
        SIMD4<Float>(0, cos(rad), sin(rad), 0),
        SIMD4<Float>(0, -sin(rad), cos(rad), 0),
        SIMD4<Float>(0, 1.15, z, 1)
      ))
    }

    // 1. Fast cyclist approaching stationary user at 4.0 m/s in ahead-left sector (index 2)
    let cyclistTracker = ApproachTracker()
    _ = cyclistTracker.update(timestamp: 1.0, cameraTransform: camAt(z: 0), sectors: makeSectors([4.8, 4.8, 4.0, 4.8, 4.8, 4.8, 4.8]), aimState: "level")
    _ = cyclistTracker.update(timestamp: 1.2, cameraTransform: camAt(z: 0), sectors: makeSectors([4.8, 4.8, 3.2, 4.8, 4.8, 4.8, 4.8]), aimState: "level")
    let cyclistEst = cyclistTracker.update(timestamp: 1.4, cameraTransform: camAt(z: 0), sectors: makeSectors([4.8, 4.8, 2.4, 4.8, 4.8, 4.8, 4.8]), aimState: "level")
    expect(cyclistEst.fastMover?.kind == "fast-mover", "Approaching cyclist at 4 m/s must emit fast-mover hazard")
    expect(cyclistEst.fastMover?.direction == "ahead-left", "Fast mover direction must match sector 2 (ahead-left)")
    expect((cyclistEst.fastMover?.externalSpeedMps ?? 0) >= 2.5, "External speed must reflect cyclist speed")
    expect((cyclistEst.fastMover?.ttcSeconds ?? 99) < 1.2, "Time to collision must be computed accurately")

    // 2. User walking forward at 1.2 m/s toward a static wall -> NO false fast-mover!
    let walkTracker = ApproachTracker()
    _ = walkTracker.update(timestamp: 1.0, cameraTransform: camAt(z: 0.00), sectors: makeSectors([3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0]), aimState: "level")
    _ = walkTracker.update(timestamp: 1.2, cameraTransform: camAt(z: -0.24), sectors: makeSectors([2.76, 2.76, 2.76, 2.76, 2.76, 2.76, 2.76]), aimState: "level")
    let walkEst = walkTracker.update(timestamp: 1.4, cameraTransform: camAt(z: -0.48), sectors: makeSectors([2.52, 2.52, 2.52, 2.52, 2.52, 2.52, 2.52]), aimState: "level")
    expect(walkEst.fastMover == nil, "Walking toward a static wall must never trigger a false fast-mover alert")

    // 3. Receding person walking away ahead -> recedingCenter == true
    let recedeTracker = ApproachTracker()
    _ = recedeTracker.update(timestamp: 1.0, cameraTransform: camAt(z: 0), sectors: makeSectors([4.8, 4.8, 4.8, 1.5, 4.8, 4.8, 4.8]), aimState: "level")
    _ = recedeTracker.update(timestamp: 1.2, cameraTransform: camAt(z: 0), sectors: makeSectors([4.8, 4.8, 4.8, 1.8, 4.8, 4.8, 4.8]), aimState: "level")
    let recedeEst = recedeTracker.update(timestamp: 1.4, cameraTransform: camAt(z: 0), sectors: makeSectors([4.8, 4.8, 4.8, 2.1, 4.8, 4.8, 4.8]), aimState: "level")
    expect(recedeEst.recedingCenter, "Object moving away from camera should flag recedingCenter")
    expect(recedeEst.fastMover == nil, "Receding person must never trigger fast-mover")

    // 4. Doorway / opening flanked by close walls
    let doorwaySectors = makeSectors([1.2, 1.2, 1.2, 4.2, 1.2, 1.2, 1.2])
    let openings = CorridorAnalyzer.detectOpenings(sectors: doorwaySectors)
    expect(openings.count == 1 && openings[0].direction == "ahead", "Deep gap flanked by walls should detect an ahead opening")

    // 5. Lowered phone (-70 deg) & covered lens (0.15m everywhere) -> standby with zero hazards
    let w = 48
    let h = 36
    let imageSize = CGSize(width: 960, height: 720)
    let intrinsics = simd_float3x3(columns: (
      SIMD3<Float>(650, 0, 0),
      SIMD3<Float>(0, 650, 0),
      SIMD3<Float>(480, 360, 1)
    ))
    let depth = buffer(w, h, format: kCVPixelFormatType_DepthFloat32)
    let conf = buffer(w, h, format: kCVPixelFormatType_OneComponent8)
    fill(conf, with: UInt8(2))
    fill(depth, with: Float(1.5))
    let map = DepthMap(depth: depth, confidence: conf, imageSize: imageSize)!

    let lowered = map.read { samples in
      CorridorAnalyzer.analyze(samples: samples, intrinsics: intrinsics, imageSize: imageSize, cameraTransform: camAt(z: 0, pitchDeg: -70), headingAligned: true, knownFloorY: 0)
    }!
    expect(lowered.aimState == "lowered" && !lowered.valid && lowered.hazards.isEmpty, "Phone lowered below -58 deg must enter lowered standby with no hazards")

    fill(depth, with: Float(0.15))
    let covered = map.read { samples in
      CorridorAnalyzer.analyze(samples: samples, intrinsics: intrinsics, imageSize: imageSize, cameraTransform: camAt(z: 0, pitchDeg: 0), headingAligned: true, knownFloorY: 0)
    }!
    expect(covered.aimState == "covered" && !covered.valid && covered.hazards.isEmpty, "Lens covered by hand or pocket must enter covered standby with no hazards")
  }

  static func fillWith(_ buffer: CVPixelBuffer, _ generator: (Int, Int) -> Float) {
    expect(CVPixelBufferLockBaseAddress(buffer, []) == kCVReturnSuccess, "Lock a Core Video fixture")
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    let bytes = CVPixelBufferGetBaseAddress(buffer)!
    for row in 0..<CVPixelBufferGetHeight(buffer) {
      let pixels = bytes.advanced(by: row * CVPixelBufferGetBytesPerRow(buffer)).assumingMemoryBound(to: Float.self)
      for column in 0..<CVPixelBufferGetWidth(buffer) { pixels[column] = generator(column, row) }
    }
  }

  static func expect(_ passes: Bool, _ message: String) {
    if !passes { fatalError(message) }
  }
}
