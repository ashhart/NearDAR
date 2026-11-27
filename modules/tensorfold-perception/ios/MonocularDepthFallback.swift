import CoreGraphics
import Foundation
import ImageIO
import simd

struct MonocularVisualDetection {
  let label: String
  let bearingDegrees: Double
  let verticalSpanFraction: Double
  let confidence: Double
}

/// Non-LiDAR iPhone fallback corridor estimator using ARKit sparse rawFeaturePoints
/// plus visual height-prior distance hints for people and animals.
enum MonocularDepthFallback {
  private static let defaultCameraHeightAboveFloor: Float = 1.15
  private static let maxRangeMeters: Double = CorridorAnalyzer.maxRangeMeters

  /// Physical height priors (metres) used for monocular pinhole distance hints when sceneDepth is unavailable.
  static func heightPriorMeters(for label: String) -> Double? {
    switch label.lowercased() {
    case "person": return 1.68
    case "dog": return 0.50
    case "cat": return 0.28
    case "animal": return 0.45
    default: return nil
    }
  }

  /// Computes upright normalized vertical focal length (f_vertical / uprightImageHeight).
  static func verticalFocalNormalized(
    intrinsics: simd_float3x3,
    imageSize: CGSize,
    orientation: CGImagePropertyOrientation
  ) -> Double {
    switch orientation {
    case .right, .left:
      guard imageSize.width > 0, intrinsics[0, 0] > 0 else { return 0.80 }
      return Double(intrinsics[0, 0]) / Double(imageSize.width)
    default:
      guard imageSize.height > 0, intrinsics[1, 1] > 0 else { return 0.80 }
      return Double(intrinsics[1, 1]) / Double(imageSize.height)
    }
  }

  /// Extracts upright vertical span fraction [0, 1] from sensor-space normalized bounds.
  static func verticalSpanFraction(
    sensorBounds: [String: Double],
    orientation: CGImagePropertyOrientation
  ) -> Double? {
    switch orientation {
    case .right, .left:
      return sensorBounds["width"]
    default:
      return sensorBounds["height"]
    }
  }

  /// Estimates conservative distance in metres using a pinhole height prior: d = (realHeight * fNorm) / hFraction.
  static func estimateDistanceMeters(
    label: String,
    verticalSpanFraction: Double,
    verticalFocalNormalized: Double = 0.80
  ) -> Double? {
    guard let realHeight = heightPriorMeters(for: label),
      verticalSpanFraction.isFinite, verticalSpanFraction >= 0.04, verticalSpanFraction <= 0.98,
      verticalFocalNormalized.isFinite, verticalFocalNormalized > 0.2 else {
      return nil
    }
    let raw = (realHeight * verticalFocalNormalized) / verticalSpanFraction
    guard raw.isFinite else { return nil }
    return max(0.45, min(6.0, raw))
  }

