import AVFAudio
import ExpoModulesCore
import Foundation
import Speech

extension VoiceController {
  func startListening(options: ListenOptions, promise: Promise) {
    do {
      let localeIdentifier = options.locale ?? SFSpeechRecognizer()?.locale.identifier ?? Locale.current.identifier
      let locale = Locale(identifier: localeIdentifier)
      guard let selectedRecognizer = SFSpeechRecognizer(locale: locale) else {
        throw VoiceFailure(operation: "startListening", code: "E_UNAVAILABLE_LOCALE", message: "Speech recognition does not support locale \(localeIdentifier).")
      }
      guard selectedRecognizer.supportsOnDeviceRecognition else {
        throw VoiceFailure(
          operation: "startListening",
          code: "E_OFFLINE_RECOGNITION_UNAVAILABLE",
          message: "On-device speech recognition is not installed for \(localeIdentifier). Download the recognition language in system settings; a network recognizer will not be used."
        )
      }
      guard selectedRecognizer.isAvailable else {
        throw VoiceFailure(operation: "startListening", code: "E_RECOGNIZER_UNAVAILABLE", message: "The on-device speech recognizer is currently unavailable for \(localeIdentifier).")
      }
      if let timeout = options.silenceTimeoutMs, timeout < 500 || timeout > 120_000 {
        throw VoiceFailure(operation: "startListening", code: "E_INVALID_TIMEOUT", message: "silenceTimeoutMs must be between 500 and 120000 milliseconds.")
      }

      stopListening(reason: "replaced")
      stopSpeaking(reason: "listening")
      recognitionGeneration += 1
      let generation = recognitionGeneration
      let sessionId = UUID().uuidString
      activeSessionId = sessionId
      activeLocale = localeIdentifier
      silenceTimeoutMs = options.silenceTimeoutMs
      hasEmittedSpeechStarted = false
      pendingStart = (generation, promise)

      let speechGranted = SFSpeechRecognizer.authorizationStatus() == .authorized
      let microphoneGranted = AVAudioSession.sharedInstance().recordPermission == .granted
      if speechGranted && microphoneGranted {
        emitListening("starting")
        beginRecognition(generation: generation, recognizer: selectedRecognizer, preferBluetooth: options.preferBluetoothMicrophone)
      } else {
        emitListening("requestingPermission")
        requestRecognitionPermissions(generation: generation, recognizer: selectedRecognizer, preferBluetooth: options.preferBluetoothMicrophone)
      }
    } catch let failure as VoiceFailure {
      pendingStart = nil
      reject(promise, failure: failure)
      activeSessionId = nil
      activeLocale = nil
    } catch {
      pendingStart = nil
      let failure = VoiceFailure(operation: "startListening", code: "E_LISTENING_START", message: error.localizedDescription)
      reject(promise, failure: failure)
      activeSessionId = nil
      activeLocale = nil
    }
  }

