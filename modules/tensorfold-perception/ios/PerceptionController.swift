import ARKit
import AVFoundation
import Foundation
import ImageIO

final class PerceptionController: NSObject, ARSessionDelegate {
  private let session = ARSession()
  private let processingQueue = DispatchQueue(label: "tensorfold.perception.processing", qos: .userInitiated)
  private let visionQueue = DispatchQueue(label: "tensorfold.perception.vision", qos: .userInitiated)
  private let previewQueue = DispatchQueue(label: "tensorfold.perception.preview", qos: .userInitiated)
  private var preview: (id: ObjectIdentifier, display: (CGImage) -> Void)?
  private var renderingPreview = false
  private var lastPreviewTime: TimeInterval = 0
  private var settings = try! PerceptionSettings(nil)
  private var frameClock = PerceptionFrameClock()
  private var imageOrientation = CGImagePropertyOrientation.right
  private let meshes = MeshStore()
  private let approachTracker = ApproachTracker()
  private var headingAligned = false
  private var detectedFloorY: Float?
  private var active = false
  private var latestSnapshot: [String: Any]?
  private var latestPeople: [[String: Any]] = []
  private var latestAnimals: [[String: Any]] = []
  private var lastPersonScanFrameTime: Double?
  private var personTaskRunning = false
  private var lastPersonRequestUptime = 0.0
  private var personSequence = 0
  private var animalSequence = 0
  private var lastEmissionUptime = 0.0
  private var captureInProgress = false
  private var latestCaptureURI: String?
  private var lastCaptureAt: Double?
  private var staleTimer: DispatchSourceTimer?
  private var captureGeneration = 0
  private var seatTargets: [String: SeatTarget] = [:]
  private var seatCaptureTime: Double?
  private var seatCaptureFrameTime: Double?
  private var seatCapturePosition: SIMD3<Float>?
  private var seatAlignment: SeatAlignment?
  var emit: ((String, [String: Any]) -> Void)?

  private struct SeatTarget {
    let anchorID: UUID
    let capturePosition: SIMD3<Float>
  }

  private struct SeatAlignment {
    let target: SeatTarget
    let origin: SIMD3<Float>
    let completes: (String) -> Void
    let startedAt: TimeInterval
    var dwell = SeatAlignmentDwell()
  }

  override init() {
    super.init()
    session.delegate = self
  }

  var captureDirectory: URL {
    URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("TensorFoldPerception", isDirectory: true)
  }

