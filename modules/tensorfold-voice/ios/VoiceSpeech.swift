import AVFAudio
import ExpoModulesCore
import Foundation

extension VoiceController {
  func speak(text: String, options: SpeakOptions, promise: Promise) {
    do {
      guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.count <= 10_000 else {
        throw VoiceFailure(operation: "speak", code: "E_INVALID_UTTERANCE", message: "Speech text must contain 1 to 10000 characters.")
      }
      guard ["ambient", "answer", "urgent"].contains(options.priority) else {
        throw VoiceFailure(operation: "speak", code: "E_INVALID_PRIORITY", message: "Speech priority must be ambient, answer, or urgent.")
      }
      if let rate = options.rate, rate < 0.25 || rate > 2 {
        throw VoiceFailure(operation: "speak", code: "E_INVALID_RATE", message: "Speech rate must be between 0.25 and 2.")
      }
      if let pitch = options.pitch, pitch < 0.5 || pitch > 2 {
        throw VoiceFailure(operation: "speak", code: "E_INVALID_PITCH", message: "Speech pitch must be between 0.5 and 2.")
      }
      if let volume = options.volume, volume < 0 || volume > 1 {
        throw VoiceFailure(operation: "speak", code: "E_INVALID_VOLUME", message: "Speech volume must be between 0 and 1.")
      }
      let utteranceId = options.utteranceId ?? UUID().uuidString
      guard !utteranceId.isEmpty, utteranceId.count <= 128 else {
        throw VoiceFailure(operation: "speak", code: "E_INVALID_UTTERANCE_ID", message: "utteranceId must contain 1 to 128 characters.")
      }
      guard !utterances.values.contains(where: { $0.id == utteranceId }) else {
        throw VoiceFailure(operation: "speak", code: "E_DUPLICATE_UTTERANCE", message: "The utteranceId is already active.")
      }

      let voice = try VoiceCatalog.selectVoice(identifier: options.voiceIdentifier, locale: options.locale)
      if options.interrupt {
        stopSpeaking(reason: "priorityInterruption")
      }
      stopListening(reason: "speak")
      try VoiceAudio.activate(operation: "speak", recognition: false, preferBluetoothMicrophone: false, speakerFallback: options.speakerFallback)

      let utterance = AVSpeechUtterance(string: text)
      utterance.voice = voice
      utterance.prefersAssistiveTechnologySettings = false
      let requestedRate = Float(options.rate ?? 1)
      utterance.rate = min(
        AVSpeechUtteranceMaximumSpeechRate,
        max(AVSpeechUtteranceMinimumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * requestedRate)
      )
      utterance.pitchMultiplier = Float(options.pitch ?? 1)
      utterance.volume = Float(options.volume ?? 1)
      let tracked = TrackedUtterance(id: utteranceId, priority: options.priority, speakerFallback: options.speakerFallback)
      utterances[ObjectIdentifier(utterance)] = tracked
      synthesizer.speak(utterance)
      promise.resolve([
        "utteranceId": utteranceId,
        "voiceIdentifier": voice.identifier,
        "locale": voice.language
      ])
    } catch let failure as VoiceFailure {
      reject(promise, failure: failure)
    } catch {
      let failure = VoiceFailure(operation: "speak", code: "E_SPEECH_START", message: "Could not start offline speech synthesis: \(error.localizedDescription)")
      reject(promise, failure: failure)
    }
  }

  func stopSpeaking(reason: String) {
    let active = utterances.values
    guard !active.isEmpty || synthesizer.isSpeaking || synthesizer.isPaused else {
      deactivateAudioIfIdle()
      return
    }
    let stopped = synthesizer.stopSpeaking(at: .immediate)
    guard stopped else {
      // Keep delegate state: a racing didFinish or didCancel owns the terminal event.
      reportError(VoiceFailure(operation: "stopSpeaking", code: "E_SPEECH_STOP", message: "The system speech synthesizer did not accept the immediate stop request."))
      return
    }
    utterances.removeAll()
    spatialAudio.setSpeechActive(false)
    for tracked in active.sorted(by: { $0.id < $1.id }) {
      emitUtterance(tracked, state: "stopped", reason: reason)
    }
    deactivateAudioIfIdle()
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
    DispatchQueue.main.async {
      guard let tracked = self.utterances[ObjectIdentifier(utterance)] else { return }
      self.spatialAudio.setSpeechActive(true)
      self.emitUtterance(tracked, state: "started")
    }
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    DispatchQueue.main.async {
      guard let tracked = self.utterances.removeValue(forKey: ObjectIdentifier(utterance)) else { return }
      if self.utterances.isEmpty { self.spatialAudio.setSpeechActive(false) }
      self.emitUtterance(tracked, state: "finished")
      self.deactivateAudioIfIdle()
    }
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    DispatchQueue.main.async {
      guard let tracked = self.utterances.removeValue(forKey: ObjectIdentifier(utterance)) else { return }
      if self.utterances.isEmpty { self.spatialAudio.setSpeechActive(false) }
      self.emitUtterance(tracked, state: "stopped", reason: "cancelled")
      self.deactivateAudioIfIdle()
    }
  }
}
