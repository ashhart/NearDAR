import AVFAudio
import ExpoModulesCore
import Foundation
import Speech
import UIKit

final class VoiceController: NSObject, AVSpeechSynthesizerDelegate, SFSpeechRecognizerDelegate {
  let emit: (String, [String: Any]) -> Void
  var observers: [NSObjectProtocol] = []
  var recognitionGeneration = 0
  var activeSessionId: String?
  var activeLocale: String?
  var recognizer: SFSpeechRecognizer?
  var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  var recognitionTask: SFSpeechRecognitionTask?
  var audioEngine: AVAudioEngine?
  var silenceTimer: Timer?
  var silenceTimeoutMs: Double?
  var hasEmittedSpeechStarted = false
  var pendingStart: (generation: Int, promise: Promise)?
  var utterances: [ObjectIdentifier: TrackedUtterance] = [:]
  let spatialAudio = SpatialAudioEngine()

  lazy var synthesizer: AVSpeechSynthesizer = {
    let value = AVSpeechSynthesizer()
    value.delegate = self
    value.usesApplicationAudioSession = true
    return value
  }()

  init(emit: @escaping (String, [String: Any]) -> Void) {
    self.emit = emit
    super.init()
  }

  func emitListening(_ state: String, reason: String? = nil, sessionId: String? = nil) {
    let id = sessionId ?? activeSessionId
    guard state != "stopped" && state != "interrupted" || id != nil else { return }
    emit(VoiceEvent.voiceEvent, [
      "type": state == "stopped" || state == "interrupted" ? "listeningStopped" : "listeningStarted",
      "state": state,
      "sessionId": voiceNull(id),
      "message": voiceNull(reason),
      "timestamp": voiceTimestamp()
    ])
  }

  func emitUtterance(_ tracked: TrackedUtterance, state: String, reason: String? = nil) {
    guard state != "queued" else { return }
    let type = state == "finished" ? "speechFinished" : state == "started" ? "speechStarted" : "speechStopped"
    emit(VoiceEvent.voiceEvent, [
      "type": type,
      "state": state,
      "utteranceId": tracked.id,
      "priority": tracked.priority,
      "message": voiceNull(reason),
      "timestamp": voiceTimestamp()
    ])
  }

  func reportError(_ failure: VoiceFailure, sessionId: String? = nil, utteranceId: String? = nil) {
    emit(VoiceEvent.voiceEvent, [
      "type": "error",
      "operation": failure.operation,
      "code": failure.code,
      "message": failure.message,
      "sessionId": voiceNull(sessionId ?? activeSessionId),
      "utteranceId": voiceNull(utteranceId),
      "timestamp": voiceTimestamp()
    ])
  }

  func reject(_ promise: Promise, failure: VoiceFailure) {
    reportError(failure)
    promise.reject(failure.code, failure.message)
  }

  func emitCurrentRoute() {
    emit(VoiceEvent.voiceEvent, [
      "type": "routeChanged",
      "route": VoiceAudio.currentRouteKind(),
      "audioRoute": VoiceAudio.routePayload(reason: "current"),
      "timestamp": voiceTimestamp()
    ])
  }

  func startObservers() {
    guard observers.isEmpty else { return }
    let center = NotificationCenter.default
    let main: (@escaping (Notification) -> Void) -> (Notification) -> Void = { handler in
      { notification in
        DispatchQueue.main.async { handler(notification) }
      }
    }
    observers.append(center.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: AVAudioSession.sharedInstance(),
      queue: nil,
      using: main { [weak self] notification in self?.routeChanged(notification) }
    ))
    observers.append(center.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: AVAudioSession.sharedInstance(),
      queue: nil,
      using: main { [weak self] notification in self?.audioInterrupted(notification) }
    ))
    if #available(iOS 26.0, *) {
      observers.append(center.addObserver(
        forName: AVAudioSession.availableInputsChangeNotification,
        object: AVAudioSession.sharedInstance(),
        queue: nil,
        using: main { [weak self] _ in self?.emitCurrentRoute() }
      ))
    }
    observers.append(center.addObserver(
      forName: UIApplication.didEnterBackgroundNotification,
      object: nil,
      queue: nil,
      using: main { [weak self] _ in self?.enteredBackground() }
    ))
    observers.append(center.addObserver(
      forName: UIApplication.willEnterForegroundNotification,
      object: nil,
      queue: nil,
      using: main { [weak self] _ in self?.emitCurrentRoute() }
    ))
  }


  private func routeChanged(_ notification: Notification) {
    guard let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
      let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
    let name = VoiceAudio.routeReason(reason)
    var audioRoute = VoiceAudio.routePayload(reason: name)
    if let previous = notification.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription {
      audioRoute["previousOutput"] = VoiceAudio.routeKind(previous)
    }
    emit(VoiceEvent.voiceEvent, [
      "type": "routeChanged",
      "route": VoiceAudio.currentRouteKind(),
      "audioRoute": audioRoute,
      "timestamp": voiceTimestamp()
    ])
    if reason == .oldDeviceUnavailable {
      stopListening(reason: "audioRouteRemoved")
      // AVSpeechSynthesizer can only flush the whole queue. Keep playback only
      // when every queued utterance permits the built-in speaker.
      if utterances.values.contains(where: { !$0.speakerFallback }) {
        stopSpeaking(reason: "audioRouteRemoved")
      }
    }
  }

  private func audioInterrupted(_ notification: Notification) {
    guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
    if type == .began {
      spatialAudio.stopAll()
      stopListening(reason: "audioInterruption")
      stopSpeaking(reason: "audioInterruption")
    }
  }

  private func enteredBackground() {
    spatialAudio.stopAll()
    stopListening(reason: "appBackground")
    stopSpeaking(reason: "appBackground")
  }

  func deactivateAudioIfIdle() {
    if recognitionTask == nil && pendingStart == nil && utterances.isEmpty && !synthesizer.isSpeaking && !synthesizer.isPaused && !spatialAudio.isActive {
      VoiceAudio.deactivate()
    }
  }

  func shutdown() {
    observers.forEach(NotificationCenter.default.removeObserver)
    observers.removeAll()
    spatialAudio.stopAll()
    stopListening(reason: "destroyed")
    stopSpeaking(reason: "destroyed")
  }

  func speechRecognizer(_ speechRecognizer: SFSpeechRecognizer, availabilityDidChange available: Bool) {
    guard available == false, speechRecognizer === recognizer, activeSessionId != nil else { return }
    let failure = VoiceFailure(
      operation: "recognition",
      code: "E_RECOGNIZER_UNAVAILABLE",
      message: "The on-device speech recognizer became unavailable. Listening has stopped."
    )
    reportError(failure)
    stopListening(reason: failure.code)
  }
}
