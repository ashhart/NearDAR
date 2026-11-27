import CoreVideo
import Foundation
import ImageIO
import simd

struct CorridorSector {
  let index: Int
  let centerDegrees: Double
  let label: String
  let clearanceMeters: Double
  let sampleCount: Int
  let confidence: Double
}

struct CorridorOpening {
  let bearingDegrees: Double
  let direction: String
  let distanceMeters: Double
  let clearanceMeters: Double
  let widthDegrees: Double

  func toDictionary() -> [String: Any] {
    [
      "bearingDegrees": bearingDegrees,
      "direction": direction,
      "distanceMeters": distanceMeters,
      "clearanceMeters": clearanceMeters,
      "widthDegrees": widthDegrees
    ]
  }
}

struct SpatialHazard {
  let id: String
  let kind: String // "fast-mover" | "obstacle" | "head-height" | "step-down" | "step-up" | "drop-off" | "doorway"
  let severity: String // "info" | "caution" | "urgent"
  let direction: String
  let bearingDegrees: Double
  let distanceMeters: Double
  let confidence: Double
  let message: String
  let closingSpeedMps: Double?
  let externalSpeedMps: Double?
  let ttcSeconds: Double?

  init(
    id: String,
    kind: String,
    severity: String,
    direction: String,
    bearingDegrees: Double,
    distanceMeters: Double,
    confidence: Double,
    message: String,
    closingSpeedMps: Double? = nil,
    externalSpeedMps: Double? = nil,
    ttcSeconds: Double? = nil
  ) {
    self.id = id
    self.kind = kind
    self.severity = severity
    self.direction = direction
    self.bearingDegrees = bearingDegrees
    self.distanceMeters = distanceMeters
    self.confidence = confidence
    self.message = message
    self.closingSpeedMps = closingSpeedMps
    self.externalSpeedMps = externalSpeedMps
    self.ttcSeconds = ttcSeconds
  }
}

struct ApproachEstimate {
  let sectorClosingSpeedMps: [Double]
  let sectorExternalSpeedMps: [Double]
  let maxClosingSpeedMps: Double
  let recedingCenter: Bool
  let fastMover: SpatialHazard?
}

/// Multi-frame world-compensated approach velocity tracker.
/// Subtracts the user's own walking velocity along each sector ray so static walls never trigger
/// false alarms, while approaching cyclists, e-scooters, runners, or loose dogs are flagged rapidly.
final class ApproachTracker {
  private struct FrameState {
    let timestamp: Double
    let positionXZ: SIMD2<Float>
    let forwardXZ: SIMD2<Float>
    let clearances: [Double]
    let validMask: [Bool]
  }

  private var previous: FrameState?
  private var emaClosing = Array(repeating: 0.0, count: 7)
  private var emaExternal = Array(repeating: 0.0, count: 7)
  private var fastStreak = Array(repeating: 0, count: 7)

  func reset() {
    previous = nil
    emaClosing = Array(repeating: 0.0, count: 7)
    emaExternal = Array(repeating: 0.0, count: 7)
    fastStreak = Array(repeating: 0, count: 7)
  }