  func capabilities() -> [String: Any] {
    let depth = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    let mesh = ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification)
    var limitations: [String] = []
    if !ARWorldTrackingConfiguration.isSupported { limitations.append("ARKit world tracking is unavailable on this device.") }
    if !depth { limitations.append("Scene-depth proximity requires a device with ARKit scene-depth support, typically LiDAR.") }
    if !mesh { limitations.append("Seat and surface classification requires ARKit mesh classification.") }
    let permission = cameraPermission()
    let available = ARWorldTrackingConfiguration.isSupported && permission != "denied" && permission != "restricted"
    let reason = available ? nil : (permission == "denied" || permission == "restricted" ? "Camera access is denied or restricted." : limitations.first)
    var result: [String: Any] = [
      "available": available, "depth": depth, "detector": true,
      "cameraPreview": ARWorldTrackingConfiguration.isSupported,
      "platform": "ios", "arSupported": ARWorldTrackingConfiguration.isSupported,
      "arAvailability": ARWorldTrackingConfiguration.isSupported ? "supported" : "unsupported",
      "cameraPermission": permission, "depthSupported": depth, "rawDepth": depth,
      "meshClassification": mesh, "personDetection": true, "freeSeatCandidates": mesh && depth,
      "ocr": true, "ocrMode": "onDeviceSystem", "captureFormat": ARWorldTrackingConfiguration.isSupported ? "jpeg-file" : "unavailable", "limitations": limitations
    ]
    if let reason { result["reason"] = reason }
    return result
  }

  func start(options: [String: Any]?, completion: @escaping (Result<[String: Any], PerceptionError>) -> Void) {
    let nextSettings: PerceptionSettings
    do { nextSettings = try PerceptionSettings(options) }
    catch let error as PerceptionError { completion(.failure(error)); return }
    catch { completion(.failure(PerceptionError("E_OPTIONS", "The perception settings are invalid."))); return }
    guard ARWorldTrackingConfiguration.isSupported else {
      completion(.failure(PerceptionError("E_AR_UNSUPPORTED", "ARKit world tracking is unavailable on this device."))); return
    }
    let begin = { [weak self] in
      guard let self else { return }
      DispatchQueue.main.async {
        self.stopInternal()
        let orientation = PerceptionVision.interfaceOrientation()
        let configuration = ARWorldTrackingConfiguration()
        configuration.planeDetection = [.horizontal, .vertical]
        configuration.worldAlignment = .gravityAndHeading
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
          configuration.frameSemantics.insert(.sceneDepth)
        }
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification) {
          configuration.sceneReconstruction = .meshWithClassification
        }
        self.session.delegateQueue = self.processingQueue
        self.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
        self.processingQueue.async {
          self.settings = nextSettings
          self.frameClock = PerceptionFrameClock()
          self.imageOrientation = orientation
          self.headingAligned = true
          self.detectedFloorY = nil
          self.active = true
          self.latestSnapshot = nil
          self.latestPeople = []
          self.latestAnimals = []
          self.lastPersonScanFrameTime = nil
          self.meshes.clear()
          self.approachTracker.reset()
          self.startStaleTimer()
          var result: [String: Any] = ["active": true, "capabilities": self.capabilities()]
          if let length = self.settings.stepLength { result["stepLengthMeters"] = length }
          completion(.success(result))
        }
      }
    }
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: begin()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { granted in
        if granted { begin() }
        else { completion(.failure(PerceptionError("E_CAMERA_PERMISSION", "Camera access is required for on-device perception."))) }
      }
    default:
      completion(.failure(PerceptionError("E_CAMERA_PERMISSION", "Camera access is denied or restricted. Enable it in system settings.")))
    }
  }

  func stop(completion: @escaping ([String: Any]) -> Void) {
    DispatchQueue.main.async {
      self.stopInternal()
      completion(["active": false])
    }
  }

  private func stopInternal() {
    session.pause()
    processingQueue.sync {
      active = false
      preview = nil
      lastPreviewTime = 0
      invalidateFrameContext(result: "cancelled")
      staleTimer?.cancel()
      staleTimer = nil
      latestSnapshot = nil
      latestCaptureURI = nil
      lastCaptureAt = nil
      PerceptionVision.pruneCaptures(directory: captureDirectory)
      meshes.clear()
      approachTracker.reset()
      detectedFloorY = nil
      headingAligned = false
    }
  }

  private func startStaleTimer() {
    staleTimer?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: processingQueue)
    timer.schedule(deadline: .now() + .milliseconds(500), repeating: .milliseconds(500))
    timer.setEventHandler { [weak self] in
      guard let self, self.active else { return }
      let now = ProcessInfo.processInfo.systemUptime
      if let alignment = self.seatAlignment, now - alignment.startedAt >= 20 {
        self.finishSeatAlignment("timed-out")
      }
      guard let frame = self.session.currentFrame else { return }
      let age = PerceptionFrameClock.ageMilliseconds(of: frame.timestamp, at: now)
      if !PerceptionFrameClock.isFresh(age, maximum: self.settings.maximumFrameAgeMs) {
        self.clearSeatTargets(result: "tracking-lost")
        self.process(frame: frame, allowVision: false, force: true)
      }
    }
    staleTimer = timer
    timer.resume()
  }

  func capture(options: [String: Any]?, completion: @escaping (Result<[String: Any], PerceptionError>) -> Void) {
    processingQueue.async { self.captureOnQueue(options: options, completion: completion) }
  }

  private func captureOnQueue(options: [String: Any]?, completion: @escaping (Result<[String: Any], PerceptionError>) -> Void) {
    guard active, let frame = session.currentFrame else {
      completion(.failure(PerceptionError("E_NO_FRAME", "Start a perception session and wait for a camera frame."))); return
    }
    let sampledAt = ProcessInfo.processInfo.systemUptime
    let age = PerceptionFrameClock.ageMilliseconds(of: frame.timestamp, at: sampledAt)
    guard PerceptionFrameClock.isFresh(age, maximum: settings.maximumFrameAgeMs) else {
      completion(.failure(PerceptionError("E_STALE_FRAME", "The latest camera frame is stale. Wait for fresh tracking before capturing."))); return
    }
    let includeImage = options?["includeImage"] as? Bool ?? true
    let detectPeople = options?["detectPeople"] as? Bool ?? settings.detectPeople
    let recognizeText = options?["recognizeText"] as? Bool ?? settings.recognizeText
    let quality = options?["jpegQuality"] as? Double ?? 0.85
    let maxImageLongEdge = (options?["maxImageLongEdge"] as? Double).flatMap { (128...4096).contains($0) ? $0 : nil }
    let generation = captureGeneration
    let timestamp = frameClock.unixMilliseconds(for: frame.timestamp)
    let orientation = imageOrientation
    let settings = self.settings
    clearSeatTargets(result: "cancelled")
    captureInProgress = true
    visionQueue.async {
      var people: [[String: Any]] = []
      var animals: [[String: Any]] = []
      var text: [[String: Any]] = []
      var captureError: PerceptionError?
      var personScanSucceeded = true
      if detectPeople {
        do {
          let detected = try PerceptionVision.peopleAndAnimals(frame: frame, orientation: orientation, timestamp: timestamp, settings: settings)
          people = detected.people
          animals = detected.animals
        }
        catch {
          personScanSucceeded = false
          self.report("E_VISION", "Person and animal detection failed for this capture: \(error.localizedDescription)", recoverable: true)
        }
      }
      if recognizeText {
        do { text = try PerceptionVision.text(frame: frame, orientation: orientation, settings: settings) }
        catch { self.report("E_OCR", "On-device text recognition failed: \(error.localizedDescription)", recoverable: true) }
      }
      var image: [String: Any]?
      if includeImage {
        do { image = try PerceptionVision.writeJPEG(frame: frame, orientation: orientation, quality: quality, timestamp: timestamp, maxImageLongEdge: maxImageLongEdge) }
        catch let error as PerceptionError { captureError = error }
        catch { captureError = PerceptionError("E_CAPTURE", "JPEG capture failed: \(error.localizedDescription)") }
      }
      self.processingQueue.async {
        guard self.active, generation == self.captureGeneration else {
          if let uri = image?["uri"] as? String {
            _ = PerceptionVision.releaseCapture(uri, directory: self.captureDirectory)
          }
          completion(.failure(PerceptionError("E_SESSION_INACTIVE", "The perception session stopped during capture.")))
          return
        }
        if detectPeople, personScanSucceeded { self.updateVisionEntities(people: people, animals: animals, frameTime: frame.timestamp) }
        let snapshot = self.makeSnapshot(frame: frame, mode: "capture", ocr: text, image: image,
          sampledAt: sampledAt, sameFramePersonScan: detectPeople && personScanSucceeded)
        self.captureInProgress = false
        if let captureError {
          self.latestCaptureURI = nil
          self.lastCaptureAt = nil
          PerceptionVision.pruneCaptures(directory: self.captureDirectory)
          self.report(captureError.code, captureError.message, recoverable: true)
          completion(.failure(captureError))
          return
        }
        self.latestCaptureURI = image?["uri"] as? String
        self.lastCaptureAt = timestamp
        if image == nil { PerceptionVision.pruneCaptures(directory: self.captureDirectory) }
        self.latestSnapshot = snapshot
        self.rememberSeatTargets(snapshot: snapshot, frame: frame)
        self.emit?("onSnapshot", snapshot)
        completion(.success(snapshot))
      }
    }
  }

  private func rememberSeatTargets(snapshot: [String: Any], frame: ARFrame) {
    let camera = frame.camera
    guard snapshot["depthState"] as? String == "available", isNormalTracking(camera.trackingState),
      let objects = snapshot["objects"] as? [[String: Any]] else { return }
    seatCaptureTime = snapshot["cameraTimestampMs"] as? Double
    seatCaptureFrameTime = frame.timestamp
    let position = camera.transform.columns.3
    seatCapturePosition = SIMD3(position.x, position.y, position.z)
    for object in objects where object["source"] as? String == "arkit-mesh-classification" && object["label"] as? String == "seat" {
      guard let id = object["id"] as? String, let anchorID = object["anchorId"] as? UUID, let center = object["center"] as? [String: Double],
        let x = center["x"], let y = center["y"], let z = center["z"],
        let distance = object["distanceMeters"] as? Double, (0.5...5).contains(distance) else { continue }
      let world = camera.transform * SIMD4(Float(x), Float(y), -Float(z), 1)
      seatTargets[id] = SeatTarget(anchorID: anchorID, capturePosition: SIMD3(world.x, world.y, world.z))
    }
  }

  func alignToSeat(id: String, observedAt: Double, completion: @escaping (String) -> Void) {
    processingQueue.async {
      self.finishSeatAlignment("cancelled")
      let now = ProcessInfo.processInfo.systemUptime
      guard self.active, self.seatCaptureTime == observedAt, let capturedAt = self.seatCaptureFrameTime, (0...45).contains(now - capturedAt),
        let target = self.seatTargets[id], let origin = self.seatCapturePosition, let frame = self.session.currentFrame, frame.sceneDepth != nil,
        isNormalTracking(frame.camera.trackingState),
        PerceptionFrameClock.isFresh(PerceptionFrameClock.ageMilliseconds(of: frame.timestamp, at: now), maximum: self.settings.maximumFrameAgeMs) else {
        completion("unavailable")
        return
      }
      let position = frame.camera.transform.columns.3
      guard simd_distance(SIMD3(position.x, position.y, position.z), origin) <= 0.5 else {
        self.clearSeatTargets(result: "moved")
        completion("moved")
        return
      }
      self.seatAlignment = SeatAlignment(target: target, origin: origin, completes: completion, startedAt: now)
    }
  }

  func cancelSeatAlignment() {
    processingQueue.sync { finishSeatAlignment("cancelled") }
  }

  private func clearSeatTargets(result: String) {
    seatTargets.removeAll()
    seatCaptureTime = nil
    seatCaptureFrameTime = nil
    seatCapturePosition = nil
    finishSeatAlignment(result)
  }

  private func invalidateFrameContext(result: String) {
    captureGeneration += 1
    captureInProgress = false
    personTaskRunning = false
    lastPersonRequestUptime = 0
    lastPersonScanFrameTime = nil
    latestPeople = []
    latestAnimals = []
    approachTracker.reset()
    clearSeatTargets(result: result)
  }

  private func finishSeatAlignment(_ result: String) {
    let pending = seatAlignment
    seatAlignment = nil
    pending?.completes(result)
  }

  private func updateSeatAlignment(_ frame: ARFrame) {
    guard isNormalTracking(frame.camera.trackingState) else {
      if !seatTargets.isEmpty { clearSeatTargets(result: "tracking-lost") }
      return
    }
    guard var alignment = seatAlignment else { return }
    let now = ProcessInfo.processInfo.systemUptime
    if now - alignment.startedAt >= 20 {
      finishSeatAlignment("timed-out")
      return
    }
    guard PerceptionFrameClock.isFresh(PerceptionFrameClock.ageMilliseconds(of: frame.timestamp, at: now), maximum: settings.maximumFrameAgeMs),
      let target = meshes.position(ofSeatIn: alignment.target.anchorID, frame: frame),
      simd_distance(target, alignment.target.capturePosition) <= 0.30 else {
      clearSeatTargets(result: "tracking-lost")
      return
    }
    let transform = frame.camera.transform
    let origin = SIMD3(transform.columns.3.x, transform.columns.3.y, transform.columns.3.z)
    guard simd_distance(origin, alignment.origin) <= 0.5 else {
      clearSeatTargets(result: "moved")
      return
    }
    let forward = -SIMD2(transform.columns.2.x, transform.columns.2.z)
    let toward = SIMD2(target.x - origin.x, target.z - origin.z)
    let aligned = simd_length(forward) >= 0.35 && simd_length(toward) >= 0.35 &&
      simd_dot(simd_normalize(forward), simd_normalize(toward)) >= cos(12 * Float.pi / 180)
    let cameraPoint = transform.inverse * SIMD4(target, 1)
    let depthAgrees = aligned && Geometry.depthConfirms(cameraPoint: SIMD3(Double(cameraPoint.x), Double(cameraPoint.y), -Double(cameraPoint.z)), frame: frame)
    if alignment.dwell.observe(timestamp: frame.timestamp, matching: depthAgrees) {
      finishSeatAlignment("aligned")
    } else {
      seatAlignment = alignment
    }
  }

  func release(_ uri: String) -> [String: Any] {
    processingQueue.sync {
      let released = PerceptionVision.releaseCapture(uri, directory: captureDirectory)
      if released && latestCaptureURI == uri { latestCaptureURI = nil }
      return ["released": released]
    }
  }

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    process(frame: frame, allowVision: true, force: false)
    updateSeatAlignment(frame)
    publishPreview(frame)
  }

  func setPreview(id: ObjectIdentifier, display: ((CGImage) -> Void)?) {
    processingQueue.async {
      if let display, self.active { self.preview = (id, display) }
      else if self.preview?.id == id { self.preview = nil }
    }
  }

  private func publishPreview(_ frame: ARFrame) {
    guard active, let preview, !renderingPreview, frame.timestamp - lastPreviewTime >= 0.1 else { return }
    renderingPreview = true
    lastPreviewTime = frame.timestamp
    let buffer = frame.capturedImage
    let orientation = imageOrientation
    let generation = captureGeneration
    previewQueue.async {
      let image = PerceptionVision.previewImage(buffer: buffer, orientation: orientation)
      self.processingQueue.async {
        self.renderingPreview = false
        guard self.active, self.captureGeneration == generation, self.preview?.id == preview.id, let image else { return }
        preview.display(image)
      }
    }
  }

  func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
    for anchor in anchors {
      if let mesh = anchor as? ARMeshAnchor { meshes.update(mesh) }
      else if let plane = anchor as? ARPlaneAnchor { updateFloorPlane(plane) }
    }
  }

  func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
    for anchor in anchors {
      if let mesh = anchor as? ARMeshAnchor { meshes.update(mesh) }
      else if let plane = anchor as? ARPlaneAnchor { updateFloorPlane(plane) }
    }
  }

  private func updateFloorPlane(_ plane: ARPlaneAnchor) {
    guard plane.alignment == .horizontal else { return }
    let y = plane.transform.columns.3.y
    if plane.classification == .floor {
      detectedFloorY = y
    } else if let cam = session.currentFrame?.camera.transform.columns.3.y, y < cam - 0.65 {
      if let current = detectedFloorY {
        if y < current { detectedFloorY = y }
      } else {
        detectedFloorY = y
      }
    }
  }

  func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
    meshes.remove(anchors)
    for anchor in anchors {
      let id = "mesh-\(anchor.identifier.uuidString)-seat"
      seatTargets.removeValue(forKey: id)
      if seatAlignment?.target.anchorID == anchor.identifier { finishSeatAlignment("tracking-lost") }
    }
  }

  func session(_ session: ARSession, didFailWithError error: Error) {
    invalidateFrameContext(result: "tracking-lost")
    report("E_AR_SESSION", "ARKit stopped the perception session: \(error.localizedDescription)", recoverable: true)
  }

  func sessionWasInterrupted(_ session: ARSession) {
    invalidateFrameContext(result: "tracking-lost")
    reportingStatus(tracking: "paused", reason: "The camera session was interrupted by the system.")
  }

  func sessionInterruptionEnded(_ session: ARSession) {
    reportingStatus(tracking: "limited", reason: "Camera tracking is resuming after an interruption.")
  }

  func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
    if active && !isNormalTracking(camera.trackingState) { invalidateFrameContext(result: "tracking-lost") }
  }

  private func process(frame: ARFrame, allowVision: Bool, force: Bool) {
    guard active else { return }
    let now = ProcessInfo.processInfo.systemUptime
    guard force || (now - lastEmissionUptime) * 1000 >= settings.proximityIntervalMs else {
      if allowVision { schedulePeople(frame) }
      return
    }
    lastEmissionUptime = now
    let snapshot = makeSnapshot(frame: frame, mode: "proximity", ocr: [], image: nil, sampledAt: now)
    latestSnapshot = snapshot
    emit?("onSnapshot", snapshot)
    emit?("onStatus", status(snapshot))
    let snapshotAim = snapshot["aimState"] as? String ?? "level"
    if snapshot["depthState"] as? String == "available", isNormalTracking(frame.camera.trackingState),
      snapshotAim != "lowered", snapshotAim != "covered" {
      let hazards = snapshot["hazards"] as? [[String: Any]] ?? []
      if let fastMover = hazards.first(where: { ($0["kind"] as? String) == "fast-mover" }) {
        var payload: [String: Any] = [
          "id": fastMover["id"] as? String ?? "lidar-fast-mover",
          "kind": "fast-mover",
          "timestampMs": frameClock.unixMilliseconds(for: frame.timestamp),
          "severity": "critical",
          "direction": ["bearing": fastMover["direction"] as? String ?? "ahead", "yawDegrees": fastMover["bearingDegrees"] as? Double ?? 0],
          "distanceMeters": fastMover["distanceMeters"] as? Double ?? 0,
          "message": fastMover["message"] as? String ?? "Fast movement ahead — hold still."
        ]
        if let closing = fastMover["closingSpeedMps"] as? Double { payload["closingSpeedMps"] = closing }
        if let external = fastMover["externalSpeedMps"] as? Double { payload["externalSpeedMps"] = external }
        if let ttc = fastMover["ttcSeconds"] as? Double { payload["ttcSeconds"] = ttc }
        emit?("onWarning", payload)
      } else if let verticalHazard = hazards.first(where: {
        let kind = $0["kind"] as? String ?? ""
        return kind == "head-height" || kind == "drop-off" || kind == "step-down" || kind == "step-up"
      }) {
        emit?("onWarning", [
          "id": verticalHazard["id"] as? String ?? "lidar-vertical-hazard",
          "kind": verticalHazard["kind"] as? String ?? "obstacle",
          "timestampMs": frameClock.unixMilliseconds(for: frame.timestamp),
          "severity": verticalHazard["severity"] as? String == "urgent" ? "critical" : "warning",
          "direction": ["bearing": verticalHazard["direction"] as? String ?? "ahead", "yawDegrees": verticalHazard["bearingDegrees"] as? Double ?? 0],
          "distanceMeters": verticalHazard["distanceMeters"] as? Double ?? 0,
          "message": verticalHazard["message"] as? String ?? "Hazard ahead."
        ])
      } else {
        let corridor = snapshot["corridor"] as? [String: Any]
        let receding = corridor?["recedingObstacle"] as? Bool ?? false
        let obstacles = (snapshot["obstacles"] as? [[String: Any]] ?? []).filter { ($0["nearestDistanceMeters"] as? Double ?? .infinity) <= settings.warningDistance }
        if let obstacle = obstacles.min(by: { ($0["nearestDistanceMeters"] as? Double ?? .infinity) < ($1["nearestDistanceMeters"] as? Double ?? .infinity) }),
          let distance = obstacle["nearestDistanceMeters"] as? Double {
          // Suppress non-urgent static nag when the object ahead is actively moving away from the user.
          if !receding || distance <= settings.criticalDistance {
            var warning: [String: Any] = [
              "timestampMs": frameClock.unixMilliseconds(for: frame.timestamp),
              "severity": distance <= settings.criticalDistance ? "critical" : "warning",
              "sector": obstacle["sector"] as? String ?? "unknown", "direction": obstacle["direction"] as? [String: Any] ?? [:],
              "distanceMeters": distance, "robustDistanceMeters": obstacle["robustDistanceMeters"] as? Double ?? distance,
              "confidence": obstacle["meanConfidence"] as? Double ?? 0, "obstacle": obstacle
            ]
            if let objects = snapshot["objects"] as? [[String: Any]],
              let label = LiveObstacleIdentity.label(obstacle: obstacle, objects: objects) {
              warning["label"] = label
            }
            emit?("onWarning", warning)
          }
        }
      }
    }
    if allowVision { schedulePeople(frame) }
  }

  private func makeSnapshot(frame: ARFrame, mode: String, ocr: [[String: Any]], image: [String: Any]?, sampledAt: TimeInterval, sameFramePersonScan: Bool = false) -> [String: Any] {
    let cameraTimestamp = frameClock.unixMilliseconds(for: frame.timestamp)
    let age = PerceptionFrameClock.ageMilliseconds(of: frame.timestamp, at: sampledAt)
    let stale = !PerceptionFrameClock.isFresh(age, maximum: settings.maximumFrameAgeMs)
    let trackingReady = isNormalTracking(frame.camera.trackingState)
    let analysis = Geometry.analyze(depth: stale || !trackingReady ? nil : frame.sceneDepth, camera: frame.camera, orientation: imageOrientation, settings: settings)
    let depthSupported = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    var depthState = "unavailable"
    var healthIssues: [String] = []
    if stale { depthState = "stale"; healthIssues.append("The camera frame is outside the freshness window.") }
    else if !depthSupported { depthState = "unsupported"; healthIssues.append("ARKit scene depth is unsupported on this device.") }
    else if !trackingReady { depthState = "unavailable" }
    else if frame.sceneDepth != nil && !analysis.aligned { depthState = "misaligned"; healthIssues.append("Camera and depth image aspect ratios do not align.") }
    else if analysis.valid { depthState = "available" }
    else { healthIssues.append(frame.sceneDepth == nil ? "No scene-depth frame is available yet." : "Depth confidence is too low for proximity measurements.") }
    if !trackingReady { healthIssues.append(trackingReason(frame.camera.trackingState) ?? "Camera tracking is limited.") }
    let depthTimestamp: Any
    let depthAge: Any
    if frame.sceneDepth == nil {
      depthTimestamp = NSNull()
      depthAge = NSNull()
    } else {
      depthTimestamp = cameraTimestamp
      depthAge = max(0, age)
    }
    let sensorHealth: [String: Any] = [
      "cameraAuthorized": AVCaptureDevice.authorizationStatus(for: .video) == .authorized,
      "depthSupported": depthSupported, "cameraTimestampMs": cameraTimestamp,
      "depthTimestampMs": depthTimestamp, "cameraDepthDeltaMs": 0,
      "frameAgeMs": max(0, age), "depthAgeMs": depthAge,
      "alignment": frame.sceneDepth == nil ? "unavailable" : (analysis.aligned ? "aligned" : "aspect-mismatch"),
      "fresh": !stale && depthState == "available", "issues": healthIssues
    ]
    let freshGeometry = depthState == "available" && trackingReady
    var objects = freshGeometry ? meshes.objects(frame: frame, timestamp: cameraTimestamp, orientation: imageOrientation, settings: settings) : []
    let visionAge = lastPersonScanFrameTime.map { frame.timestamp - $0 }
    let peopleAreCurrent = visionAge.map { (0...2.5).contains($0) } ?? false
    let visionDepthFresh = visionAge.map { (0...0.85).contains($0) } ?? false
    let people = peopleAreCurrent ? latestPeople : []
    let animals = peopleAreCurrent ? latestAnimals : []
    if !stale && trackingReady {
      for entity in people + animals {
        if freshGeometry && (lastPersonScanFrameTime == frame.timestamp || visionDepthFresh) {
          objects.append(entity)
        } else {
          var copy = entity
          for key in ["distanceMeters", "robustDistanceMeters", "steps", "nearestPoint", "depthTimestampMs", "direction"] { copy.removeValue(forKey: key) }
          objects.append(copy)
        }
      }
    }
    let validOCR = depthState == "available" ? ocr : ocr.map { observation in
      var copy = observation
      copy.removeValue(forKey: "distanceMeters")
      return copy
    }
    let seats = sameFramePersonScan ? seatCandidates(objects: objects, people: people, frame: frame) : []
    var corridorDict: [String: Any]?
    var hazardsList: [[String: Any]] = []
    let pitchDegrees = CorridorAnalyzer.cameraPitchDegrees(transform: frame.camera.transform)
    var aimState = CorridorAnalyzer.aimState(pitchDegrees: pitchDegrees)
    let headingDegrees = headingAligned && trackingReady ? CorridorAnalyzer.cameraHeadingDegrees(transform: frame.camera.transform) : nil
    if freshGeometry, let depth = frame.sceneDepth,
      let map = DepthMap(depth: depth.depthMap, confidence: depth.confidenceMap, imageSize: frame.camera.imageResolution),
      let rawCorridor = map.read({ samples in
        CorridorAnalyzer.analyze(
          samples: samples,
          intrinsics: frame.camera.intrinsics,
          imageSize: frame.camera.imageResolution,
          cameraTransform: frame.camera.transform,
          headingAligned: self.headingAligned,
          knownFloorY: self.detectedFloorY,
          warningDistance: self.settings.warningDistance,
          criticalDistance: self.settings.criticalDistance
        )
      }) {
      let approach = approachTracker.update(
        timestamp: frame.timestamp,
        cameraTransform: frame.camera.transform,
        sectors: rawCorridor.sectors,
        aimState: rawCorridor.aimState
      )
      let corridor = rawCorridor.applying(approach: approach)
      aimState = corridor.aimState
      corridorDict = corridor.toDictionary()
      hazardsList = corridor.hazardDictionaries(timestampMs: cameraTimestamp)
    } else if aimState == "lowered" || !freshGeometry {
      approachTracker.reset()
    }
    var snapshot: [String: Any] = [
      "id": UUID().uuidString, "source": "arkit", "mode": mode,
      "cameraTimestampMs": cameraTimestamp,
      "depthTimestampMs": depthTimestamp,
      "capturedAtMs": Date().timeIntervalSince1970 * 1000,
      "trackingState": tracking(frame.camera.trackingState),
      "trackingReason": Geometry.nullable(trackingReason(frame.camera.trackingState)),
      "depthState": depthState, "confidence": freshGeometry ? analysis.confidence : 0,
      "sensorHealth": sensorHealth, "obstacles": freshGeometry ? analysis.obstacles : [],
      "objects": objects, "freeSeats": seats, "ocr": validOCR,
      "aimState": aimState, "pitchDegrees": pitchDegrees, "hazards": hazardsList
    ]
    if let headingDegrees { snapshot["headingDegrees"] = headingDegrees }
    if let corridorDict { snapshot["corridor"] = corridorDict }
    if let image { snapshot["image"] = image }
    return snapshot
  }

  private func seatCandidates(objects: [[String: Any]], people: [[String: Any]], frame: ARFrame) -> [[String: Any]] {
    objects.filter { $0["label"] as? String == "seat" }.map { seat in
      let id = seat["id"] as? String ?? UUID().uuidString
      var evidence: [[String: Any]] = []
      var occupancy = "unknown"
      if let seatBounds = seat["bounds"] as? [String: Double], let seatDistance = seat["distanceMeters"] as? Double,
        let center = seat["center"] as? [String: Double], let x = center["x"], let y = center["y"], let z = center["z"],
        Geometry.depthConfirms(cameraPoint: SIMD3(x, y, z), frame: frame) {
        var occluded = false
        for person in people {
          guard let personBounds = person["bounds"] as? [String: Double], boundsOverlap(seatBounds, personBounds) else { continue }
          if let personDistance = person["distanceMeters"] as? Double {
            if abs(seatDistance - personDistance) < 0.6 {
              occupancy = "occupied"
            } else if personDistance < seatDistance {
              occluded = true
            }
          } else {
            occluded = true
          }
          if occupancy == "occupied" {
            evidence.append(["kind": "person-overlap", "detail": "A detected person overlaps the seat direction and measured depth.", "objectId": person["id"] as? String ?? "person"])
            break
          }
        }
        if occupancy != "occupied" && occluded {
          evidence.append(["kind": "seat-occluded", "detail": "A person may be blocking the camera's view of the seat."])
        } else if occupancy != "occupied" {
          occupancy = "free"
          evidence.append(["kind": "no-person-overlap", "detail": "The camera frame showed no person overlapping this seat."])
        }
      } else {
        evidence.append(["kind": "seat-depth-unconfirmed", "detail": "The current depth readings do not confirm this seat's position."])
      }
      var candidate: [String: Any] = [
        "id": "candidate-\(id)", "objectId": id, "occupancy": occupancy,
        "confidence": seat["confidence"] as? Double ?? 0, "direction": seat["direction"] as? [String: Any] ?? [:],
        "distanceMeters": Geometry.nullable(seat["distanceMeters"]),
        "center": seat["center"] as? [String: Any] ?? [:], "sizeMeters": seat["sizeMeters"] as? [String: Any] ?? [:],
        "evidence": evidence
      ]
      if let steps = seat["steps"] { candidate["steps"] = steps }
      return candidate
    }
  }

  private func boundsOverlap(_ first: [String: Double], _ second: [String: Double]) -> Bool {
    guard let aX = first["x"], let aY = first["y"], let aW = first["width"], let aH = first["height"],
      let bX = second["x"], let bY = second["y"], let bW = second["width"], let bH = second["height"] else { return false }
    return aX < bX + bW && bX < aX + aW && aY < bY + bH && bY < aY + aH
  }

  private func schedulePeople(_ frame: ARFrame) {
    guard settings.detectPeople, !personTaskRunning, isNormalTracking(frame.camera.trackingState) else { return }
    let pitch = CorridorAnalyzer.cameraPitchDegrees(transform: frame.camera.transform)
    guard pitch >= -58.0 else { return }
    let now = ProcessInfo.processInfo.systemUptime
    guard now - lastPersonRequestUptime >= 0.55 else { return }
    lastPersonRequestUptime = now
    personTaskRunning = true
    let generation = captureGeneration
    let timestamp = frameClock.unixMilliseconds(for: frame.timestamp)
    let orientation = imageOrientation
    let settings = self.settings
    visionQueue.async {
      do {
        let detected = try PerceptionVision.peopleAndAnimals(frame: frame, orientation: orientation, timestamp: timestamp, settings: settings)
        self.processingQueue.async {
          guard self.active, generation == self.captureGeneration else { return }
          self.personTaskRunning = false
          self.updateVisionEntities(people: detected.people, animals: detected.animals, frameTime: frame.timestamp)
        }
      } catch {
        self.processingQueue.async {
          guard self.active, generation == self.captureGeneration else { return }
          self.personTaskRunning = false
          self.report("E_VISION", "On-device person and animal detection failed: \(error.localizedDescription)", recoverable: true)
        }
      }
    }
  }

  private func updateVisionEntities(people: [[String: Any]], animals: [[String: Any]], frameTime: Double) {
    latestPeople = trackEntities(people, previous: latestPeople, prefix: "person", sequence: &personSequence)
    latestAnimals = trackEntities(animals, previous: latestAnimals, prefix: "animal", sequence: &animalSequence)
    lastPersonScanFrameTime = frameTime
  }

  private func trackEntities(_ incoming: [[String: Any]], previous: [[String: Any]], prefix: String, sequence: inout Int) -> [[String: Any]] {
    var used: Set<String> = []
    return incoming.map { input in
      var object = input
      let bounds = object["bounds"] as? [String: Double]
      var identifier: String?
      if let bounds {
        let x = bounds["x"]! + bounds["width"]! / 2
        let y = bounds["y"]! + bounds["height"]! / 2
        var best: (distance: Double, id: String)?
        for old in previous {
          guard let oldId = old["id"] as? String, !used.contains(oldId), let oldBounds = old["bounds"] as? [String: Double] else { continue }
          let ox = oldBounds["x"]! + oldBounds["width"]! / 2
          let oy = oldBounds["y"]! + oldBounds["height"]! / 2
          let distance = hypot(x - ox, y - oy)
          if distance < 0.18, best == nil || distance < best!.distance { best = (distance, oldId) }
        }
        identifier = best?.id
      }
      if let identifier { used.insert(identifier) }
      else { sequence += 1; identifier = "\(prefix)-\(sequence)" }
      object["id"] = identifier
      object["trackingState"] = "normal"
      return object
    }
  }

  private func reportingStatus(tracking: String, reason: String) {
    var snapshot = latestSnapshot ?? [:]
    snapshot["trackingState"] = tracking
    snapshot["trackingReason"] = reason
    emit?("onStatus", status(snapshot))
  }

  func currentStatus() -> [String: Any] {
    processingQueue.sync {
      let nativeDepth = latestSnapshot?["depthState"] as? String ?? "unavailable"
      let depthState = nativeDepth == "available" ? "ready" : (nativeDepth == "stale" ? "stale" : (nativeDepth == "misaligned" ? "limited" : "unavailable"))
      var imageAvailable = false
      if !captureInProgress, let uri = latestCaptureURI, let url = URL(string: uri) {
        imageAvailable = FileManager.default.fileExists(atPath: url.path)
      }
      var result: [String: Any] = [
        "state": active ? (nativeDepth == "available" ? "active" : "degraded") : "idle",
        "active": active, "capturing": captureInProgress,
        "trackingReady": latestSnapshot?["trackingState"] as? String == "normal" && nativeDepth != "stale",
        "depthState": depthState, "imageAvailable": imageAvailable
      ]
      if let observedAt = latestSnapshot?["cameraTimestampMs"] as? Double { result["observedAt"] = observedAt }
      if let lastCaptureAt { result["lastCaptureAt"] = lastCaptureAt }
      if let snapshot = latestSnapshot, let message = PerceptionContract.statusMessage(status(snapshot)) { result["message"] = message }
      else if !active { result["message"] = "Perception session is not active." }
      return result
    }
  }

  private func status(_ snapshot: [String: Any]) -> [String: Any] {
    [
      "timestampMs": Date().timeIntervalSince1970 * 1000, "active": active,
      "trackingState": snapshot["trackingState"] as? String ?? "notAvailable",
      "trackingReason": Geometry.nullable(snapshot["trackingReason"]),
      "depthState": snapshot["depthState"] as? String ?? "unavailable",
      "sensorHealth": snapshot["sensorHealth"] as? [String: Any] ?? [:]
    ]
  }

  private func cameraPermission() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    @unknown default: return "unknown"
    }
  }

  private func report(_ code: String, _ message: String, recoverable: Bool) {
    emit?("onError", ["timestampMs": Date().timeIntervalSince1970 * 1000, "code": code, "message": message, "recoverable": recoverable])
  }
}
