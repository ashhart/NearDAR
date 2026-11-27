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
    checkThermalGovernor()
    checkLightAnalyzer()
    checkLanyardCalibration()
    checkMonocularDepthFallback()
    checkPerceptionContractFields()
    print("iOS perception checks passed: timestamps, portrait projection, depth buffers, alignment dwell, obstacle identity, corridor analyzer, approach velocity, doorways, standby, thermal governor, light analyzer, lanyard calibration, monocular fallback, and contract fields.")
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

  static func checkThermalGovernor() {
    let nominalMoving = ThermalGovernor.policy(thermalState: "nominal", isStationary: false)
    expect(nominalMoving.proximityIntervalMs == 120.0 && nominalMoving.visionIntervalSec == 0.55 && nominalMoving.proactiveVlmAllowed, "Nominal moving policy must use 120ms proximity, 0.55s vision, proactive VLM enabled")

    let nominalStill = ThermalGovernor.policy(thermalState: "nominal", isStationary: true)
    expect(nominalStill.proximityIntervalMs == 220.0 && nominalStill.visionIntervalSec == 1.2 && nominalStill.proactiveVlmAllowed, "Nominal stationary policy must relax to 220ms proximity and 1.2s vision")

    let fairMoving = ThermalGovernor.policy(thermalState: "fair", isStationary: false)
    expect(fairMoving.proximityIntervalMs == 180.0 && fairMoving.visionIntervalSec == 0.95 && fairMoving.proactiveVlmAllowed, "Fair moving policy must use 180ms proximity and 0.95s vision with VLM enabled")

    let fairStill = ThermalGovernor.policy(thermalState: "fair", isStationary: true)
    expect(fairStill.proximityIntervalMs == 300.0 && fairStill.visionIntervalSec == 0.95 && fairStill.proactiveVlmAllowed, "Fair stationary policy must use 300ms proximity")

    let serious = ThermalGovernor.policy(thermalState: "serious", isStationary: false)
    expect(serious.proximityIntervalMs == 280.0 && serious.visionIntervalSec == 1.6 && !serious.proactiveVlmAllowed, "Serious thermal policy must disable proactive VLM while keeping proximity alive at 280ms")

    let critical = ThermalGovernor.policy(thermalState: "critical", isStationary: true)
    expect(critical.proximityIntervalMs == 380.0 && critical.visionIntervalSec == 2.5 && !critical.proactiveVlmAllowed, "Critical thermal policy must throttle to 380ms/2.5s and disable proactive VLM")

    // Respect slower caller-configured base proximity interval
    let customBase = ThermalGovernor.policy(thermalState: "nominal", isStationary: false, baseProximityIntervalMs: 250.0)
    expect(customBase.proximityIntervalMs == 250.0, "Governor must never speed up past user baseProximityIntervalMs")

    // Stationary tracker over 3s sliding window
    let tracker = StationaryTracker(windowSeconds: 3.0, movementThresholdMeters: 0.25)
    expect(!tracker.observe(timestamp: 10.0, position: SIMD3(0, 1.15, 0)), "Initial sample cannot be stationary")
    expect(!tracker.observe(timestamp: 11.5, position: SIMD3(0.03, 1.15, -0.02)), "1.5s elapsed is still under 3s window")
    expect(tracker.observe(timestamp: 13.05, position: SIMD3(0.04, 1.15, 0.02)), "3s of small sway (<0.25m) must classify as stationary")
    expect(!tracker.observe(timestamp: 13.5, position: SIMD3(0.04, 1.15, -0.60)), "Walking 0.6m must immediately clear stationary state")
    expect(!tracker.observe(timestamp: 15.0, position: SIMD3(0.04, 1.15, -0.62)), "Stopping for only 1.5s is not yet stationary")
    expect(tracker.observe(timestamp: 16.6, position: SIMD3(0.05, 1.15, -0.61)), "Stopping for 3s at new position must return to stationary")
  }

  static func checkLightAnalyzer() {
    // 1. YCbCr 420f bi-planar Y-plane sampling (ARKit native format)
    let yuv = buffer(64, 48, format: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange)

    fillPlane0(yuv, with: 18) // ~0.07 -> dark
    let darkYuv = LightAnalyzer.analyze(pixelBuffer: yuv)!
    expect(darkYuv.lightingState == "dark" && darkYuv.luma < 0.14 && darkYuv.sampleCount > 0, "Low Y-plane luma must classify as dark")

    fillPlane0(yuv, with: 54) // ~0.21 -> dim
    let dimYuv = LightAnalyzer.analyze(pixelBuffer: yuv)!
    expect(dimYuv.lightingState == "dim" && dimYuv.luma >= 0.14 && dimYuv.luma < 0.28, "Mid-low Y-plane luma must classify as dim")

    fillPlane0(yuv, with: 180) // ~0.71 -> good
    let goodYuv = LightAnalyzer.analyze(pixelBuffer: yuv)!
    expect(goodYuv.lightingState == "good" && goodYuv.luma >= 0.28, "Bright Y-plane luma must classify as good")

    // 2. BGRA fallback sampling
    let bgra = buffer(64, 48, format: kCVPixelFormatType_32BGRA)

    fillBGRA(bgra, r: 10, g: 12, b: 10)
    let darkBGRA = LightAnalyzer.analyze(pixelBuffer: bgra)!
    expect(darkBGRA.lightingState == "dark" && darkBGRA.luma < 0.14, "Dark BGRA frame must classify as dark")

    fillBGRA(bgra, r: 52, g: 56, b: 50)
    let dimBGRA = LightAnalyzer.analyze(pixelBuffer: bgra)!
    expect(dimBGRA.lightingState == "dim" && dimBGRA.luma >= 0.14 && dimBGRA.luma < 0.28, "Dim BGRA frame must classify as dim")

    fillBGRA(bgra, r: 210, g: 210, b: 205)
    let goodBGRA = LightAnalyzer.analyze(pixelBuffer: bgra)!
    expect(goodBGRA.lightingState == "good" && goodBGRA.luma >= 0.28, "Bright BGRA frame must classify as good")
  }

  static func checkLanyardCalibration() {
    // At -42 deg downward hang: handheld complains too-low, lanyard (+14 deg -> -28 deg) is level!
    expect(CorridorAnalyzer.aimState(pitchDegrees: -42.0, mountMode: "handheld") == "too-low", "Handheld at -42 deg must report too-low")
    expect(CorridorAnalyzer.aimState(pitchDegrees: -42.0, mountMode: "lanyard") == "level", "Lanyard at -42 deg (+14 deg compensation) must report level")

    // At -62 deg: handheld enters lowered standby (<-58), lanyard stays active (requires <-68)
    expect(CorridorAnalyzer.aimState(pitchDegrees: -62.0, mountMode: "handheld") == "lowered", "Handheld at -62 deg must enter lowered standby")
    expect(CorridorAnalyzer.aimState(pitchDegrees: -62.0, mountMode: "lanyard") == "too-low", "Lanyard at -62 deg must not falsely enter lowered standby")

    // At -70 deg: lanyard finally enters lowered standby (<-68)
    expect(CorridorAnalyzer.aimState(pitchDegrees: -70.0, mountMode: "lanyard") == "lowered", "Lanyard below -68 deg must enter lowered standby")

    // Verify CorridorAnalyzer.analyze respects mountMode end-to-end
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
    fill(depth, with: Float(3.5))
    let map = DepthMap(depth: depth, confidence: conf, imageSize: imageSize)!

    func camWithPitch(_ deg: Double) -> simd_float4x4 {
      let rad = Float(deg * Double.pi / 180.0)
      return simd_float4x4(columns: (
        SIMD4<Float>(1, 0, 0, 0),
        SIMD4<Float>(0, cos(rad), sin(rad), 0),
        SIMD4<Float>(0, -sin(rad), cos(rad), 0),
        SIMD4<Float>(0, 1.15, 0, 1)
      ))
    }

    let lanyardLevel = map.read { samples in
      CorridorAnalyzer.analyze(samples: samples, intrinsics: intrinsics, imageSize: imageSize, cameraTransform: camWithPitch(-42), headingAligned: true, knownFloorY: 0, mountMode: "lanyard")
    }!
    expect(lanyardLevel.valid && lanyardLevel.aimState == "level", "Chest-mounted phone at -42 deg must produce a valid level corridor analysis")

    let lanyardLowered = map.read { samples in
      CorridorAnalyzer.analyze(samples: samples, intrinsics: intrinsics, imageSize: imageSize, cameraTransform: camWithPitch(-72), headingAligned: true, knownFloorY: 0, mountMode: "lanyard")
    }!
    expect(!lanyardLowered.valid && lanyardLowered.aimState == "lowered" && lanyardLowered.hazards.isEmpty, "Lanyard phone below -68 deg must enter standby with zero hazards")
  }

  static func checkMonocularDepthFallback() {
    let levelNorth = simd_float4x4(columns: (
      SIMD4<Float>(1, 0, 0, 0),
      SIMD4<Float>(0, 1, 0, 0),
      SIMD4<Float>(0, 0, 1, 0),
      SIMD4<Float>(0, 1.15, 0, 1)
    ))

    // 1. Sparse feature points blocking center & left at 1.2m while right is open -> narrow, steer right
    var points: [SIMD3<Float>] = []
    for i in 0..<8 {
      let x = Float(-0.6 + Double(i) * 0.12) // spans left to ahead
      let y = Float(0.6 + Double(i % 3) * 0.35) // inside 0.25m..1.85m torso band
      points.append(SIMD3<Float>(x, y, -1.2))
    }
    // Add out-of-band floor & ceiling points that must be ignored
    for i in 0..<10 {
      points.append(SIMD3<Float>(Float(i) * 0.05, 0.05, -0.7)) // floor noise
      points.append(SIMD3<Float>(Float(i) * 0.05, 2.40, -0.7)) // ceiling noise
    }
    let featureResult = MonocularDepthFallback.analyze(
      featurePoints: points,
      cameraTransform: levelNorth,
      headingAligned: true,
      knownFloorY: 0
    )
    expect(featureResult.valid, "Sufficient torso-band feature points must build a valid fallback corridor")
    expect(featureResult.corridorState == "narrow", "Blocked center/left with open right should report narrow, got \(featureResult.corridorState)")
    expect(featureResult.recommendedHeadingOffsetDeg >= 15.0, "Fallback corridor must steer right toward open space, got \(featureResult.recommendedHeadingOffsetDeg)")
    expect(featureResult.hazards.contains(where: { $0.kind == "obstacle" && $0.distanceMeters < 1.5 }), "Close feature-point cluster ahead must emit obstacle hazard")

    // 2. Insufficient points without visual detections -> invalid / unavailable
    let tooSparse = MonocularDepthFallback.analyze(
      featurePoints: [SIMD3<Float>(0, 1.0, -2.0), SIMD3<Float>(0.1, 1.0, -2.0)],
      cameraTransform: levelNorth,
      headingAligned: true,
      knownFloorY: 0
    )
    expect(!tooSparse.valid && tooSparse.corridorState == "unknown", "Too few feature points must stay conservatively unavailable")

    // 3. Visual height-prior distance hints (person ~1.68m, dog ~0.50m)
    let personDist = MonocularDepthFallback.estimateDistanceMeters(label: "person", verticalSpanFraction: 0.50, verticalFocalNormalized: 0.80)!
    expect(abs(personDist - 2.688) < 0.02, "Person height prior (1.68m) should estimate ~2.69m at 50% height")

    let dogDist = MonocularDepthFallback.estimateDistanceMeters(label: "dog", verticalSpanFraction: 0.25, verticalFocalNormalized: 0.80)!
    expect(abs(dogDist - 1.60) < 0.02, "Dog height prior (0.50m) should estimate ~1.60m at 25% height")

    let visualOnly = MonocularDepthFallback.analyze(
      featurePoints: [],
      visualDetections: [
        MonocularVisualDetection(label: "person", bearingDegrees: 0, verticalSpanFraction: 0.72, confidence: 0.85)
      ],
      cameraTransform: levelNorth,
      headingAligned: true,
      knownFloorY: 0,
      verticalFocalNormalized: 0.80
    )
    expect(visualOnly.valid, "Visual height-prior detection without LiDAR must yield a conservative valid corridor")
    expect(visualOnly.hazards.contains(where: { $0.kind == "obstacle" && $0.distanceMeters < 2.2 }), "Close visual person hint (~1.87m) must produce a forward obstacle hazard")
  }

  static func checkPerceptionContractFields() {
    let native: [String: Any] = [
      "id": "snap-1",
      "cameraTimestampMs": 1_700_000_000_000.0,
      "trackingState": "normal",
      "depthState": "available",
      "depthSource": "lidar",
      "thermalState": "serious",
      "proactiveVlmAllowed": false,
      "lightingState": "dark",
      "ambientLuma": 0.06,
      "aimState": "level",
      "pitchDegrees": -20.0,
      "sensorHealth": ["issues": [] as [String]],
      "obstacles": [] as [[String: Any]],
      "objects": [] as [[String: Any]],
      "freeSeats": [] as [[String: Any]],
      "ocr": [] as [[String: Any]]
    ]
    let mapped = PerceptionContract.snapshot(native)
    expect(mapped["depthSource"] as? String == "lidar", "Contract must expose depthSource")
    expect(mapped["thermalState"] as? String == "serious", "Contract must expose thermalState")
    expect(mapped["proactiveVlmAllowed"] as? Bool == false, "Contract must expose proactiveVlmAllowed")
    expect(mapped["lightingState"] as? String == "dark", "Contract must expose lightingState")
    expect(abs((mapped["ambientLuma"] as? Double ?? -1) - 0.06) < 0.0001, "Contract must expose ambientLuma")
    let notes = mapped["notes"] as? [String] ?? []
    expect(notes.contains(where: { $0.lowercased().contains("dark") && $0.lowercased().contains("lidar") }), "Dark lighting snapshot must note that LiDAR remains active in zero light")
  }

  static func fillPlane0(_ buffer: CVPixelBuffer, with value: UInt8) {
    expect(CVPixelBufferLockBaseAddress(buffer, []) == kCVReturnSuccess, "Lock YUV fixture")
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0)!.assumingMemoryBound(to: UInt8.self)
    let width = CVPixelBufferGetWidthOfPlane(buffer, 0)
    let height = CVPixelBufferGetHeightOfPlane(buffer, 0)
    let bytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
    for row in 0..<height {
      for col in 0..<width {
        base[row * bytesPerRow + col] = value
      }
    }
  }

  static func fillBGRA(_ buffer: CVPixelBuffer, r: UInt8, g: UInt8, b: UInt8) {
    expect(CVPixelBufferLockBaseAddress(buffer, []) == kCVReturnSuccess, "Lock BGRA fixture")
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    let base = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
    for row in 0..<height {
      for col in 0..<width {
        let idx = row * bytesPerRow + col * 4
        base[idx] = b
        base[idx + 1] = g
        base[idx + 2] = r
        base[idx + 3] = 255
      }
    }
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