  func update(
    timestamp: Double,
    cameraTransform: simd_float4x4,
    sectors: [CorridorSector],
    aimState: String
  ) -> ApproachEstimate {
    let neutral = ApproachEstimate(
      sectorClosingSpeedMps: Array(repeating: 0, count: 7),
      sectorExternalSpeedMps: Array(repeating: 0, count: 7),
      maxClosingSpeedMps: 0,
      recedingCenter: false,
      fastMover: nil
    )

    guard sectors.count == 7, aimState != "lowered", aimState != "covered" else {
      reset()
      return neutral
    }

    let posXZ = SIMD2<Float>(cameraTransform.columns.3.x, cameraTransform.columns.3.z)
    let rawFwd = -SIMD2<Float>(cameraTransform.columns.2.x, cameraTransform.columns.2.z)
    let fwdLen = simd_length(rawFwd)
    guard fwdLen >= 0.25 else {
      reset()
      return neutral
    }
    let fwdXZ = rawFwd / fwdLen
    let rightXZ = SIMD2<Float>(-fwdXZ.y, fwdXZ.x)

    let clearances = sectors.map(\.clearanceMeters)
    let validMask = sectors.map { $0.sampleCount >= 3 && $0.clearanceMeters > 0.25 && $0.clearanceMeters < CorridorAnalyzer.maxRangeMeters - 0.15 }

    let current = FrameState(
      timestamp: timestamp,
      positionXZ: posXZ,
      forwardXZ: fwdXZ,
      clearances: clearances,
      validMask: validMask
    )

    guard let prev = previous else {
      previous = current
      return neutral
    }

    let dt = timestamp - prev.timestamp
    if abs(dt) < 0.001 {
      // Same frame re-evaluated (e.g. capture on current ARFrame); preserve existing state.
      return buildEstimate(sectors: sectors)
    }
    if dt < 0.05 || dt > 0.85 {
      reset()
      previous = current
      return neutral
    }

    // Reject rapid camera panning so swinging the phone past a wall does not create synthetic velocity.
    let dotFwd = max(-1.0, min(1.0, Double(simd_dot(prev.forwardXZ, fwdXZ))))
    let deltaYawDeg = acos(dotFwd) * 180.0 / Double.pi
    if deltaYawDeg > 12.0 {
      reset()
      previous = current
      return neutral
    }

    let dCam = posXZ - prev.positionXZ
    let camSpeed = Double(simd_length(dCam)) / dt
    if camSpeed > 6.5 {
      // Unrealistic ARKit relocalization jump
      reset()
      previous = current
      return neutral
    }

    for i in 0..<7 {
      if prev.validMask[i] && current.validMask[i] {
        let rawClosing = (prev.clearances[i] - current.clearances[i]) / dt
        // Guard against sharp occlusion edges / stepping past a doorframe (> 16 m/s is noise/step jump)
        if abs(rawClosing) > 16.0 {
          fastStreak[i] = 0
          emaClosing[i] *= 0.4
          emaExternal[i] *= 0.4
          continue
        }
        let rad = Float(CorridorAnalyzer.sectorCenters[i] * Double.pi / 180.0)
        let ray = fwdXZ * cos(rad) + rightXZ * sin(rad)
        let camAlongRay = Double(simd_dot(dCam, ray)) / dt
        let rawExternal = rawClosing - camAlongRay

        let alpha = 0.55
        emaClosing[i] = emaClosing[i] * (1.0 - alpha) + rawClosing * alpha
        emaExternal[i] = emaExternal[i] * (1.0 - alpha) + rawExternal * alpha

        if rawExternal >= 1.25 && rawClosing >= 1.35 && current.clearances[i] <= 4.5 {
          fastStreak[i] += 1
        } else {
          fastStreak[i] = 0
        }
      } else {
        fastStreak[i] = 0
        emaClosing[i] *= 0.35
        emaExternal[i] *= 0.35
      }
    }

    previous = current
    return buildEstimate(sectors: sectors)
  }

  private func buildEstimate(sectors: [CorridorSector]) -> ApproachEstimate {
    var bestFast: SpatialHazard?
    var bestScore = -1.0

    for i in 0..<7 {
      let dist = sectors[i].clearanceMeters
      let ext = emaExternal[i]
      let closing = emaClosing[i]
      guard fastStreak[i] >= 2, ext >= 1.35, closing >= 1.5, dist > 0.25, dist <= 4.3 else { continue }
      let ttc = dist / max(0.3, closing)
      guard ttc <= 2.6 || dist <= 2.5 else { continue }
      let urgencyScore = (1.0 / max(0.2, ttc)) + (ext * 0.25)
      if urgencyScore > bestScore {
        bestScore = urgencyScore
        let dir = CorridorAnalyzer.directionLabel(for: sectors[i].centerDegrees)
        let spokenDir = dir.replacingOccurrences(of: "-", with: " ")
        let distText = dist < 1.0 ? "less than a metre" : String(format: "%.1f metres", dist)
        bestFast = SpatialHazard(
          id: "lidar-fast-mover",
          kind: "fast-mover",
          severity: "urgent",
          direction: dir,
          bearingDegrees: sectors[i].centerDegrees,
          distanceMeters: dist,
          confidence: min(0.95, max(0.7, sectors[i].confidence)),
          message: "Fast movement \(spokenDir), \(distText) — hold still.",
          closingSpeedMps: closing,
          externalSpeedMps: ext,
          ttcSeconds: ttc
        )
      }
    }

    let centerIndices = [2, 3, 4]
    let maxClosing = emaClosing.max() ?? 0
    let nearestCenter = centerIndices.min(by: { sectors[$0].clearanceMeters < sectors[$1].clearanceMeters }) ?? 3
    let recedingCenter = emaClosing[nearestCenter] <= -0.35 && fastStreak[nearestCenter] == 0

    return ApproachEstimate(
      sectorClosingSpeedMps: emaClosing,
      sectorExternalSpeedMps: emaExternal,
      maxClosingSpeedMps: maxClosing,
      recedingCenter: recedingCenter,
      fastMover: bestFast
    )
  }
}