  /// Builds a conservative 7-sector CorridorAnalysis from ARKit 3D rawFeaturePoints and optional visual detections.
  static func analyze(
    featurePoints: [SIMD3<Float>],
    visualDetections: [MonocularVisualDetection] = [],
    cameraTransform: simd_float4x4,
    headingAligned: Bool,
    knownFloorY: Float? = nil,
    warningDistance: Double = 2.5,
    criticalDistance: Double = 0.9,
    mountMode: String = "handheld",
    verticalFocalNormalized: Double = 0.80
  ) -> CorridorAnalysis {
    let pitch = CorridorAnalyzer.cameraPitchDegrees(transform: cameraTransform)
    let aim = CorridorAnalyzer.aimState(pitchDegrees: pitch, mountMode: mountMode)
    let heading = headingAligned ? CorridorAnalyzer.cameraHeadingDegrees(transform: cameraTransform) : nil

    let camPos = SIMD3<Float>(cameraTransform.columns.3.x, cameraTransform.columns.3.y, cameraTransform.columns.3.z)
    let forwardWorld = -SIMD3<Float>(cameraTransform.columns.2.x, cameraTransform.columns.2.y, cameraTransform.columns.2.z)
    let horizLen = hypot(forwardWorld.x, forwardWorld.z)

    guard aim != "lowered", horizLen >= 0.20 else {
      return invalidAnalysis(aim: aim, pitch: pitch, heading: heading, knownFloorY: knownFloorY)
    }

    let horizFwd = SIMD2<Float>(forwardWorld.x / horizLen, forwardWorld.z / horizLen)
    let horizRight = SIMD2<Float>(-horizFwd.y, horizFwd.x)
    let estimatedFloorY = knownFloorY ?? (camPos.y - defaultCameraHeightAboveFloor)

    var sectorDistances = Array(repeating: [Double](), count: 7)
    var totalCorridorPoints = 0

    for point in featurePoints {
      guard point.x.isFinite, point.y.isFinite, point.z.isFinite else { continue }
      let dx = point.x - camPos.x
      let dz = point.z - camPos.z
      let fwdDist = Double(dx * horizFwd.x + dz * horizFwd.y)
      guard fwdDist >= 0.30, fwdDist <= 7.5 else { continue }
      let rightDist = Double(dx * horizRight.x + dz * horizRight.y)
      let bearingDeg = atan2(rightDist, fwdDist) * 180.0 / Double.pi
      let heightAboveFloor = point.y - estimatedFloorY

      if heightAboveFloor >= 0.25 && heightAboveFloor <= 1.85 && abs(bearingDeg) <= 52.5 {
        let rawIndex = Int(floor((bearingDeg + 52.5) / 15.0))
        let idx = max(0, min(6, rawIndex))
        sectorDistances[idx].append(min(maxRangeMeters, fwdDist))
        totalCorridorPoints += 1
      }
    }

    var visualSectorDistance = Array<Double?>(repeating: nil, count: 7)
    var visualSectorConfidence = Array(repeating: 0.0, count: 7)
    var visualHintsApplied = 0

    for detection in visualDetections {
      guard abs(detection.bearingDegrees) <= 52.5,
        let dist = estimateDistanceMeters(
          label: detection.label,
          verticalSpanFraction: detection.verticalSpanFraction,
          verticalFocalNormalized: verticalFocalNormalized
        ) else {
        continue
      }
      let rawIndex = Int(floor((detection.bearingDegrees + 52.5) / 15.0))
      let idx = max(0, min(6, rawIndex))
      let clampedDist = min(maxRangeMeters, dist)
      if let existing = visualSectorDistance[idx] {
        if clampedDist < existing {
          visualSectorDistance[idx] = clampedDist
          visualSectorConfidence[idx] = min(0.58, max(0.30, detection.confidence * 0.65))
        }
      } else {
        visualSectorDistance[idx] = clampedDist
        visualSectorConfidence[idx] = min(0.58, max(0.30, detection.confidence * 0.65))
      }
      visualHintsApplied += 1
    }

    guard totalCorridorPoints >= 6 || visualHintsApplied >= 1 else {
      return invalidAnalysis(aim: aim, pitch: pitch, heading: heading, knownFloorY: knownFloorY)
    }

    var sectors: [CorridorSector] = []
    sectors.reserveCapacity(7)
    for i in 0..<7 {
      var dists = sectorDistances[i]
      let visualDist = visualSectorDistance[i]

      if dists.count >= 2 {
        dists.sort()
        // Conservative 20th percentile for sparse feature points to reject single floating outliers.
        let p20 = dists[max(0, Int(Double(dists.count - 1) * 0.20))]
        let clearance = visualDist.map { min(p20, $0) } ?? p20
        let featureConf = min(0.62, 0.28 + Double(dists.count) * 0.04)
        let confidence = visualDist != nil ? max(featureConf, visualSectorConfidence[i]) : featureConf
        sectors.append(CorridorSector(
          index: i,
          centerDegrees: CorridorAnalyzer.sectorCenters[i],
          label: CorridorAnalyzer.sectorLabels[i],
          clearanceMeters: clearance,
          sampleCount: dists.count + (visualDist != nil ? 1 : 0),
          confidence: confidence
        ))
      } else if let visualDist {
        sectors.append(CorridorSector(
          index: i,
          centerDegrees: CorridorAnalyzer.sectorCenters[i],
          label: CorridorAnalyzer.sectorLabels[i],
          clearanceMeters: visualDist,
          sampleCount: max(3, dists.count + 2),
          confidence: visualSectorConfidence[i]
        ))
      } else {
        sectors.append(CorridorSector(
          index: i,
          centerDegrees: CorridorAnalyzer.sectorCenters[i],
          label: CorridorAnalyzer.sectorLabels[i],
          clearanceMeters: maxRangeMeters,
          sampleCount: dists.count,
          confidence: 0.25
        ))
      }
    }

    let openings = CorridorAnalyzer.detectOpenings(sectors: sectors)

    var bestIndex = 3
    var bestScore = -1.0
    var bestEffectiveClearance = 0.0
    for i in 0..<7 {
      let leftClear = i > 0 ? sectors[i - 1].clearanceMeters : sectors[i].clearanceMeters
      let rightClear = i < 6 ? sectors[i + 1].clearanceMeters : sectors[i].clearanceMeters
      let selfClear = sectors[i].clearanceMeters
      let effective = min(selfClear, (selfClear * 0.65 + min(leftClear, rightClear) * 0.35))
      let centerBias = 1.0 - abs(CorridorAnalyzer.sectorCenters[i]) / 180.0 * 0.18
      let score = effective * centerBias
      if score > bestScore {
        bestScore = score
        bestIndex = i
        bestEffectiveClearance = effective
      }
    }

    let forwardClearance = min(sectors[3].clearanceMeters, min(sectors[2].clearanceMeters, sectors[4].clearanceMeters) + 0.35)
    let centerBundleMax = max(
      sectors[1].clearanceMeters,
      max(sectors[2].clearanceMeters, max(sectors[3].clearanceMeters, max(sectors[4].clearanceMeters, sectors[5].clearanceMeters)))
    )

    let corridorState: String
    if forwardClearance >= 2.2 {
      corridorState = "clear"
    } else if centerBundleMax < 1.2 || bestEffectiveClearance < 1.15 {
      corridorState = "blocked"
    } else {
      corridorState = "narrow"
    }

    let recommendedOffset = forwardClearance >= 2.4 ? 0.0 : CorridorAnalyzer.sectorCenters[bestIndex]

    var hazards: [SpatialHazard] = []
    let centerSectors = [sectors[2], sectors[3], sectors[4]]
    if let nearestSector = centerSectors.min(by: { $0.clearanceMeters < $1.clearanceMeters }),
      nearestSector.sampleCount >= 2,
      nearestSector.clearanceMeters <= warningDistance {
      let dist = nearestSector.clearanceMeters
      let severity = dist <= criticalDistance ? "urgent" : "caution"
      let dir = CorridorAnalyzer.directionLabel(for: nearestSector.centerDegrees)
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
      let distText = dist < 1.0 ? "less than a metre" : String(format: "%.1f metres", dist)
      hazards.append(SpatialHazard(
        id: "monocular-corridor-obstacle",
        kind: "obstacle",
        severity: severity,
        direction: dir,
        bearingDegrees: nearestSector.centerDegrees,
        distanceMeters: dist,
        confidence: min(0.65, nearestSector.confidence),
        message: "Obstacle \(dir.replacingOccurrences(of: "-", with: " ")), about \(distText).\(steerHint)"
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
      floorHeightMeters: knownFloorY.map { Double($0) },
      maxClosingSpeedMps: 0,
      recedingObstacle: false,
      hazards: hazards,
      valid: true
    )
  }

  private static func invalidAnalysis(
    aim: String,
    pitch: Double,
    heading: Double?,
    knownFloorY: Float?
  ) -> CorridorAnalysis {
    let emptySectors = (0..<7).map { i in
      CorridorSector(
        index: i,
        centerDegrees: CorridorAnalyzer.sectorCenters[i],
        label: CorridorAnalyzer.sectorLabels[i],
        clearanceMeters: 0,
        sampleCount: 0,
        confidence: 0
      )
    }
    return CorridorAnalysis(
      sectors: emptySectors,
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
}
