import ARKit
import AVFoundation
import Foundation

final class PerceptionController: NSObject, ARSessionDelegate {
  private let session = ARSession()
  private let processingQueue = DispatchQueue(label: "tensorfold.perception.processing", qos: .userInitiated)
  private let visionQueue = DispatchQueue(label: "tensorfold.perception.vision", qos: .userInitiated)
  private var settings = try! PerceptionSettings(nil)
  private let meshes = MeshStore()
  private var active = false
  private var latestSnapshot: [String: Any]?
  private var latestPeople: [[String: Any]] = []
  private var lastPersonScanTimestampMs: Double?
  private var personTaskRunning = false
  private var lastPersonRequestUptime = 0.0
  private var personSequence = 0
  private var lastEmissionUptime = 0.0
  private var captureInProgress = false
  private var latestCaptureURI: String?
  private var lastCaptureAt: Double?
  private var staleTimer: DispatchSourceTimer?
  var emit: ((String, [String: Any]) -> Void)?

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
    do { settings = try PerceptionSettings(options) }
    catch let error as PerceptionError { completion(.failure(error)); return }
    catch { completion(.failure(PerceptionError("E_OPTIONS", "The perception settings are invalid."))); return }
    guard ARWorldTrackingConfiguration.isSupported else {
      completion(.failure(PerceptionError("E_AR_UNSUPPORTED", "ARKit world tracking is unavailable on this device."))); return
    }
    let begin = { [weak self] in
      guard let self else { return }
      DispatchQueue.main.async {
        if self.active { self.stopInternal() }
        let configuration = ARWorldTrackingConfiguration()
        configuration.planeDetection = [.horizontal, .vertical]
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
          configuration.frameSemantics.insert(.sceneDepth)
        }
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification) {
          configuration.sceneReconstruction = .meshWithClassification
        }
        self.session.delegateQueue = self.processingQueue
        self.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
        self.processingQueue.async {
          self.active = true
          self.latestSnapshot = nil
          self.latestPeople = []
          self.lastPersonScanTimestampMs = nil
          self.meshes.clear()
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
      staleTimer?.cancel()
      staleTimer = nil
      latestSnapshot = nil
      latestPeople = []
      captureInProgress = false
      latestCaptureURI = nil
      lastCaptureAt = nil
      PerceptionVision.pruneCaptures(directory: captureDirectory)
      meshes.clear()
    }
  }

  private func startStaleTimer() {
    staleTimer?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: processingQueue)
    timer.schedule(deadline: .now() + .milliseconds(500), repeating: .milliseconds(500))
    timer.setEventHandler { [weak self] in
      guard let self, self.active, let frame = self.session.currentFrame else { return }
      let age = (ProcessInfo.processInfo.systemUptime - frame.timestamp) * 1000
      if age > self.settings.maximumFrameAgeMs { self.process(frame: frame, allowVision: false, force: true) }
    }
    staleTimer = timer
    timer.resume()
  }

  func capture(options: [String: Any]?, completion: @escaping (Result<[String: Any], PerceptionError>) -> Void) {
    guard active, let frame = session.currentFrame else {
      completion(.failure(PerceptionError("E_NO_FRAME", "Start a perception session and wait for a camera frame."))); return
    }
    let age = (ProcessInfo.processInfo.systemUptime - frame.timestamp) * 1000
    guard age <= settings.maximumFrameAgeMs else {
      completion(.failure(PerceptionError("E_STALE_FRAME", "The latest camera frame is stale. Wait for fresh tracking before capturing."))); return
    }
    let includeImage = options?["includeImage"] as? Bool ?? true
    let detectPeople = options?["detectPeople"] as? Bool ?? settings.detectPeople
    let recognizeText = options?["recognizeText"] as? Bool ?? settings.recognizeText
    let quality = options?["jpegQuality"] as? Double ?? 0.85
    captureInProgress = true
    visionQueue.async {
      var people: [[String: Any]] = []
      var text: [[String: Any]] = []
      var captureError: PerceptionError?
      var personScanSucceeded = true
      if detectPeople {
        do { people = try PerceptionVision.people(frame: frame, settings: self.settings) }
        catch {
          personScanSucceeded = false
          self.report("E_VISION", "Person detection failed for this capture: \(error.localizedDescription)", recoverable: true)
        }
      }
      if recognizeText {
        do { text = try PerceptionVision.text(frame: frame, settings: self.settings) }
        catch { self.report("E_OCR", "On-device text recognition failed: \(error.localizedDescription)", recoverable: true) }
      }
      var image: [String: Any]?
      if includeImage {
        do { image = try PerceptionVision.writeJPEG(frame: frame, quality: quality) }
        catch let error as PerceptionError { captureError = error }
        catch { captureError = PerceptionError("E_CAPTURE", "JPEG capture failed: \(error.localizedDescription)") }
      }
      self.processingQueue.async {
        guard self.active else {
          self.captureInProgress = false
          PerceptionVision.pruneCaptures(directory: self.captureDirectory)
          completion(.failure(PerceptionError("E_SESSION_INACTIVE", "The perception session stopped during capture.")))
          return
        }
        if detectPeople, personScanSucceeded { self.updatePeople(people, timestamp: Geometry.timestamp(frame.timestamp)) }
        let snapshot = self.makeSnapshot(frame: frame, mode: "capture", ocr: text, image: image)
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
        self.lastCaptureAt = Geometry.timestamp(frame.timestamp)
        if image == nil { PerceptionVision.pruneCaptures(directory: self.captureDirectory) }
        self.latestSnapshot = snapshot
        self.emit?("onSnapshot", snapshot)
        completion(.success(snapshot))
      }
    }
  }

  func release(_ uri: String) -> [String: Any] {
    processingQueue.sync {
      let released = PerceptionVision.releaseCapture(uri, directory: captureDirectory)
      if released && latestCaptureURI == uri { latestCaptureURI = nil }
      return ["released": released]
    }
  }

  func session(_ session: ARSession, didUpdate frame: ARFrame) { process(frame: frame, allowVision: true, force: false) }

  func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
    for case let anchor as ARMeshAnchor in anchors { meshes.update(anchor) }
  }

  func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
    for case let anchor as ARMeshAnchor in anchors { meshes.update(anchor) }
  }

  func session(_ session: ARSession, didRemove anchors: [ARAnchor]) { meshes.remove(anchors) }

  func session(_ session: ARSession, didFailWithError error: Error) {
    report("E_AR_SESSION", "ARKit stopped the perception session: \(error.localizedDescription)", recoverable: true)
  }

  func sessionWasInterrupted(_ session: ARSession) {
    reportingStatus(tracking: "paused", reason: "The camera session was interrupted by the system.")
  }

  func sessionInterruptionEnded(_ session: ARSession) {
    reportingStatus(tracking: "limited", reason: "Camera tracking is resuming after an interruption.")
  }

  private func process(frame: ARFrame, allowVision: Bool, force: Bool) {
    guard active else { return }
    let now = ProcessInfo.processInfo.systemUptime
    guard force || (now - lastEmissionUptime) * 1000 >= settings.proximityIntervalMs else {
      if allowVision { schedulePeople(frame) }
      return
    }
    lastEmissionUptime = now
    let snapshot = makeSnapshot(frame: frame, mode: "proximity", ocr: [], image: nil)
    latestSnapshot = snapshot
    emit?("onSnapshot", snapshot)
    emit?("onStatus", status(snapshot))
    if snapshot["depthState"] as? String == "available", isNormalTracking(frame.camera.trackingState) {
      let obstacles = (snapshot["obstacles"] as? [[String: Any]] ?? []).filter { ($0["nearestDistanceMeters"] as? Double ?? .infinity) <= settings.warningDistance }
      for obstacle in obstacles {
        let distance = obstacle["nearestDistanceMeters"] as? Double ?? .infinity
        let warning: [String: Any] = [
          "timestampMs": Date().timeIntervalSince1970 * 1000, "snapshotId": snapshot["id"] as? String ?? UUID().uuidString,
          "severity": distance <= settings.criticalDistance ? "critical" : "warning",
          "sector": obstacle["sector"] as? String ?? "unknown", "direction": obstacle["direction"] as? [String: Any] ?? [:],
          "distanceMeters": distance, "robustDistanceMeters": obstacle["robustDistanceMeters"] as? Double ?? distance,
          "confidence": obstacle["meanConfidence"] as? Double ?? 0, "obstacle": obstacle
        ]
        emit?("onWarning", warning)
      }
    }
    if allowVision { schedulePeople(frame) }
  }

  private func makeSnapshot(frame: ARFrame, mode: String, ocr: [[String: Any]], image: [String: Any]?) -> [String: Any] {
    let cameraTimestamp = Geometry.timestamp(frame.timestamp)
    let age = Date().timeIntervalSince1970 * 1000 - cameraTimestamp
    let analysis = Geometry.analyze(depth: frame.sceneDepth, camera: frame.camera, timestampMs: cameraTimestamp, settings: settings)
    let depthSupported = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    let stale = age > settings.maximumFrameAgeMs || age < -100
    var depthState = "unavailable"
    var healthIssues: [String] = []
    if !depthSupported { depthState = "unsupported"; healthIssues.append("ARKit scene depth is unsupported on this device.") }
    else if stale { depthState = "stale"; healthIssues.append("The camera frame is outside the freshness window.") }
    else if frame.sceneDepth != nil && !analysis.aligned { depthState = "misaligned"; healthIssues.append("Camera and depth image aspect ratios do not align.") }
    else if analysis.valid { depthState = "available" }
    else { healthIssues.append(frame.sceneDepth == nil ? "No scene-depth frame is available yet." : "Depth confidence is too low for proximity measurements.") }
    if !isNormalTracking(frame.camera.trackingState) { healthIssues.append(trackingReason(frame.camera.trackingState) ?? "Camera tracking is limited.") }
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
    let freshGeometry = depthState == "available" && isNormalTracking(frame.camera.trackingState)
    var objects = freshGeometry ? meshes.objects(frame: frame, settings: settings) : []
    let personCutoff = cameraTimestamp - 2500
    let people = latestPeople.filter { ($0["cameraTimestampMs"] as? Double ?? 0) >= personCutoff }
    if !stale && isNormalTracking(frame.camera.trackingState) {
      objects.append(contentsOf: people.map { person in
        if depthState == "available" { return person }
        var copy = person
        for key in ["distanceMeters", "robustDistanceMeters", "steps", "nearestPoint", "depthTimestampMs"] { copy.removeValue(forKey: key) }
        return copy
      })
    }
    let validOCR = depthState == "available" ? ocr : ocr.map { observation in
      var copy = observation
      copy.removeValue(forKey: "distanceMeters")
      return copy
    }
    let seats = seatCandidates(objects: objects, people: people, timestamp: cameraTimestamp, depthState: depthState)
    var snapshot: [String: Any] = [
      "id": UUID().uuidString, "source": "arkit", "mode": mode,
      "cameraTimestampMs": cameraTimestamp,
      "depthTimestampMs": depthTimestamp,
      "capturedAtMs": Date().timeIntervalSince1970 * 1000,
      "trackingState": tracking(frame.camera.trackingState),
      "trackingReason": Geometry.nullable(trackingReason(frame.camera.trackingState)),
      "depthState": depthState, "confidence": freshGeometry ? analysis.confidence : 0,
      "sensorHealth": sensorHealth, "obstacles": freshGeometry ? analysis.obstacles : [],
      "objects": objects, "freeSeats": seats, "ocr": validOCR
    ]
    if let image { snapshot["image"] = image }
    return snapshot
  }

  private func seatCandidates(objects: [[String: Any]], people: [[String: Any]], timestamp: Double, depthState: String) -> [[String: Any]] {
    objects.filter { $0["label"] as? String == "seat" }.map { seat in
      let id = seat["id"] as? String ?? UUID().uuidString
      var evidence: [[String: Any]] = []
      var occupancy = "unknown"
      if depthState != "available" {
        evidence.append(["kind": "stale-depth", "detail": "Seat geometry is not backed by a fresh depth frame."])
      } else if !settings.detectPeople {
        evidence.append(["kind": "person-scan-unavailable", "detail": "Person detection is disabled, so seat occupancy is unknown."])
      } else if let scan = lastPersonScanTimestampMs, timestamp - scan <= 2500 {
        var overlapped = false
        for person in people {
          guard let seatBounds = seat["bounds"] as? [String: Double], let personBounds = person["bounds"] as? [String: Double],
            let seatDistance = seat["distanceMeters"] as? Double, let personDistance = person["distanceMeters"] as? Double else { continue }
          let seatLeft = seatBounds["x"]!, seatRight = seatLeft + seatBounds["width"]!
          let personLeft = personBounds["x"]!, personRight = personLeft + personBounds["width"]!
          let overlap = max(0, min(seatRight, personRight) - max(seatLeft, personLeft))
          if overlap > 0 && abs(seatDistance - personDistance) < 1.0 {
            overlapped = true
            evidence.append(["kind": "person-overlap", "detail": "A detected person overlaps the seat direction and measured depth.", "objectId": person["id"] as? String ?? "person"])
          }
        }
        if overlapped { occupancy = "occupied" }
        else {
          occupancy = "free"
          evidence.append(["kind": "no-person-overlap", "detail": "The latest person scan found no person overlapping this seat's direction and depth."])
        }
      } else {
        evidence.append(["kind": "stale-person-scan", "detail": "No recent person scan is available for occupancy evidence."])
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

  private func schedulePeople(_ frame: ARFrame) {
    guard settings.detectPeople, !personTaskRunning, isNormalTracking(frame.camera.trackingState) else { return }
    let now = ProcessInfo.processInfo.systemUptime
    guard now - lastPersonRequestUptime >= 1 else { return }
    lastPersonRequestUptime = now
    personTaskRunning = true
    visionQueue.async {
      do {
        let people = try PerceptionVision.people(frame: frame, settings: self.settings)
        self.processingQueue.async {
          self.personTaskRunning = false
          if self.active { self.updatePeople(people, timestamp: Geometry.timestamp(frame.timestamp)) }
        }
      } catch {
        self.processingQueue.async { self.personTaskRunning = false }
        self.report("E_VISION", "On-device person detection failed: \(error.localizedDescription)", recoverable: true)
      }
    }
  }

  private func updatePeople(_ people: [[String: Any]], timestamp: Double) {
    var previous = latestPeople
    var used: Set<String> = []
    latestPeople = people.map { input in
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
      else { personSequence += 1; identifier = "person-\(personSequence)" }
      object["id"] = identifier
      object["trackingState"] = "normal"
      return object
    }
    previous.removeAll()
    lastPersonScanTimestampMs = timestamp
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