struct CorridorAnalysis {
  let sectors: [CorridorSector]
  let openings: [CorridorOpening]
  let recommendedHeadingOffsetDeg: Double
  let corridorState: String // "clear" | "narrow" | "blocked" | "unknown"
  let forwardClearanceMeters: Double
  let bestClearanceMeters: Double
  let aimState: String // "level" | "too-low" | "too-high" | "lowered" | "covered"
  let pitchDegrees: Double
  let headingDegrees: Double?
  let floorHeightMeters: Double?
  let maxClosingSpeedMps: Double
  let recedingObstacle: Bool
  let hazards: [SpatialHazard]
  let valid: Bool

  func toDictionary() -> [String: Any] {
    var result: [String: Any] = [
      "sectors": sectors.map { sector in
        [
          "index": sector.index,
          "centerDegrees": sector.centerDegrees,
          "label": sector.label,
          "clearanceMeters": sector.clearanceMeters,
          "sampleCount": sector.sampleCount,
          "confidence": sector.confidence
        ] as [String: Any]
      },
      "openings": openings.map { $0.toDictionary() },
      "recommendedHeadingOffsetDeg": recommendedHeadingOffsetDeg,
      "corridorState": corridorState,
      "forwardClearanceMeters": forwardClearanceMeters,
      "bestClearanceMeters": bestClearanceMeters,
      "aimState": aimState,
      "pitchDegrees": pitchDegrees,
      "maxClosingSpeedMps": maxClosingSpeedMps,
      "recedingObstacle": recedingObstacle,
      "valid": valid
    ]
    if let headingDegrees { result["headingDegrees"] = headingDegrees }
    if let floorHeightMeters { result["floorHeightMeters"] = floorHeightMeters }
    return result
  }

  func hazardDictionaries(timestampMs: Double) -> [[String: Any]] {
    hazards.map { hazard in
      var dict: [String: Any] = [
        "id": hazard.id,
        "kind": hazard.kind,
        "severity": hazard.severity,
        "direction": hazard.direction,
        "bearingDegrees": hazard.bearingDegrees,
        "distanceMeters": hazard.distanceMeters,
        "confidence": hazard.confidence,
        "message": hazard.message,
        "observedAt": timestampMs
      ]
      if let closing = hazard.closingSpeedMps { dict["closingSpeedMps"] = closing }
      if let external = hazard.externalSpeedMps { dict["externalSpeedMps"] = external }
      if let ttc = hazard.ttcSeconds { dict["ttcSeconds"] = ttc }
      return dict
    }
  }

  func applying(approach: ApproachEstimate) -> CorridorAnalysis {
    var mergedHazards = hazards
    if let fast = approach.fastMover {
      mergedHazards.insert(fast, at: 0)
    } else if approach.recedingCenter {
      // De-escalate static torso obstacle if the surface ahead is actively moving away from the user.
      mergedHazards = mergedHazards.map { hazard in
        guard hazard.kind == "obstacle", hazard.severity == "caution" else { return hazard }
        return SpatialHazard(
          id: hazard.id,
          kind: hazard.kind,
          severity: "info",
          direction: hazard.direction,
          bearingDegrees: hazard.bearingDegrees,
          distanceMeters: hazard.distanceMeters,
          confidence: hazard.confidence,
          message: hazard.message,
          closingSpeedMps: approach.sectorClosingSpeedMps[3],
          externalSpeedMps: approach.sectorExternalSpeedMps[3]
        )
      }
    }
    return CorridorAnalysis(
      sectors: sectors,
      openings: openings,
      recommendedHeadingOffsetDeg: recommendedHeadingOffsetDeg,
      corridorState: corridorState,
      forwardClearanceMeters: forwardClearanceMeters,
      bestClearanceMeters: bestClearanceMeters,
      aimState: aimState,
      pitchDegrees: pitchDegrees,
      headingDegrees: headingDegrees,
      floorHeightMeters: floorHeightMeters,
      maxClosingSpeedMps: approach.maxClosingSpeedMps,
      recedingObstacle: approach.recedingCenter,
      hazards: mergedHazards,
      valid: valid
    )
  }
}

