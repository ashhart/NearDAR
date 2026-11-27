import CoreHaptics
import ExpoModulesCore
import UIKit

private struct HapticRequest: Record {
  @Field var direction: String = "unknown"
  @Field var severity: String = "info"
  @Field var distanceMeters: Double?
}

private struct GuidanceHapticState: Record {
  @Field var active: Bool = false
  @Field var steeringEnabled: Bool = true
  @Field var proximityEnabled: Bool = true
  @Field var headingOffsetDeg: Double?
  @Field var forwardClearanceMeters: Double?
  @Field var muted: Bool = false
}

private struct HapticPulse {
  let duration: TimeInterval
  var gapAfter: TimeInterval
  let continuous: Bool
  let intensity: Float?
  let sharpness: Float?

  init(
    duration: TimeInterval,
    gapAfter: TimeInterval = 0,
    continuous: Bool = false,
    intensity: Float? = nil,
    sharpness: Float? = nil
  ) {
    self.duration = duration
    self.gapAfter = gapAfter
    self.continuous = continuous
    self.intensity = intensity
    self.sharpness = sharpness
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

private enum HapticCue: String {
  case micOpen = "mic-open"
  case micClose = "mic-close"
  case thinkingTick = "thinking-tick"
  case turnApproaching = "turn-approaching"
  case turnLeft = "turn-left"
  case turnRight = "turn-right"
  case offRoute = "off-route"
  case headHazard = "head-hazard"
  case dropOff = "drop-off"
  case fastMover = "fast-mover"
  case animal
  case opening
  case standby
  case arrived
  case paused
  case resumed

  var pulses: [HapticPulse] {
    switch self {
    case .micOpen:
      return [
        HapticPulse(duration: 0.025, gapAfter: 0.04, intensity: 0.55, sharpness: 0.55),
        HapticPulse(duration: 0.03, intensity: 0.80, sharpness: 0.85)
      ]
    case .micClose:
      return [
        HapticPulse(duration: 0.025, intensity: 0.45, sharpness: 0.30)
      ]
    case .thinkingTick:
      return [
        HapticPulse(duration: 0.02, intensity: 0.24, sharpness: 0.20)
      ]
    case .turnApproaching:
      return [
        HapticPulse(duration: 0.05, gapAfter: 0.09, intensity: 0.48, sharpness: 0.45),
        HapticPulse(duration: 0.06, intensity: 0.74, sharpness: 0.65)
      ]
    case .turnLeft:
      return [
        HapticPulse(duration: 0.08, gapAfter: 0.09, continuous: true, intensity: 0.78, sharpness: 0.28),
        HapticPulse(duration: 0.08, continuous: true, intensity: 0.78, sharpness: 0.28)
      ]
    case .turnRight:
      return [
        HapticPulse(duration: 0.045, gapAfter: 0.065, intensity: 0.78, sharpness: 0.85),
        HapticPulse(duration: 0.045, gapAfter: 0.065, intensity: 0.78, sharpness: 0.85),
        HapticPulse(duration: 0.045, intensity: 0.82, sharpness: 0.90)
      ]
    case .offRoute:
      return [
        HapticPulse(duration: 0.22, continuous: true, intensity: 0.62, sharpness: 0.18)
      ]
    case .headHazard:
      return [
        HapticPulse(duration: 0.04, gapAfter: 0.055, intensity: 0.95, sharpness: 0.95),
        HapticPulse(duration: 0.04, gapAfter: 0.055, intensity: 0.95, sharpness: 0.95),
        HapticPulse(duration: 0.04, intensity: 1.0, sharpness: 1.0)
      ]
    case .dropOff:
      return [
        HapticPulse(duration: 0.14, gapAfter: 0.09, continuous: true, intensity: 1.0, sharpness: 0.16),
        HapticPulse(duration: 0.14, continuous: true, intensity: 0.92, sharpness: 0.12)
      ]
    case .fastMover:
      return [
        HapticPulse(duration: 0.03, gapAfter: 0.035, intensity: 1.0, sharpness: 0.95),
        HapticPulse(duration: 0.03, gapAfter: 0.035, intensity: 1.0, sharpness: 0.98),
        HapticPulse(duration: 0.03, gapAfter: 0.035, intensity: 1.0, sharpness: 1.0),
        HapticPulse(duration: 0.045, intensity: 1.0, sharpness: 1.0)
      ]
    case .animal:
      return [
        HapticPulse(duration: 0.035, gapAfter: 0.09, intensity: 0.48, sharpness: 0.28),
        HapticPulse(duration: 0.035, intensity: 0.56, sharpness: 0.34)
      ]
    case .opening:
      return [
        HapticPulse(duration: 0.025, gapAfter: 0.06, intensity: 0.36, sharpness: 0.45),
        HapticPulse(duration: 0.035, intensity: 0.52, sharpness: 0.78)
      ]
    case .standby:
      return [
        HapticPulse(duration: 0.06, continuous: true, intensity: 0.30, sharpness: 0.16)
      ]
    case .arrived:
      return [
        HapticPulse(duration: 0.05, gapAfter: 0.08, intensity: 0.48, sharpness: 0.35),
        HapticPulse(duration: 0.06, gapAfter: 0.08, intensity: 0.68, sharpness: 0.55),
        HapticPulse(duration: 0.10, continuous: true, intensity: 0.86, sharpness: 0.72)
      ]
    case .paused:
      return [
        HapticPulse(duration: 0.05, gapAfter: 0.07, intensity: 0.60, sharpness: 0.35),
        HapticPulse(duration: 0.04, intensity: 0.35, sharpness: 0.20)
      ]
    case .resumed:
      return [
        HapticPulse(duration: 0.04, gapAfter: 0.07, intensity: 0.42, sharpness: 0.40),
        HapticPulse(duration: 0.06, intensity: 0.72, sharpness: 0.70)
      ]
    }
  }
}

private enum HapticInputError: LocalizedError {
  case invalidDirection(String)
  case invalidSeverity(String)
  case invalidCue(String)

  var errorDescription: String? {
    switch self {
    case .invalidDirection(let value):
      return "Unsupported haptic direction '\(value)'."
    case .invalidSeverity(let value):
      return "Unsupported haptic severity '\(value)'."
    case .invalidCue(let value):
      return "Unsupported haptic cue '\(value)'."
    }
  }
}

public final class TensorFoldHapticsModule: Module {
  private var engine: CHHapticEngine?
  private var player: CHHapticPatternPlayer?
  private var lifecycleObservers: [NSObjectProtocol] = []
  private var guidanceTimer: Timer?
  private var guidanceState = GuidanceHapticState()
  private var lastGuidancePulseAt: TimeInterval = 0
  private var cueHoldUntil: TimeInterval = 0

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
        "amplitudeControl": supported,
        "continuousGuidance": supported
      ]
      capabilities["reason"] = supported ? NSNull() : "This device does not support Core Haptics."
      return capabilities
    }.runOnQueue(.main)

