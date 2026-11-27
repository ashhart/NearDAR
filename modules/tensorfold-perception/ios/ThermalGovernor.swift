import Foundation
import simd

enum ThermalLevel: String, Equatable {
  case nominal = "nominal"
  case fair = "fair"
  case serious = "serious"
  case critical = "critical"

  init(processThermalState: ProcessInfo.ThermalState) {
    switch processThermalState {
    case .nominal: self = .nominal
    case .fair: self = .fair
    case .serious: self = .serious
    case .critical: self = .critical
    @unknown default: self = .fair
    }
  }

  init(label: String) {
    switch label.lowercased() {
    case "fair": self = .fair
    case "serious": self = .serious
    case "critical": self = .critical
    default: self = .nominal
    }
  }
}

struct ThermalPolicy: Equatable {
  let thermalState: String
  let isStationary: Bool
  let proximityIntervalMs: Double
  let visionIntervalSec: Double
  let proactiveVlmAllowed: Bool
}

/// Pure-Swift thermal & battery governor.
/// Protects device thermals and battery while keeping P0 LiDAR proximity + CoreHaptics live.
enum ThermalGovernor {
  static func policy(
    thermalLevel: ThermalLevel,
    isStationary: Bool,
    baseProximityIntervalMs: Double = 120.0
  ) -> ThermalPolicy {
    let governedProximityMs: Double
    let visionSec: Double
    let proactiveVlmAllowed: Bool

    switch thermalLevel {
    case .nominal:
      governedProximityMs = isStationary ? 220.0 : 120.0
      visionSec = isStationary ? 1.2 : 0.55
      proactiveVlmAllowed = true
    case .fair:
      governedProximityMs = isStationary ? 300.0 : 180.0
      visionSec = 0.95
      proactiveVlmAllowed = true
    case .serious:
      governedProximityMs = 280.0
      visionSec = 1.6
      proactiveVlmAllowed = false
    case .critical:
      governedProximityMs = 380.0
      visionSec = 2.5
      proactiveVlmAllowed = false
    }

    return ThermalPolicy(
      thermalState: thermalLevel.rawValue,
      isStationary: isStationary,
      proximityIntervalMs: max(baseProximityIntervalMs, governedProximityMs),
      visionIntervalSec: visionSec,
      proactiveVlmAllowed: proactiveVlmAllowed
    )
  }

  static func policy(
    thermalState: String,
    isStationary: Bool,
    baseProximityIntervalMs: Double = 120.0
  ) -> ThermalPolicy {
    policy(
      thermalLevel: ThermalLevel(label: thermalState),
      isStationary: isStationary,
      baseProximityIntervalMs: baseProximityIntervalMs
    )
  }

  static func policy(
    processThermalState: ProcessInfo.ThermalState,
    isStationary: Bool,
    baseProximityIntervalMs: Double = 120.0
  ) -> ThermalPolicy {
    policy(
      thermalLevel: ThermalLevel(processThermalState: processThermalState),
      isStationary: isStationary,
      baseProximityIntervalMs: baseProximityIntervalMs
    )
  }
}

/// Tracks camera translation over a sliding window (default 3.0s) to detect when the user is stationary.
final class StationaryTracker {
  private struct Sample {
    let timestamp: Double
    let position: SIMD3<Float>
  }

  private let windowSeconds: Double
  private let movementThresholdMeters: Float
  private var samples: [Sample] = []

  init(windowSeconds: Double = 3.0, movementThresholdMeters: Float = 0.25) {
    self.windowSeconds = max(0.5, windowSeconds)
    self.movementThresholdMeters = max(0.05, movementThresholdMeters)
  }

  func reset() {
    samples.removeAll(keepingCapacity: true)
  }

  @discardableResult
  func observe(timestamp: Double, position: SIMD3<Float>) -> Bool {
    guard timestamp.isFinite, position.x.isFinite, position.y.isFinite, position.z.isFinite else {
      reset()
      return false
    }
    if let last = samples.last {
      if timestamp < last.timestamp || timestamp - last.timestamp > 10.0 {
        reset()
      } else if abs(timestamp - last.timestamp) < 0.001 {
        return evaluate(currentPosition: position, currentTimestamp: timestamp)
      }
    }

    samples.append(Sample(timestamp: timestamp, position: position))

    // Drop samples older than the sliding window while preserving full window coverage.
    while samples.count >= 2 && (timestamp - samples[1].timestamp) >= windowSeconds {
      samples.removeFirst()
    }
    if samples.count > 120 {
      samples.removeFirst(samples.count - 120)
    }

    return evaluate(currentPosition: position, currentTimestamp: timestamp)
  }

  private func evaluate(currentPosition: SIMD3<Float>, currentTimestamp: Double) -> Bool {
    guard let oldest = samples.first, currentTimestamp - oldest.timestamp >= windowSeconds - 0.001 else {
      return false
    }
    var maxDisplacement: Float = 0
    for sample in samples {
      let dist = simd_distance(sample.position, currentPosition)
      if dist > maxDisplacement {
        maxDisplacement = dist
      }
    }
    return maxDisplacement < movementThresholdMeters
  }
}
