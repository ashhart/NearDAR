import Foundation

enum PerceptionContract {
  private static let sequenceLock = NSLock()
  private static var sequence = 0

  private static func nextSequence() -> Int {
    sequenceLock.lock()
    defer { sequenceLock.unlock() }
    sequence += 1
    return sequence
  }

  static func snapshot(_ native: [String: Any]) -> [String: Any] {
    let snapshotId = native["id"] as? String ?? UUID().uuidString
    let nativeDepth = native["depthState"] as? String ?? "unavailable"
    let depthState: String
    switch nativeDepth {
    case "available": depthState = "ready"
    case "stale": depthState = "stale"
    case "misaligned": depthState = "limited"
    default: depthState = "unavailable"
    }
    let obstacles = native["obstacles"] as? [[String: Any]] ?? []
    let nativeObjects = native["objects"] as? [[String: Any]] ?? []
    var objects: [[String: Any]] = []
    for obstacle in obstacles {
      let sector = obstacle["sector"] as? String ?? "unknown"
      let confidence = obstacle["meanConfidence"] as? Double ?? 0
      let validFraction = obstacle["validPixelFraction"] as? Double ?? 0
      objects.append(object(
        id: "\(snapshotId)-\(sector)", label: "obstacle", confidence: confidence,
        direction: direction(obstacle["direction"] as? [String: Any]),
        clock: clock(obstacle["direction"] as? [String: Any]),
        distance: obstacle["robustDistanceMeters"] as? Double ?? obstacle["nearestDistanceMeters"] as? Double,
        steps: stepCount(obstacle),
        evidence: ["Measured raw-depth sector \(sector) with \(Int((validFraction * 100).rounded())) percent valid pixels."]
      ))
    }
    for nativeObject in nativeObjects {
      guard let id = nativeObject["id"] as? String, let label = nativeObject["label"] as? String else { continue }
      let source = nativeObject["source"] as? String ?? "native-detector"
      objects.append(object(
        id: id, label: label, confidence: nativeObject["confidence"] as? Double ?? 0,
        direction: direction(nativeObject["direction"] as? [String: Any]),
        clock: clock(nativeObject["direction"] as? [String: Any]),
        distance: nativeObject["distanceMeters"] as? Double,
        steps: stepCount(nativeObject),
        evidence: ["Geometry supplied by \(source), with timestamped confidence \(nativeObject["confidence"] as? Double ?? 0)."]
      ))
    }
    var freeSeats: [[String: Any]] = []
    let candidates = native["freeSeats"] as? [[String: Any]] ?? []
    let seatObjects = Dictionary(uniqueKeysWithValues: nativeObjects.compactMap { object -> (String, [String: Any])? in
      guard let id = object["id"] as? String else { return nil }
      return (id, object)
    })
    for candidate in candidates where candidate["occupancy"] as? String == "free" {
      guard let id = candidate["objectId"] as? String else { continue }
      let seat = seatObjects[id]
      let evidence = (candidate["evidence"] as? [[String: Any]] ?? []).compactMap { $0["detail"] as? String }
      let geometryConfidence = candidate["confidence"] as? Double ?? 0
      var seatObject = object(
        id: candidate["id"] as? String ?? "candidate-\(id)", label: "seat", confidence: geometryConfidence,
        direction: direction(candidate["direction"] as? [String: Any]),
        clock: clock(candidate["direction"] as? [String: Any]),
        distance: candidate["distanceMeters"] as? Double,
        steps: stepCount(seat ?? [:]), evidence: evidence
      )
      seatObject["free"] = true
      // No-person-overlap is conservative evidence, not a guarantee that a chair is empty.
      seatObject["occupancyConfidence"] = min(0.5, geometryConfidence)
      seatObject["occupied"] = false
      freeSeats.append(seatObject)
    }
    let health = native["sensorHealth"] as? [String: Any] ?? [:]
    var notes = health["issues"] as? [String] ?? []
    if let reason = native["trackingReason"] as? String { notes.append(reason) }
    if native["source"] as? String == "arcore" {
      notes.append("Named chair and person detection is unavailable in this ARCore adapter. Generic depth obstacles and captured image evidence remain available.")
    }
    let nativeOCR = native["ocr"] as? [[String: Any]] ?? []
    let recognizedText = nativeOCR.compactMap { observation -> String? in
      guard let text = observation["text"] as? String, !text.isEmpty else { return nil }
      return text
    }
    let validDepthFraction = obstacles.reduce(0.0) { $0 + ($1["validPixelFraction"] as? Double ?? 0) } / 15
    let trackingReady = native["trackingState"] as? String == "normal" && nativeDepth != "stale"
    var result: [String: Any] = [
      "observedAt": native["cameraTimestampMs"] as? Double ?? native["capturedAtMs"] as? Double ?? Date().timeIntervalSince1970 * 1000,
      "sequence": nextSequence(), "trackingReady": trackingReady, "depthState": depthState,
      "validDepthFraction": validDepthFraction, "cameraOrientation": "camera-forward",
      "objects": objects, "freeSeats": freeSeats, "recognizedText": recognizedText, "notes": notes
    ]
    if let image = native["image"] as? [String: Any], let uri = image["uri"] as? String {
      result["temporaryImagePath"] = uri
      result["imageWidth"] = image["width"]
      result["imageHeight"] = image["height"]
    }
    return result
  }