    AsyncFunction("play") { (request: HapticRequest) -> [String: Any] in
      try self.play(request)
    }.runOnQueue(.main)

    AsyncFunction("playCue") { (cueName: String) -> [String: Any] in
      try self.playCue(cueName)
    }.runOnQueue(.main)

    AsyncFunction("updateGuidance") { (state: GuidanceHapticState) -> [String: Any] in
      self.updateGuidance(state)
    }.runOnQueue(.main)

    AsyncFunction("stopGuidance") {
      self.stopGuidanceLoop()
    }.runOnQueue(.main)

    AsyncFunction("stop") {
      self.stopPlayback()
    }.runOnQueue(.main)
  }

  private func ensureEngine() throws -> CHHapticEngine? {
    guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return nil }
    if engine == nil {
      let created = try CHHapticEngine()
      created.resetHandler = { [weak self] in
        try? self?.engine?.start()
      }
      created.stoppedHandler = { [weak self] _ in
        self?.player = nil
      }
      engine = created
    }
    try engine?.start()
    return engine
  }

  private func playPulses(_ pulses: [HapticPulse], defaultIntensity: Float = 0.7, defaultSharpness: Float = 0.5) throws -> [String: Any] {
    guard let engine = try ensureEngine() else {
      return unavailable("This device does not support Core Haptics.")
    }
    var time: TimeInterval = 0
    let events: [CHHapticEvent] = pulses.map { pulse in
      let intensity = max(0.05, min(1.0, pulse.intensity ?? defaultIntensity))
      let sharpness = max(0.05, min(1.0, pulse.sharpness ?? (pulse.continuous ? 0.25 : defaultSharpness)))
      let event = CHHapticEvent(
        eventType: pulse.continuous ? .hapticContinuous : .hapticTransient,
        parameters: [
          CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
          CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness)
        ],
        relativeTime: time,
        duration: pulse.continuous ? pulse.duration : 0
      )
      time += pulse.duration + pulse.gapAfter
      return event
    }
    try? player?.stop(atTime: CHHapticTimeImmediate)
    player = nil
    let pattern = try CHHapticPattern(events: events, parameterCurves: [])
    let nextPlayer = try engine.makePlayer(with: pattern)
    player = nextPlayer
    try nextPlayer.start(atTime: CHHapticTimeImmediate)
    return ["status": "played", "amplitudeControl": true]
  }

  private func playCue(_ cueName: String) throws -> [String: Any] {
    guard let cue = HapticCue(rawValue: cueName) else {
      throw HapticInputError.invalidCue(cueName)
    }
    do {
      cueHoldUntil = ProcessInfo.processInfo.systemUptime + 0.45
      return try playPulses(cue.pulses)
    } catch {
      player = nil
      return unavailable("Core Haptics could not play cue '\(cueName)': \(error.localizedDescription)")
    }
  }

  private func updateGuidance(_ state: GuidanceHapticState) -> [String: Any] {
    guidanceState = state
    guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else {
      stopGuidanceLoop()
      return unavailable("This device does not support Core Haptics.")
    }
    if !state.active {
      stopGuidanceLoop()
      return ["status": "stopped"]
    }
    if guidanceTimer == nil {
      let timer = Timer.scheduledTimer(withTimeInterval: 0.10, repeats: true) { [weak self] _ in
        self?.tickGuidance()
      }
      RunLoop.main.add(timer, forMode: .common)
      guidanceTimer = timer
    }
    return ["status": "active"]
  }

  private func tickGuidance() {
    guard guidanceState.active, !guidanceState.muted else { return }
    let now = ProcessInfo.processInfo.systemUptime
    guard now >= cueHoldUntil else { return }

    // Priority 1: Proximity radar (parking-sensor cadence below 2.2m)
    if guidanceState.proximityEnabled,
      let clearance = guidanceState.forwardClearanceMeters,
      clearance.isFinite, clearance > 0, clearance < 2.2 {
      let interval: TimeInterval
      let pulses: [HapticPulse]
      if clearance < 0.70 {
        interval = 0.34
        pulses = [
          HapticPulse(duration: 0.04, gapAfter: 0.06, intensity: 0.95, sharpness: 0.85),
          HapticPulse(duration: 0.04, intensity: 0.95, sharpness: 0.85)
        ]
      } else if clearance < 1.35 {
        let ratio = Float((1.35 - clearance) / 0.65)
        interval = 0.62 - Double(ratio) * 0.24
        pulses = [HapticPulse(duration: 0.04, intensity: 0.68 + ratio * 0.20, sharpness: 0.55 + ratio * 0.22)]
      } else {
        let ratio = Float((2.20 - clearance) / 0.85)
        interval = 1.05 - Double(ratio) * 0.38
        pulses = [HapticPulse(duration: 0.035, intensity: 0.38 + ratio * 0.22, sharpness: 0.32 + ratio * 0.18)]
      }
      if now - lastGuidancePulseAt >= interval {
        lastGuidancePulseAt = now
        _ = try? playPulses(pulses)
      }
      return
    }

    // Priority 2: Compass / open-corridor lock pulse ("Follow the Beat")
    if guidanceState.steeringEnabled,
      let offset = guidanceState.headingOffsetDeg,
      offset.isFinite {
      let absOffset = abs(offset)
      if absOffset <= 15.0 {
        if now - lastGuidancePulseAt >= 1.15 {
          lastGuidancePulseAt = now
          _ = try? playPulses([HapticPulse(duration: 0.03, intensity: 0.42, sharpness: 0.22)])
        }
      } else if absOffset <= 32.0 {
        if now - lastGuidancePulseAt >= 1.65 {
          lastGuidancePulseAt = now
          _ = try? playPulses([HapticPulse(duration: 0.025, intensity: 0.22, sharpness: 0.14)])
        }
      }
    }
  }

  private func stopGuidanceLoop() {
    guidanceTimer?.invalidate()
    guidanceTimer = nil
    guidanceState.active = false
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
      cueHoldUntil = ProcessInfo.processInfo.systemUptime + 0.55
      let close = request.distanceMeters.map { $0.isFinite && $0 >= 0 && $0 <= 1.5 } ?? false
      let intensity = min(severity.baseIntensity + (close ? 0.08 : 0), 1.0)
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
      return try playPulses(pulses, defaultIntensity: intensity, defaultSharpness: severity.sharpness)
    } catch {
      player = nil
      return unavailable("Core Haptics could not play the pattern: \(error.localizedDescription)")
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
    stopGuidanceLoop()
    try? player?.stop(atTime: CHHapticTimeImmediate)
    player = nil
    engine?.stop(completionHandler: nil)
  }
}
