import AVFAudio
import Foundation

final class SpatialAudioEngine {
  private let sampleRate: Double = 44_100
  private let monoFormat: AVAudioFormat
  private var engine: AVAudioEngine?
  private var environment: AVAudioEnvironmentNode?
  private var beaconPlayer: AVAudioPlayerNode?
  private var cuePlayer: AVAudioPlayerNode?
  private var beaconTimer: Timer?

  private var beaconActive = false
  private var beaconAzimuthDeg: Double = 0
  private var beaconDistanceMeters: Double = 2.0
  private var beaconHeadphonesOnly = true
  private var pausedForMic = false
  private var duckedForSpeech = false

  private let alignedBuffer: AVAudioPCMBuffer
  private let offAxisBuffer: AVAudioPCMBuffer
  private let obstacleBuffer: AVAudioPCMBuffer
  private let headHazardBuffer: AVAudioPCMBuffer
  private let dropOffBuffer: AVAudioPCMBuffer
  private let fastMoverBuffer: AVAudioPCMBuffer
  private let presenceBuffer: AVAudioPCMBuffer
  private let openingBuffer: AVAudioPCMBuffer
  private let standbyBuffer: AVAudioPCMBuffer
  private let turnBuffer: AVAudioPCMBuffer
  private let micOpenBuffer: AVAudioPCMBuffer
  private let micCloseBuffer: AVAudioPCMBuffer
  private let arrivedBuffer: AVAudioPCMBuffer

  var isActive: Bool { beaconActive }

  init() {
    monoFormat = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
    alignedBuffer = Self.makeChime(format: monoFormat, notes: [(523.25, 0.0, 0.14), (659.25, 0.04, 0.14)], gain: 0.18)
    offAxisBuffer = Self.makeChime(format: monoFormat, notes: [(440.0, 0.0, 0.11)], gain: 0.15)
    obstacleBuffer = Self.makeChime(format: monoFormat, notes: [(620.0, 0.0, 0.075)], gain: 0.22)
    headHazardBuffer = Self.makeChime(format: monoFormat, notes: [(1174.66, 0.0, 0.09), (1760.0, 0.045, 0.09)], gain: 0.25)
    dropOffBuffer = Self.makeChime(format: monoFormat, notes: [(330.0, 0.0, 0.10), (200.0, 0.08, 0.13)], gain: 0.28)
    fastMoverBuffer = Self.makeSweep(format: monoFormat, sweeps: [(760.0, 1440.0, 0.0, 0.09), (920.0, 1760.0, 0.095, 0.10)], gain: 0.30)
    presenceBuffer = Self.makeChime(format: monoFormat, notes: [(310.0, 0.0, 0.045), (392.0, 0.055, 0.055)], gain: 0.13)
    openingBuffer = Self.makeChime(format: monoFormat, notes: [(587.33, 0.0, 0.06), (880.0, 0.045, 0.075), (1174.66, 0.09, 0.09)], gain: 0.14)
    standbyBuffer = Self.makeChime(format: monoFormat, notes: [(520.0, 0.0, 0.07), (390.0, 0.06, 0.09)], gain: 0.14)
    turnBuffer = Self.makeChime(format: monoFormat, notes: [(587.33, 0.0, 0.09), (880.0, 0.07, 0.11)], gain: 0.24)
    micOpenBuffer = Self.makeChime(format: monoFormat, notes: [(520.0, 0.0, 0.055), (780.0, 0.045, 0.065)], gain: 0.20)
    micCloseBuffer = Self.makeChime(format: monoFormat, notes: [(660.0, 0.0, 0.055), (440.0, 0.045, 0.06)], gain: 0.16)
    arrivedBuffer = Self.makeChime(format: monoFormat, notes: [(523.25, 0.0, 0.11), (659.25, 0.09, 0.11), (783.99, 0.18, 0.16)], gain: 0.22)
  }

  func updateBeacon(active: Bool, azimuthDeg: Double, distanceMeters: Double, headphonesOnly: Bool) {
    beaconActive = active
    beaconAzimuthDeg = azimuthDeg.isFinite ? azimuthDeg : 0
    beaconDistanceMeters = distanceMeters.isFinite ? max(0.6, min(6.0, distanceMeters)) : 2.0
    beaconHeadphonesOnly = headphonesOnly

    if !active {
      beaconTimer?.invalidate()
      beaconTimer = nil
      beaconPlayer?.stop()
      return
    }

    if beaconTimer == nil {
      let timer = Timer.scheduledTimer(withTimeInterval: 1.25, repeats: true) { [weak self] _ in
        self?.tickBeacon()
      }
      RunLoop.main.add(timer, forMode: .common)
      beaconTimer = timer
      tickBeacon()
    }
  }

