import AVFAudio
import Foundation
import Speech

enum VoiceCatalog {

  static func selectVoice(identifier: String?, locale: String?) throws -> AVSpeechSynthesisVoice {
    let voices = AVSpeechSynthesisVoice.speechVoices()
    let requestedLocale = normalizeLocale(locale ?? AVSpeechSynthesisVoice.currentLanguageCode())

    if let identifier {
      guard let voice = voices.first(where: { $0.identifier == identifier }) else {
        throw VoiceFailure(
          operation: "speak",
          code: "E_OFFLINE_VOICE_UNAVAILABLE",
          message: "The requested speech voice is not installed on this device. Install it in system speech settings."
        )
      }
      if let locale, normalizeLocale(voice.language) != normalizeLocale(locale) {
        throw VoiceFailure(
          operation: "speak",
          code: "E_VOICE_LOCALE_MISMATCH",
          message: "The selected offline voice does not match the requested locale \(locale)."
        )
      }
      return voice
    }

    guard !requestedLocale.isEmpty else {
      throw VoiceFailure(operation: "speak", code: "E_UNAVAILABLE_LOCALE", message: "No speech locale is available on this device.")
    }
    let exact = voices.first { normalizeLocale($0.language) == requestedLocale }
    let languageOnly = !requestedLocale.contains("-")
      ? voices.first { normalizeLocale($0.language).split(separator: "-").first.map(String.init) == requestedLocale }
      : nil
    guard let voice = exact ?? languageOnly else {
      throw VoiceFailure(
        operation: "speak",
        code: "E_OFFLINE_VOICE_UNAVAILABLE",
        message: "No installed offline speech voice matches \(requestedLocale). Install that voice in system speech settings."
      )
    }
    return voice
  }

  static func recognitionAuthorization() -> String {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .notDetermined: return "notDetermined"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .authorized: return "authorized"
    @unknown default: return "unknown"
    }
  }

  static func microphonePermission() -> String {
    switch AVAudioSession.sharedInstance().recordPermission {
    case .undetermined: return "notDetermined"
    case .denied: return "denied"
    case .granted: return "granted"
    @unknown default: return "unknown"
    }
  }

  static func normalizeLocale(_ locale: String) -> String {
    locale.replacingOccurrences(of: "_", with: "-").lowercased()
  }

}

extension VoiceController {
  func capabilities() -> [String: Any] {
    let defaultRecognizer = SFSpeechRecognizer()
    let supportsOffline = defaultRecognizer?.supportsOnDeviceRecognition ?? false
    let recognizerAvailable = defaultRecognizer?.isAvailable ?? false
    let onDeviceRecognition = supportsOffline && recognizerAvailable
    let offlineSpeech = !AVSpeechSynthesisVoice.speechVoices().isEmpty
    var reason: String?
    if defaultRecognizer == nil {
      reason = "The default recognition locale is unavailable."
    } else if !supportsOffline {
      reason = "On-device recognition is not installed for the default locale. Download the language in system settings."
    } else if !recognizerAvailable {
      reason = "The on-device speech recognizer is currently unavailable."
    } else if !offlineSpeech {
      reason = "No offline speech voice is installed. Install a voice in system speech settings."
    } else if VoiceCatalog.recognitionAuthorization() == "denied" || VoiceCatalog.recognitionAuthorization() == "restricted" {
      reason = "Speech recognition permission is not granted."
    } else if VoiceCatalog.microphonePermission() == "denied" {
      reason = "Microphone permission is not granted."
    }
    return [
      "available": onDeviceRecognition && offlineSpeech,
      "onDeviceRecognition": onDeviceRecognition,
      "offlineSpeech": offlineSpeech,
      "route": VoiceAudio.currentRouteKind(),
      "reason": voiceNull(reason)
    ]
  }
}
