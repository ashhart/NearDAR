import AVFAudio
import Foundation

enum VoiceAudio {
  static var remoteControlsActive = false

  static var supportsBackgroundAudio: Bool {
    guard let modes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] else {
      return false
    }
    return modes.contains("audio")
  }

  static func activate(operation: String, recognition: Bool, preferBluetoothMicrophone: Bool, speakerFallback: Bool = true) throws {
    let session = AVAudioSession.sharedInstance()
    var step = "configuring audio"
    do {
      if recognition {
        let options: AVAudioSession.CategoryOptions = remoteControlsActive
          ? [.allowBluetoothHFP, .defaultToSpeaker]
          : [.allowBluetoothHFP, .defaultToSpeaker, .duckOthers]
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
      } else {
        let options: AVAudioSession.CategoryOptions = remoteControlsActive ? [] : [.duckOthers]
        try session.setCategory(.playback, mode: .spokenAudio, options: options)
      }
      step = "activating audio"
      try session.setActive(true)
      if recognition {
        step = "selecting a microphone"
        let input = preferBluetoothMicrophone ? bluetoothInput(in: session.availableInputs) : nil
        if input?.uid != session.preferredInput?.uid { try session.setPreferredInput(input) }
      }
    } catch {
      if !remoteControlsActive {
        deactivate()
      }
      let systemError = error as NSError
      throw VoiceFailure(operation: operation, code: "E_AUDIO_SESSION",
        message: "Error while \(step) (\(systemError.domain), \(systemError.code)).")
    }
    if !recognition && !speakerFallback && currentRouteKind() == "speaker" {
      if !remoteControlsActive {
        deactivate()
      }
      throw VoiceFailure(operation: operation, code: "E_AUDIO_ROUTE",
        message: "Connect headphones to hear NearDar, or enable the phone speaker in Settings.")
    }
  }

  static func ensurePlaybackSessionForRemoteControls() {
    let session = AVAudioSession.sharedInstance()
    do {
      if session.category != .playback || session.mode != .spokenAudio || !session.categoryOptions.isEmpty {
        try session.setCategory(.playback, mode: .spokenAudio, options: [])
      }
      try session.setActive(true)
    } catch {
      // Best-effort keep-alive for Lock Screen and earbud media-button triggers.
    }
  }

  static func deactivate() {
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  static func currentRouteKind() -> String {
    routeKind(AVAudioSession.sharedInstance().currentRoute)
  }

  static func routeKind(_ route: AVAudioSessionRouteDescription) -> String {
    let outputs = route.outputs
    if outputs.contains(where: { [.headphones, .bluetoothHFP, .bluetoothLE, .bluetoothA2DP].contains($0.portType) }) {
      return "headphones"
    }
    if outputs.contains(where: { $0.portType == .builtInSpeaker || $0.portType == .builtInReceiver }) {
      return "speaker"
    }
    return "unknown"
  }

  static func bluetoothInput(in inputs: [AVAudioSessionPortDescription]?) -> AVAudioSessionPortDescription? {
    inputs?.first { $0.portType == .bluetoothHFP || $0.portType == .bluetoothLE }
  }

  static func routePayload(reason: String) -> [String: Any] {
    let session = AVAudioSession.sharedInstance()
    let currentInput = bluetoothInput(in: session.currentRoute.inputs)
    return [
      "reason": reason,
      "inputs": session.currentRoute.inputs.map(portPayload),
      "outputs": session.currentRoute.outputs.map(portPayload),
      "bluetoothMicrophoneAvailable": bluetoothInput(in: session.availableInputs) != nil,
      "communicationDevice": voiceNull(currentInput?.portName),
      "timestamp": voiceTimestamp()
    ]
  }

  static func routeReason(_ reason: AVAudioSession.RouteChangeReason) -> String {
    switch reason {
    case .unknown: return "unknown"
    case .newDeviceAvailable: return "newDeviceAvailable"
    case .oldDeviceUnavailable: return "oldDeviceUnavailable"
    case .categoryChange: return "categoryChange"
    case .override: return "override"
    case .wakeFromSleep: return "wakeFromSleep"
    case .noSuitableRouteForCategory: return "noSuitableRouteForCategory"
    case .routeConfigurationChange: return "routeConfigurationChange"
    @unknown default: return "unknown"
    }
  }

  private static func portPayload(_ port: AVAudioSessionPortDescription) -> [String: Any] {
    [
      "id": port.uid,
      "name": port.portName,
      "type": port.portType.rawValue,
      "kind": portKind(port.portType)
    ]
  }

  private static func portKind(_ type: AVAudioSession.Port) -> String {
    switch type {
    case .builtInMic, .headsetMic: return "microphone"
    case .builtInSpeaker, .builtInReceiver: return "speaker"
    case .headphones: return "headphones"
    case .bluetoothHFP, .bluetoothLE: return "bluetoothHFP"
    case .bluetoothA2DP: return "bluetoothA2DP"
    case .usbAudio: return "usb"
    default: return "other"
    }
  }
}