  func playCue(kind: String, azimuthDeg: Double = 0, distanceMeters: Double = 1.5, elevationMeters: Double = 0) {
    guard !pausedForMic else { return }
    let isUiEarcon = kind == "mic-open" || kind == "mic-close" || kind == "arrived" || kind == "paused" || kind == "resumed" || kind == "standby"
    let isUrgent = kind == "fast-mover" || kind == "head-height" || kind == "drop-off" || kind == "step-down"
    if !isUiEarcon && !isUrgent && VoiceAudio.currentRouteKind() != "headphones" {
      // Only play ambient directional spatial pings on headphones; UI earcons and urgent warnings work everywhere.
      if kind == "obstacle" || kind == "presence" || kind == "opening" { return }
    }
    guard ensureStarted(allowSpeaker: true), let player = cuePlayer else { return }

    let buffer: AVAudioPCMBuffer
    var az = azimuthDeg
    var elev = elevationMeters
    switch kind {
    case "obstacle":
      buffer = obstacleBuffer
    case "head-height":
      buffer = headHazardBuffer
      elev = 0.9
    case "drop-off", "step-down":
      buffer = dropOffBuffer
      elev = -0.9
    case "fast-mover":
      buffer = fastMoverBuffer
    case "presence":
      buffer = presenceBuffer
    case "opening":
      buffer = openingBuffer
    case "standby":
      buffer = standbyBuffer
      az = 0
    case "turn-left":
      buffer = turnBuffer
      az = -65
    case "turn-right":
      buffer = turnBuffer
      az = 65
    case "mic-open", "resumed":
      buffer = micOpenBuffer
      az = 0
    case "mic-close", "paused":
      buffer = micCloseBuffer
      az = 0
    case "arrived":
      buffer = arrivedBuffer
      az = 0
    default:
      buffer = offAxisBuffer
    }

    let dist = max(0.7, min(5.0, distanceMeters.isFinite ? distanceMeters : 1.5))
    player.position = point3D(azimuthDeg: az, distance: dist, elevation: elev)
    player.volume = duckedForSpeech && !isUiEarcon && !isUrgent ? 0.35 : 0.95
    player.stop()
    player.scheduleBuffer(buffer, at: nil, options: [], completionHandler: nil)
    if !player.isPlaying { player.play() }
  }

  func setMicActive(_ active: Bool) {
    pausedForMic = active
    if active {
      beaconPlayer?.stop()
      cuePlayer?.stop()
      engine?.pause()
    } else if beaconActive {
      _ = ensureStarted(allowSpeaker: !beaconHeadphonesOnly)
    }
  }

  func setSpeechActive(_ speaking: Bool) {
    duckedForSpeech = speaking
    let vol: Float = speaking ? 0.30 : 0.90
    beaconPlayer?.volume = vol
  }

  func stopAll() {
    beaconActive = false
    beaconTimer?.invalidate()
    beaconTimer = nil
    beaconPlayer?.stop()
    cuePlayer?.stop()
    engine?.stop()
    engine = nil
    environment = nil
    beaconPlayer = nil
    cuePlayer = nil
  }

  private func tickBeacon() {
    guard beaconActive, !pausedForMic else { return }
    if beaconHeadphonesOnly && VoiceAudio.currentRouteKind() != "headphones" { return }
    guard ensureStarted(allowSpeaker: !beaconHeadphonesOnly), let player = beaconPlayer else { return }

    let aligned = abs(beaconAzimuthDeg) <= 14.0
    let buffer = aligned ? alignedBuffer : offAxisBuffer
    player.position = point3D(azimuthDeg: beaconAzimuthDeg, distance: beaconDistanceMeters, elevation: 0)
    player.volume = duckedForSpeech ? 0.28 : 0.88
    player.stop()
    player.scheduleBuffer(buffer, at: nil, options: [], completionHandler: nil)
    if !player.isPlaying { player.play() }
  }

