import ExpoModulesCore

public final class TensorFoldVoiceModule: Module {
  private lazy var controller = VoiceController { [weak self] name, payload in
    self?.sendEvent(name, payload)
  }

  public func definition() -> ModuleDefinition {
    Name("TensorFoldVoice")
    Events(VoiceEvent.voiceEvent)

    OnCreate {
      controller.startObservers()
    }
    OnDestroy {
      controller.shutdown()
    }
    OnStartObserving {
      controller.emitCurrentRoute()
    }

    AsyncFunction("getCapabilities") { () -> [String: Any] in
      controller.capabilities()
    }.runOnQueue(.main)

    AsyncFunction("startListening") { (options: ListenOptions, promise: Promise) in
      controller.startListening(options: options, promise: promise)
    }.runOnQueue(.main)

    AsyncFunction("stopListening") {
      controller.stopListening(reason: "user")
    }.runOnQueue(.main)

    AsyncFunction("speak") { (text: String, options: SpeakOptions, promise: Promise) in
      controller.speak(text: text, options: options, promise: promise)
    }.runOnQueue(.main)

    AsyncFunction("stopSpeaking") {
      controller.stopSpeaking(reason: "user")
    }.runOnQueue(.main)

    AsyncFunction("updateSpatialBeacon") { (options: SpatialBeaconOptions) in
      self.controller.spatialAudio.updateBeacon(
        active: options.active,
        azimuthDeg: options.azimuthDeg,
        distanceMeters: options.distanceMeters,
        headphonesOnly: options.headphonesOnly
      )
      if !options.active {
        self.controller.deactivateAudioIfIdle()
      }
    }.runOnQueue(.main)

    AsyncFunction("playSpatialCue") { (options: SpatialCueOptions) in
      self.controller.spatialAudio.playCue(
        kind: options.kind,
        azimuthDeg: options.azimuthDeg,
        distanceMeters: options.distanceMeters,
        elevationMeters: options.elevationMeters
      )
    }.runOnQueue(.main)

    AsyncFunction("stopSpatialAudio") {
      self.controller.spatialAudio.stopAll()
      self.controller.deactivateAudioIfIdle()
    }.runOnQueue(.main)
  }
}