enum CorridorAnalyzer {
  static let sectorCenters: [Double] = [-45, -30, -15, 0, 15, 30, 45]
  static let sectorLabels: [String] = ["far-left", "left", "ahead-left", "ahead", "ahead-right", "right", "far-right"]
  static let maxRangeMeters: Double = 5.0
  private static let defaultCameraHeightAboveFloor: Float = 1.15

  static func cameraPitchDegrees(transform: simd_float4x4) -> Double {
    let forward = -SIMD3<Float>(transform.columns.2.x, transform.columns.2.y, transform.columns.2.z)
    let len = simd_length(forward)
    guard len > 0.001 else { return 0 }
    let ny = max(-1.0, min(1.0, Double(forward.y / len)))
    return asin(ny) * 180.0 / Double.pi
  }

  /// True-north heading in degrees [0, 360) when ARKit world alignment is `.gravityAndHeading` (-Z = North, +X = East).
  static func cameraHeadingDegrees(transform: simd_float4x4) -> Double? {
    let forward = -SIMD3<Float>(transform.columns.2.x, transform.columns.2.y, transform.columns.2.z)
    let east = Double(forward.x)
    let north = Double(-forward.z)
    let horiz = hypot(east, north)
    guard horiz >= 0.25 else { return nil }
    var degrees = atan2(east, north) * 180.0 / Double.pi
    if degrees < 0 { degrees += 360.0 }
    return degrees
  }

  static let lanyardPitchCompensationDegrees: Double = 14.0
  static let handheldLoweredThresholdDegrees: Double = -58.0
  static let lanyardLoweredThresholdDegrees: Double = -68.0

  static func aimState(pitchDegrees: Double, coveredFraction: Double = 0.0, mountMode: String = "handheld") -> String {
    if coveredFraction >= 0.85 { return "covered" }
    if mountMode == "lanyard" {
      if pitchDegrees < lanyardLoweredThresholdDegrees { return "lowered" }
      let effectivePitch = pitchDegrees + lanyardPitchCompensationDegrees
      if effectivePitch < -35.0 { return "too-low" }
      if effectivePitch > 25.0 { return "too-high" }
      return "level"
    }
    if pitchDegrees < handheldLoweredThresholdDegrees { return "lowered" }
    if pitchDegrees < -35.0 { return "too-low" }
    if pitchDegrees > 25.0 { return "too-high" }
    return "level"
  }

  static func directionLabel(for bearingDegrees: Double) -> String {
    if bearingDegrees < -37.5 { return "left" }
    if bearingDegrees < -10.0 { return "ahead-left" }
    if bearingDegrees > 37.5 { return "right" }
    if bearingDegrees > 10.0 { return "ahead-right" }
    return "ahead"
  }