  private func requestRecognitionPermissions(generation: Int, recognizer: SFSpeechRecognizer, preferBluetooth: Bool) {
    let group = DispatchGroup()
    if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
      group.enter()
      SFSpeechRecognizer.requestAuthorization { _ in group.leave() }
    }
    if AVAudioSession.sharedInstance().recordPermission == .undetermined {
      group.enter()
      AVAudioSession.sharedInstance().requestRecordPermission { _ in group.leave() }
    }
    group.notify(queue: .main) { [weak self] in
      guard let self, self.recognitionGeneration == generation, self.pendingStart?.generation == generation else { return }
      guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
        self.failAuthorization(generation: generation, code: "E_SPEECH_PERMISSION", message: "Speech recognition permission was not granted. Enable it in system Settings; no network recognizer will be used.")
        return
      }
      guard AVAudioSession.sharedInstance().recordPermission == .granted else {
        self.failAuthorization(generation: generation, code: "E_MICROPHONE_PERMISSION", message: "Microphone permission was not granted. Enable it in system Settings before listening.")
        return
      }
      self.emitListening("starting")
      self.beginRecognition(generation: generation, recognizer: recognizer, preferBluetooth: preferBluetooth)
    }
  }

  private func failAuthorization(generation: Int, code: String, message: String) {
    guard let pending = pendingStart, pending.generation == generation else { return }
    pendingStart = nil
    let failure = VoiceFailure(operation: "startListening", code: code, message: message)
    reject(pending.promise, failure: failure)
    emitListening("stopped", reason: code)
    activeSessionId = nil
    activeLocale = nil
    deactivateAudioIfIdle()
  }

  private func beginRecognition(generation: Int, recognizer: SFSpeechRecognizer, preferBluetooth: Bool) {
    guard let pending = pendingStart, pending.generation == generation else { return }
    do {
      try VoiceAudio.activate(operation: "startListening", recognition: true, preferBluetoothMicrophone: preferBluetooth)
      let engine = AVAudioEngine()
      let format = engine.inputNode.outputFormat(forBus: 0)
      guard format.sampleRate > 0, format.channelCount > 0 else {
        throw VoiceFailure(operation: "startListening", code: "E_MICROPHONE_UNAVAILABLE", message: "No active microphone input is available. Check the headset and microphone privacy switch.")
      }
      let request = SFSpeechAudioBufferRecognitionRequest()
      request.requiresOnDeviceRecognition = true
      request.shouldReportPartialResults = true
      request.taskHint = .dictation

      self.recognizer = recognizer
      recognizer.delegate = self
      recognizer.queue = .main
      self.audioEngine = engine
      self.recognitionRequest = request
      engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        request.append(buffer)
      }
      recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
        DispatchQueue.main.async {
          self?.recognitionCallback(generation: generation, result: result, error: error)
        }
      }
      try engine.start()
      scheduleSilenceTimer(generation: generation)
      pendingStart = nil
      emitListening("listening")
      emitCurrentRoute()
      pending.promise.resolve([
        "sessionId": voiceNull(activeSessionId),
        "locale": voiceNull(activeLocale)
      ])
    } catch let failure as VoiceFailure {
      pendingStart = nil
      reject(pending.promise, failure: failure)
      stopListening(reason: failure.code)
    } catch {
      pendingStart = nil
      let failure = VoiceFailure(operation: "startListening", code: "E_LISTENING_START", message: "Could not start microphone recognition: \(error.localizedDescription)")
      reject(pending.promise, failure: failure)
      stopListening(reason: failure.code)
    }
  }


  private func recognitionCallback(generation: Int, result: SFSpeechRecognitionResult?, error: Error?) {
    guard generation == recognitionGeneration, activeSessionId != nil else { return }
    if let result {
      if !hasEmittedSpeechStarted {
        hasEmittedSpeechStarted = true
        emitListening("speechStarted")
      }
      let transcription = result.bestTranscription
      let text = transcription.formattedString
      let segments = transcription.segments
      let confidence = segments.isEmpty ? nil : segments.reduce(0.0) { $0 + Double($1.confidence) } / Double(segments.count)
      emit(VoiceEvent.voiceEvent, [
        "type": result.isFinal ? "final" : "partial",
        "sessionId": activeSessionId ?? "",
        "text": text,
        "alternatives": result.transcriptions.map { $0.formattedString },
        "confidence": voiceNull(confidence),
        "locale": activeLocale ?? "",
        "timestamp": voiceTimestamp()
      ])
      if result.isFinal {
        stopListening(reason: "completed")
        return
      }
      scheduleSilenceTimer(generation: generation)
    }
    if let error {
      let nsError = error as NSError
      let failure = VoiceFailure(
        operation: "recognition",
        code: "E_RECOGNITION_\(nsError.code)",
        message: "On-device speech recognition failed: \(error.localizedDescription)"
      )
      reportError(failure)
      stopListening(reason: failure.code)
    }
  }

  private func scheduleSilenceTimer(generation: Int) {
    silenceTimer?.invalidate()
    guard let milliseconds = silenceTimeoutMs else { return }
    silenceTimer = Timer.scheduledTimer(withTimeInterval: milliseconds / 1000, repeats: false) { [weak self] _ in
      guard let self, generation == self.recognitionGeneration, self.recognitionTask != nil else { return }
      self.recognitionRequest?.endAudio()
      self.audioEngine?.inputNode.removeTap(onBus: 0)
      self.audioEngine?.stop()
      self.emitListening("speechEnded", reason: "silenceTimeout")
      self.silenceTimer = nil
    }
  }

  func stopListening(reason: String) {
    let hadSession = activeSessionId != nil || pendingStart != nil
    if let pending = pendingStart {
      pending.promise.reject("E_LISTENING_CANCELLED", "Listening stopped before microphone recognition started: \(reason).")
    }
    pendingStart = nil
    recognitionGeneration += 1
    silenceTimer?.invalidate()
    silenceTimer = nil
    silenceTimeoutMs = nil
    audioEngine?.inputNode.removeTap(onBus: 0)
    audioEngine?.stop()
    audioEngine = nil
    recognitionRequest?.endAudio()
    recognitionRequest = nil
    recognitionTask?.cancel()
    recognitionTask = nil
    recognizer?.delegate = nil
    recognizer = nil
    hasEmittedSpeechStarted = false
    if hadSession { emitListening("stopped", reason: reason) }
    activeSessionId = nil
    activeLocale = nil
    deactivateAudioIfIdle()
  }
}