  static func warning(_ native: [String: Any]) -> [String: Any] {
    let obstacle = native["obstacle"] as? [String: Any] ?? [:]
    let heading = direction(native["direction"] as? [String: Any])
    let distance = native["distanceMeters"] as? Double
    let measurement: String
    if let steps = stepCount(obstacle) { measurement = "about \(Int(steps.rounded())) calibrated steps" }
    else if let distance { measurement = "about \(String(format: "%.1f", max(0.1, distance))) metres" }
    else { measurement = "distance unavailable" }
    var result: [String: Any] = [
      "id": "\(native["snapshotId"] as? String ?? UUID().uuidString)-\(native["sector"] as? String ?? "obstacle")",
      "kind": "obstacle", "severity": native["severity"] as? String == "critical" ? "urgent" : "caution",
      "message": "Obstacle \(heading.replacingOccurrences(of: "-", with: " ")), \(measurement).",
      "observedAt": native["timestampMs"] as? Double ?? Date().timeIntervalSince1970 * 1000,
      "direction": heading
    ]
    if let distance { result["distanceMeters"] = distance }
    return result
  }

  static func statusMessage(_ status: [String: Any]) -> String? {
    if let reason = status["trackingReason"] as? String { return reason }
    let health = status["sensorHealth"] as? [String: Any] ?? [:]
    let issues = health["issues"] as? [String] ?? []
    return issues.isEmpty ? nil : issues.joined(separator: " ")
  }

  private static func object(id: String, label: String, confidence: Double, direction: String, clock: Int, distance: Double?, steps: Double?, evidence: [String]) -> [String: Any] {
    var result: [String: Any] = [
      "id": id, "label": label, "confidence": confidence, "direction": direction,
      "clockSector": clock, "evidence": evidence
    ]
    if let distance { result["distanceMeters"] = distance }
    if let steps { result["stepEstimate"] = steps }
    return result
  }

  private static func stepCount(_ native: [String: Any]) -> Double? {
    let steps = native["steps"] as? [String: Any]
    return steps?["count"] as? Double
  }

  private static func clock(_ native: [String: Any]?) -> Int { native?["clockSector"] as? Int ?? 12 }

  private static func direction(_ native: [String: Any]?) -> String {
    guard let native else { return "unknown" }
    if let yaw = native["yawDegrees"] as? Double {
      if yaw < -45 { return "left" }
      if yaw < -12 { return "ahead-left" }
      if yaw > 45 { return "right" }
      if yaw > 12 { return "ahead-right" }
      return "ahead"
    }
    switch native["bearing"] as? String {
    case "left", "upper-left", "lower-left": return "left"
    case "right", "upper-right", "lower-right": return "right"
    case "ahead", "above", "below": return "ahead"
    default: return "unknown"
    }
  }
}