  static func detectOpenings(sectors: [CorridorSector]) -> [CorridorOpening] {
    guard sectors.count == 7 else { return [] }
    var openings: [CorridorOpening] = []
    var skipNext = false
    for i in 1...5 {
      if skipNext {
        skipNext = false
        continue
      }
      let current = sectors[i].clearanceMeters
      guard current >= 2.8 else { continue }
      let leftFlank = sectors[i - 1].clearanceMeters
      let rightFlank = sectors[i + 1].clearanceMeters

      // Single-sector doorway / narrow gap (15 deg wide)
      if leftFlank < 1.75 && rightFlank < 1.75 && current - max(leftFlank, rightFlank) >= 1.1 {
        let flankDist = min(leftFlank, rightFlank)
        openings.append(CorridorOpening(
          bearingDegrees: sectors[i].centerDegrees,
          direction: directionLabel(for: sectors[i].centerDegrees),
          distanceMeters: flankDist,
          clearanceMeters: current,
          widthDegrees: 15.0
        ))
        continue
      }

      // Two-sector doorway / wide opening (30 deg wide)
      if i <= 4 && leftFlank < 1.75 && sectors[i + 1].clearanceMeters >= 2.8 && sectors[i + 2].clearanceMeters < 1.75 {
        let wideClear = min(current, sectors[i + 1].clearanceMeters)
        let farRightFlank = sectors[i + 2].clearanceMeters
        if wideClear - max(leftFlank, farRightFlank) >= 1.1 {
          let midBearing = (sectors[i].centerDegrees + sectors[i + 1].centerDegrees) * 0.5
          openings.append(CorridorOpening(
            bearingDegrees: midBearing,
            direction: directionLabel(for: midBearing),
            distanceMeters: min(leftFlank, farRightFlank),
            clearanceMeters: wideClear,
            widthDegrees: 30.0
          ))
          skipNext = true
        }
      }
    }
    return openings
  }

