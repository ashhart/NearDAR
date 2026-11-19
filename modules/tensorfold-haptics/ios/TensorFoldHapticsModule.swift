import CoreHaptics
import ExpoModulesCore
import UIKit

private struct HapticRequest: Record {
  @Field var direction: String = "unknown"
  @Field var severity: String = "info"
  @Field var distanceMeters: Double?
}

private struct HapticPulse {
  let duration: TimeInterval
  var gapAfter: TimeInterval
  let continuous: Bool

  init(duration: TimeInterval, gapAfter: TimeInterval = 0, continuous: Bool = false) {
    self.duration = duration
    self.gapAfter = gapAfter
    self.continuous = continuous
  }
}

private enum HapticDirection: String {
  case ahead
  case aheadLeft = "ahead-left"
  case aheadRight = "ahead-right"
  case left
  case right
  case behind
  case unknown

  var pulses: [HapticPulse] {
    switch self {
    case .ahead:
      return [HapticPulse(duration: 0.09)]
    case .aheadLeft:
      return [
        HapticPulse(duration: 0.08, gapAfter: 0.11),
        HapticPulse(duration: 0.08)
      ]
    case .aheadRight:
      return [
        HapticPulse(duration: 0.08, gapAfter: 0.11),
        HapticPulse(duration: 0.08, gapAfter: 0.11),
        HapticPulse(duration: 0.08)
      ]
    case .left:
      return [
        HapticPulse(duration: 0.12, gapAfter: 0.33),
        HapticPulse(duration: 0.12)
      ]
    case .right:
      return [
        HapticPulse(duration: 0.12, gapAfter: 0.33),
        HapticPulse(duration: 0.12, gapAfter: 0.33),
        HapticPulse(duration: 0.12)
      ]
    case .behind:
      return [
        HapticPulse(duration: 0.38, gapAfter: 0.20, continuous: true),
        HapticPulse(duration: 0.38, continuous: true)
      ]
    case .unknown:
      return [
        HapticPulse(duration: 0.065, gapAfter: 0.10),
        HapticPulse(duration: 0.065, gapAfter: 0.33),
        HapticPulse(duration: 0.065, gapAfter: 0.10),
        HapticPulse(duration: 0.065)
      ]
    }
  }
}

private enum HapticSeverity: String {
  case info
  case caution
  case urgent

  var baseIntensity: Float {
    switch self {
    case .info: return 0.45
    case .caution: return 0.72
    case .urgent: return 0.95
    }
  }

  var sharpness: Float {
    switch self {
    case .info: return 0.30
    case .caution: return 0.55
    case .urgent: return 0.80
    }
  }
}

private enum HapticInputError: LocalizedError {
  case invalidDirection(String)
  case invalidSeverity(String)

  var errorDescription: String? {
    switch self {
    case .invalidDirection(let value):
      return "Unsupported haptic direction '\(value)'."
    case .invalidSeverity(let value):
      return "Unsupported haptic severity '\(value)'."
    }
  }
}

public final class TensorFoldHapticsModule: Module {
  private var engine: CHHapticEngine?
  private var player: CHHapticPatternPlayer?
  private var lifecycleObservers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("TensorFoldHaptics")

    OnCreate {
      self.observeApplicationLifecycle()
    }
    OnDestroy {
      self.stopPlayback()
      self.removeApplicationLifecycleObservers()
    }

    AsyncFunction("getCapabilities") { () -> [String: Any] in
      let supported = CHHapticEngine.capabilitiesForHardware().supportsHaptics
      var capabilities: [String: Any] = [
        "platform": "ios",
        "available": supported,
        "customPatterns": supported,
        "amplitudeControl": supported
      ]
      capabilities["reason"] = supported ? NSNull() : "This device does not support Core Haptics."
      return capabilities
    }.runOnQueue(.main)

    AsyncFunction("play") { (request: HapticRequest) -> [String: Any] in
      try self.play(request)
    }.runOnQueue(.main)

    AsyncFunction("stop") {
      self.stopPlayback()
    }.runOnQueue(.main)
  }

  private func play(_ request: HapticRequest) throws -> [String: Any] {
    guard let direction = HapticDirection(rawValue: request.direction) else {
      throw HapticInputError.invalidDirection(request.direction)
    }
    guard let severity = HapticSeverity(rawValue: request.severity) else {
      throw HapticInputError.invalidSeverity(request.severity)
    }
    guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else {
      return unavailable("This device does not support Core Haptics.")
    }

    do {
      if engine == nil {
        engine = try CHHapticEngine()
      }
      guard let engine else {
        return unavailable("Core Haptics could not create an engine.")
      }

      // Replace rather than overlap cues. Each request creates one finite pattern.
      try? player?.stop(atTime: CHHapticTimeImmediate)
      player = nil
      try engine.start()

      let close = request.distanceMeters.map { $0.isFinite && $0 >= 0 && $0 <= 1.5 } ?? false
      let intensity = min(severity.baseIntensity + (close ? 0.08 : 0), 1.0)
      let pattern = try CHHapticPattern(
        events: hapticEvents(direction: direction, severity: severity, intensity: intensity),
        parameterCurves: []
      )
      let nextPlayer = try engine.makePlayer(with: pattern)
      player = nextPlayer
      try nextPlayer.start(atTime: CHHapticTimeImmediate)
      return ["status": "played", "amplitudeControl": true]
    } catch {
      player = nil
      return unavailable("Core Haptics could not play the pattern: \(error.localizedDescription)")
    }
  }

  private func hapticEvents(
    direction: HapticDirection,
    severity: HapticSeverity,
    intensity: Float
  ) -> [CHHapticEvent] {
    var pulses = direction.pulses
    switch severity {
    case .info:
      break
    case .caution:
      let last = pulses.count - 1
      pulses[last].gapAfter = 0.24
      pulses.append(HapticPulse(duration: 0.09))
    case .urgent:
      let last = pulses.count - 1
      pulses[last].gapAfter = 0.24
      pulses.append(HapticPulse(duration: 0.07, gapAfter: 0.11))
      pulses.append(HapticPulse(duration: 0.07))
    }

    var time: TimeInterval = 0
    return pulses.map { pulse in
      let event = CHHapticEvent(
        eventType: pulse.continuous ? .hapticContinuous : .hapticTransient,
        parameters: [
          CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
          CHHapticEventParameter(
            parameterID: .hapticSharpness,
            value: pulse.continuous ? 0.25 : severity.sharpness
          )
        ],
        relativeTime: time,
        duration: pulse.continuous ? pulse.duration : 0
      )
      time += pulse.duration + pulse.gapAfter
      return event
    }
  }

  private func unavailable(_ reason: String) -> [String: Any] {
    return ["status": "unavailable", "reason": reason]
  }

  private func observeApplicationLifecycle() {
    let notifications = [
      UIApplication.willResignActiveNotification,
      UIApplication.didEnterBackgroundNotification
    ]
    for notification in notifications {
      let observer = NotificationCenter.default.addObserver(
        forName: notification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.stopPlayback()
      }
      lifecycleObservers.append(observer)
    }
  }

  private func removeApplicationLifecycleObservers() {
    for observer in lifecycleObservers {
      NotificationCenter.default.removeObserver(observer)
    }
    lifecycleObservers.removeAll()
  }

  private func stopPlayback() {
    try? player?.stop(atTime: CHHapticTimeImmediate)
    player = nil
    engine?.stop(completionHandler: nil)
  }
}