  private func ensureStarted(allowSpeaker: Bool) -> Bool {
    guard !pausedForMic else { return false }
    do {
      try VoiceAudio.activate(operation: "spatialAudio", recognition: false, preferBluetoothMicrophone: false, speakerFallback: allowSpeaker)
      if engine == nil {
        let eng = AVAudioEngine()
        let env = AVAudioEnvironmentNode()
        let beacon = AVAudioPlayerNode()
        let cue = AVAudioPlayerNode()

        env.listenerPosition = AVAudio3DPoint(x: 0, y: 0, z: 0)
        env.listenerAngularOrientation = AVAudio3DAngularOrientation(yaw: 0, pitch: 0, roll: 0)
        env.distanceAttenuationParameters.referenceDistance = 1.0
        env.distanceAttenuationParameters.maximumDistance = 10.0
        env.distanceAttenuationParameters.rolloffFactor = 0.8

        beacon.renderingAlgorithm = .HRTFHQ
        cue.renderingAlgorithm = .HRTFHQ

        eng.attach(env)
        eng.attach(beacon)
        eng.attach(cue)
        eng.connect(beacon, to: env, format: monoFormat)
        eng.connect(cue, to: env, format: monoFormat)
        eng.connect(env, to: eng.mainMixerNode, format: nil)

        engine = eng
        environment = env
        beaconPlayer = beacon
        cuePlayer = cue
      }
      if let eng = engine, !eng.isRunning {
        eng.prepare()
        try eng.start()
      }
      return true
    } catch {
      return false
    }
  }

  private func point3D(azimuthDeg: Double, distance: Double, elevation: Double) -> AVAudio3DPoint {
    let rad = Float(azimuthDeg * Double.pi / 180.0)
    let d = Float(distance)
    return AVAudio3DPoint(x: sin(rad) * d, y: Float(elevation), z: -cos(rad) * d)
  }

  private static func makeChime(format: AVAudioFormat, notes: [(Double, Double, Double)], gain: Float) -> AVAudioPCMBuffer {
    let sr = format.sampleRate
    let totalDuration = notes.map { $0.1 + $0.2 }.max() ?? 0.1
    let frameCount = AVAudioFrameCount(max(64, Int((totalDuration + 0.02) * sr)))
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount)!
    buffer.frameLength = frameCount
    let samples = buffer.floatChannelData![0]
    for i in 0..<Int(frameCount) { samples[i] = 0 }

    for (freq, startSec, durSec) in notes {
      let startIdx = max(0, Int(startSec * sr))
      let noteFrames = max(1, Int(durSec * sr))
      let endIdx = min(Int(frameCount), startIdx + noteFrames)
      let attack = max(1.0, 0.012 * sr)
      for i in startIdx..<endIdx {
        let local = Double(i - startIdx)
        let t = local / sr
        let attackEnv = min(1.0, local / attack)
        let decayEnv = exp(-4.5 * (local / Double(noteFrames)))
        let env = Float(attackEnv * decayEnv)
        let fundamental = sin(2.0 * Double.pi * freq * t)
        let overtone = 0.25 * sin(2.0 * Double.pi * (freq * 2.0) * t)
        samples[i] += Float(fundamental + overtone) * env * gain
      }
    }
    return buffer
  }

  private static func makeSweep(format: AVAudioFormat, sweeps: [(Double, Double, Double, Double)], gain: Float) -> AVAudioPCMBuffer {
    let sr = format.sampleRate
    let totalDuration = sweeps.map { $0.2 + $0.3 }.max() ?? 0.1
    let frameCount = AVAudioFrameCount(max(64, Int((totalDuration + 0.02) * sr)))
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount)!
    buffer.frameLength = frameCount
    let samples = buffer.floatChannelData![0]
    for i in 0..<Int(frameCount) { samples[i] = 0 }

    for (startFreq, endFreq, startSec, durSec) in sweeps {
      let startIdx = max(0, Int(startSec * sr))
      let noteFrames = max(1, Int(durSec * sr))
      let endIdx = min(Int(frameCount), startIdx + noteFrames)
      let attack = max(1.0, 0.008 * sr)
      var phase = 0.0
      for i in startIdx..<endIdx {
        let local = Double(i - startIdx)
        let frac = local / Double(noteFrames)
        let freq = startFreq + (endFreq - startFreq) * frac
        phase += 2.0 * Double.pi * freq / sr
        let attackEnv = min(1.0, local / attack)
        let releaseEnv = min(1.0, Double(endIdx - i) / max(1.0, 0.015 * sr))
        let env = Float(attackEnv * releaseEnv)
        samples[i] += Float(sin(phase)) * env * gain
      }
    }
    return buffer
  }
}