  static func analyze(
    samples: DepthMap.Samples,
    intrinsics: simd_float3x3,
    imageSize: CGSize,
    cameraTransform: simd_float4x4,
    headingAligned: Bool,
    knownFloorY: Float? = nil,
    warningDistance: Double = 2.5,
    criticalDistance: Double = 0.9,
    mountMode: String = "handheld"
  ) -> CorridorAnalysis {
    let pitch = cameraPitchDegrees(transform: cameraTransform)
    let baseAim = aimState(pitchDegrees: pitch, mountMode: mountMode)
    let heading = headingAligned ? cameraHeadingDegrees(transform: cameraTransform) : nil

    let camPos = SIMD3<Float>(cameraTransform.columns.3.x, cameraTransform.columns.3.y, cameraTransform.columns.3.z)
    let forwardWorld = -SIMD3<Float>(cameraTransform.columns.2.x, cameraTransform.columns.2.y, cameraTransform.columns.2.z)
    let horizLen = hypot(forwardWorld.x, forwardWorld.z)

    guard baseAim != "lowered", horizLen >= 0.20, imageSize.width > 0, imageSize.height > 0,
      intrinsics[0, 0] > 0, intrinsics[1, 1] > 0 else {
      return CorridorAnalysis(
        sectors: emptySectors(),
        openings: [],
        recommendedHeadingOffsetDeg: 0,
        corridorState: "unknown",
        forwardClearanceMeters: 0,
        bestClearanceMeters: 0,
        aimState: baseAim,
        pitchDegrees: pitch,
        headingDegrees: heading,
        floorHeightMeters: knownFloorY.map { Double($0) },
        maxClosingSpeedMps: 0,
        recedingObstacle: false,
        hazards: [],
        valid: false
      )
    }

    let horizFwd = SIMD2<Float>(forwardWorld.x / horizLen, forwardWorld.z / horizLen)
    // Right vector in world XZ plane: forward x up = (-forward.z, forward.x)
    let horizRight = SIMD2<Float>(-horizFwd.y, horizFwd.x)

    let fx = Float(intrinsics[0, 0])
    let fy = Float(intrinsics[1, 1])
    let cx = Float(intrinsics[2, 0])
    let cy = Float(intrinsics[2, 1])
    let resW = Float(imageSize.width)
    let resH = Float(imageSize.height)
    let width = samples.width
    let height = samples.height
    let strideX = max(1, width / 96)
    let strideY = max(1, height / 72)

    let estimatedFloorY = knownFloorY ?? (camPos.y - defaultCameraHeightAboveFloor)

    var sectorDistances = Array(repeating: [Double](), count: 7)
    var sectorConfSums = Array(repeating: 0.0, count: 7)
    var headDistances: [Double] = []
    var headBearings: [Double] = []
    var lowerCenterDistances: [Double] = []
    var floorNearY: [Float] = []
    var floorAheadY: [Float] = []
    var floorAheadDist: [Double] = []
    var totalValid = 0
    var nearCoveredCount = 0

    for y in stride(from: 0, to: height, by: strideY) {
      let ny = (Float(y) + 0.5) / Float(height)
      let py = ny * resH
      for x in stride(from: 0, to: width, by: strideX) {
        guard let reading = samples.sample(x: x, y: y, minimumConfidence: 1) else { continue }
        totalValid += 1
        let z = reading.metres
        if z < 0.28 {
          nearCoveredCount += 1
        }
        guard z >= 0.25, z <= 8.0 else { continue }
        let nx = (Float(x) + 0.5) / Float(width)
        let px = nx * resW

        // Camera local coordinates: +X right along sensor, +Y up along sensor, -Z forward
        let xCam = (px - cx) / fx * z
        let yCam = -((py - cy) / fy * z)
        let zCam = -z

        let world4 = cameraTransform * SIMD4<Float>(xCam, yCam, zCam, 1.0)
        let dx = world4.x - camPos.x
        let dz = world4.z - camPos.z
        let fwdDist = Double(dx * horizFwd.x + dz * horizFwd.y)
        guard fwdDist >= 0.25 else { continue }
        let rightDist = Double(dx * horizRight.x + dz * horizRight.y)
        let bearingDeg = atan2(rightDist, fwdDist) * 180.0 / Double.pi
        let heightAboveFloor = world4.y - estimatedFloorY
        let conf = Double(reading.confidence) / 2.0

        // Torso / walking corridor band (0.25m to 1.85m above floor)
        if heightAboveFloor >= 0.25 && heightAboveFloor <= 1.85 && abs(bearingDeg) <= 52.5 {
          let rawIndex = Int(floor((bearingDeg + 52.5) / 15.0))
          let idx = max(0, min(6, rawIndex))
          sectorDistances[idx].append(min(maxRangeMeters, fwdDist))
          sectorConfSums[idx] += conf
        }

        // Lower body center band for overhang comparison
        if abs(bearingDeg) <= 20.0 && heightAboveFloor >= 0.25 && heightAboveFloor <= 1.30 {
          lowerCenterDistances.append(min(maxRangeMeters, fwdDist))
        }

        // Head-height overhang band (relative to camera height, or 1.45m..2.15m above floor)
        let relY = world4.y - camPos.y
        if abs(bearingDeg) <= 22.0 && fwdDist <= 2.2 && ((heightAboveFloor >= 1.45 && heightAboveFloor <= 2.15) || (relY >= 0.05 && relY <= 0.65)) {
          headDistances.append(fwdDist)
          headBearings.append(bearingDeg)
        }

        // Floor / step-down / step-up band directly ahead (within +/-0.40m laterally, <= 0.45m above floor)
        if abs(rightDist) <= 0.40 && heightAboveFloor >= -0.85 && heightAboveFloor <= 0.45 {
          if fwdDist >= 0.60 && fwdDist < 1.25 {
            floorNearY.append(world4.y)
          } else if fwdDist >= 1.25 && fwdDist <= 2.35 {
            floorAheadY.append(world4.y)
            floorAheadDist.append(fwdDist)
          }
        }
      }
    }

    let coveredFraction = totalValid >= 10 ? Double(nearCoveredCount) / Double(totalValid) : 0.0
    let aim = aimState(pitchDegrees: pitch, coveredFraction: coveredFraction, mountMode: mountMode)

    guard totalValid >= 15, aim != "covered" else {
      return CorridorAnalysis(
        sectors: emptySectors(),
        openings: [],
        recommendedHeadingOffsetDeg: 0,
        corridorState: "unknown",
        forwardClearanceMeters: 0,
        bestClearanceMeters: 0,
        aimState: aim,
        pitchDegrees: pitch,
        headingDegrees: heading,
        floorHeightMeters: knownFloorY.map { Double($0) },
        maxClosingSpeedMps: 0,
        recedingObstacle: false,
        hazards: [],
        valid: false
      )
    }

    var sectors: [CorridorSector] = []
    sectors.reserveCapacity(7)
    for i in 0..<7 {
      var dists = sectorDistances[i]
      if dists.count >= 3 {
        dists.sort()
        let p10 = dists[max(0, Int(Double(dists.count - 1) * 0.10))]
        let meanConf = sectorConfSums[i] / Double(dists.count)
        sectors.append(CorridorSector(
          index: i,
          centerDegrees: sectorCenters[i],
          label: sectorLabels[i],
          clearanceMeters: p10,
          sampleCount: dists.count,
          confidence: meanConf
        ))
      } else {
        // No torso obstacles measured in this sector; treat as open if we have general valid depth, else low confidence
        sectors.append(CorridorSector(
          index: i,
          centerDegrees: sectorCenters[i],
          label: sectorLabels[i],
          clearanceMeters: maxRangeMeters,
          sampleCount: dists.count,
          confidence: dists.isEmpty ? 0.35 : sectorConfSums[i] / Double(dists.count)
        ))
      }
    }

    let openings = detectOpenings(sectors: sectors)

    // Score sectors using shoulder-width neighborhood (self + adjacent sectors) with mild center preference.
    var bestIndex = 3
    var bestScore = -1.0
    var bestEffectiveClearance = 0.0
    for i in 0..<7 {
      let leftClear = i > 0 ? sectors[i - 1].clearanceMeters : sectors[i].clearanceMeters
      let rightClear = i < 6 ? sectors[i + 1].clearanceMeters : sectors[i].clearanceMeters
      let selfClear = sectors[i].clearanceMeters
      // Effective passable clearance requires room for body width (blend center with tighter neighbor).
      let effective = min(selfClear, (selfClear * 0.65 + min(leftClear, rightClear) * 0.35))
      let centerBias = 1.0 - abs(sectorCenters[i]) / 180.0 * 0.18
      let score = effective * centerBias
      if score > bestScore {
        bestScore = score
        bestIndex = i
        bestEffectiveClearance = effective
      }
    }

    let forwardClearance = min(sectors[3].clearanceMeters, min(sectors[2].clearanceMeters, sectors[4].clearanceMeters) + 0.35)
    let centerBundleMax = max(sectors[1].clearanceMeters, max(sectors[2].clearanceMeters, max(sectors[3].clearanceMeters, max(sectors[4].clearanceMeters, sectors[5].clearanceMeters))))

    let corridorState: String
    if forwardClearance >= 2.2 {
      corridorState = "clear"
    } else if centerBundleMax < 1.2 || bestEffectiveClearance < 1.15 {
      corridorState = "blocked"
    } else {
      corridorState = "narrow"
    }

    let recommendedOffset = forwardClearance >= 2.4 ? 0.0 : sectorCenters[bestIndex]

    // Detect prioritized spatial hazards
    var hazards: [SpatialHazard] = []

    // 1. Head-height overhang check (must be meaningfully closer than torso/lower corridor)
    if headDistances.count >= 4 {
      let sortedHead = headDistances.sorted()
      let headNear = sortedHead[max(0, Int(Double(sortedHead.count - 1) * 0.15))]
      let lowerNear: Double
      if lowerCenterDistances.count >= 4 {
        let sortedLower = lowerCenterDistances.sorted()
        lowerNear = sortedLower[max(0, Int(Double(sortedLower.count - 1) * 0.15))]
      } else {
        lowerNear = maxRangeMeters
      }
      if headNear <= 2.0 && lowerNear >= headNear + 0.55 {
        let avgBearing = headBearings.reduce(0, +) / Double(headBearings.count)
        let severity = headNear <= 1.1 ? "urgent" : "caution"
        hazards.append(SpatialHazard(
          id: "lidar-head-height",
          kind: "head-height",
          severity: severity,
          direction: directionLabel(for: avgBearing),
          bearingDegrees: avgBearing,
          distanceMeters: headNear,
          confidence: 0.8,
          message: "Head-height obstacle \(directionLabel(for: avgBearing).replacingOccurrences(of: "-", with: " ")), \(formatMetres(headNear))."
        ))
      }
    }

    // 2. Floor drop-off / step-down / step-up check (requires steady near floor reference)
    var refinedFloorY: Float? = knownFloorY
    if floorNearY.count >= 6 {
      floorNearY.sort()
      let nearMedian = floorNearY[floorNearY.count / 2]
      refinedFloorY = knownFloorY ?? nearMedian
      if floorAheadY.count >= 6 {
        floorAheadY.sort()
        let aheadMedian = floorAheadY[floorAheadY.count / 2]
        let deltaY = Double(aheadMedian - nearMedian)
        let aheadDist = floorAheadDist.sorted()[max(0, floorAheadDist.count / 4)]
        if deltaY <= -0.14 {
          let isDropOff = deltaY <= -0.35
          let kind = isDropOff ? "drop-off" : "step-down"
          let severity = aheadDist <= 1.5 || isDropOff ? "urgent" : "caution"
          let label = isDropOff ? "Drop-off" : "Step down"
          hazards.append(SpatialHazard(
            id: "lidar-\(kind)",
            kind: kind,
            severity: severity,
            direction: "ahead",
            bearingDegrees: 0,
            distanceMeters: aheadDist,
            confidence: 0.78,
            message: "\(label) ahead, \(formatMetres(aheadDist))."
          ))
        } else if deltaY >= 0.12 && deltaY <= 0.35 && forwardClearance > aheadDist + 0.35 {
          let severity = aheadDist <= 1.3 ? "urgent" : "caution"
          hazards.append(SpatialHazard(
            id: "lidar-step-up",
            kind: "step-up",
            severity: severity,
            direction: "ahead",
            bearingDegrees: 0,
            distanceMeters: aheadDist,
            confidence: 0.75,
            message: "Step up ahead, \(formatMetres(aheadDist))."
          ))
        }
      }
    }

    // 3. Primary forward torso obstacle (if inside warningDistance)
    let centerSectors = [sectors[2], sectors[3], sectors[4]]
    if let nearestSector = centerSectors.min(by: { $0.clearanceMeters < $1.clearanceMeters }),
      nearestSector.sampleCount >= 3,
      nearestSector.clearanceMeters <= warningDistance {
      let dist = nearestSector.clearanceMeters
      let severity = dist <= criticalDistance ? "urgent" : "caution"
      let dir = directionLabel(for: nearestSector.centerDegrees)
      let steerHint: String
      if corridorState == "blocked" {
        steerHint = " Path blocked."
      } else if recommendedOffset <= -15 {
        steerHint = " Open space to your left."
      } else if recommendedOffset >= 15 {
        steerHint = " Open space to your right."
      } else {
        steerHint = ""
      }
      hazards.append(SpatialHazard(
        id: "lidar-corridor-obstacle",
        kind: "obstacle",
        severity: severity,
        direction: dir,
        bearingDegrees: nearestSector.centerDegrees,
        distanceMeters: dist,
        confidence: nearestSector.confidence,
        message: "Obstacle \(dir.replacingOccurrences(of: "-", with: " ")), \(formatMetres(dist)).\(steerHint)"
      ))
    }

    // 4. Nearby doorway or passage opening (informational spatial landmark)
    if let bestOpening = openings.min(by: { abs($0.bearingDegrees) < abs($1.bearingDegrees) }),
      bestOpening.distanceMeters <= 2.4 {
      let spokenDir = bestOpening.direction.replacingOccurrences(of: "-", with: " ")
      hazards.append(SpatialHazard(
        id: "lidar-doorway",
        kind: "doorway",
        severity: "info",
        direction: bestOpening.direction,
        bearingDegrees: bestOpening.bearingDegrees,
        distanceMeters: bestOpening.distanceMeters,
        confidence: 0.72,
        message: "Opening \(spokenDir), \(formatMetres(bestOpening.distanceMeters))."
      ))
    }

    return CorridorAnalysis(
      sectors: sectors,
      openings: openings,
      recommendedHeadingOffsetDeg: recommendedOffset,
      corridorState: corridorState,
      forwardClearanceMeters: forwardClearance,
      bestClearanceMeters: bestEffectiveClearance,
      aimState: aim,
      pitchDegrees: pitch,
      headingDegrees: heading,
      floorHeightMeters: refinedFloorY.map { Double($0) },
      maxClosingSpeedMps: 0,
      recedingObstacle: false,
      hazards: hazards,
      valid: true
    )
  }

  private static func emptySectors() -> [CorridorSector] {
    (0..<7).map { i in
      CorridorSector(index: i, centerDegrees: sectorCenters[i], label: sectorLabels[i], clearanceMeters: 0, sampleCount: 0, confidence: 0)
    }
  }

  private static func formatMetres(_ metres: Double) -> String {
    if metres < 1.0 { return "less than a metre" }
    return String(format: "%.1f metres", metres)
  }
}
