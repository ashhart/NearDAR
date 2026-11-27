import ExpoModulesCore
import Foundation

struct ListenOptions: Record {
  @Field var locale: String?
  @Field var silenceTimeoutMs: Double?
  @Field var preferBluetoothMicrophone: Bool = true
}

struct SpeakOptions: Record {
  @Field var utteranceId: String?
  @Field var locale: String?
  @Field var voiceIdentifier: String?
  @Field var priority: String = "answer"
  @Field var interrupt: Bool = false
  @Field var speakerFallback: Bool = true
  @Field var rate: Double?
  @Field var pitch: Double?
  @Field var volume: Double?
}

struct SpatialBeaconOptions: Record {
  @Field var active: Bool = false
  @Field var azimuthDeg: Double = 0
  @Field var distanceMeters: Double = 2.0
  @Field var headphonesOnly: Bool = true
}

struct SpatialCueOptions: Record {
  @Field var kind: String = "obstacle"
  @Field var azimuthDeg: Double = 0
  @Field var distanceMeters: Double = 1.5
  @Field var elevationMeters: Double = 0
}

struct VoiceFailure: LocalizedError {
  let operation: String
  let code: String
  let message: String
  var errorDescription: String? { message }
}

struct TrackedUtterance {
  let id: String
  let priority: String
  let speakerFallback: Bool
}

enum VoiceEvent {
  static let voiceEvent = "onVoiceEvent"
}

func voiceTimestamp() -> Double {
  Date().timeIntervalSince1970 * 1000
}

func voiceNull(_ value: Any?) -> Any {
  value ?? NSNull()
}
