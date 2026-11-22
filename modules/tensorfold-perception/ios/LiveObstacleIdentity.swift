import Foundation

enum LiveObstacleIdentity {
  private static let labels = ["seat", "table", "door", "wall", "window"]

  static func label(obstacle: [String: Any], objects: [[String: Any]]) -> String? {
    guard let sector = bounds(obstacle), let distance = obstacle["nearestDistanceMeters"] as? Double,
      distance.isFinite, distance > 0, let spread = obstacle["spreadMeters"] as? Double,
      let confidence = obstacle["meanConfidence"] as? Double, confidence >= 0.65 else { return nil }
    let tolerance = min(0.25, max(0.15, distance * 0.15))
    guard spread >= 0, spread <= tolerance * 2 else { return nil }
    let matches = objects.compactMap { object -> String? in
      guard object["source"] as? String == "arkit-mesh-classification",
        let label = object["label"] as? String, labels.contains(label),
        let support = object["confidence"] as? Double, support >= 0.65,
        let center = object["center"] as? [String: Double], let depth = center["z"],
        abs(depth - distance) <= tolerance,
        let box = bounds(object), box.contains(CGPoint(x: sector.midX, y: sector.midY)) else { return nil }
      let overlap = sector.intersection(box)
      guard overlap.width * overlap.height >= sector.width * sector.height * 0.45 else { return nil }
      return label
    }
    // Adjacent mesh fragments can agree. Any competing label keeps the warning generic.
    let distinctLabels = Set(matches)
    return distinctLabels.count == 1 ? distinctLabels.first : nil
  }

  private static func bounds(_ item: [String: Any]) -> CGRect? {
    guard let box = item["bounds"] as? [String: Double],
      let x = box["x"], let y = box["y"], let width = box["width"], let height = box["height"],
      [x, y, width, height].allSatisfy(\.isFinite), width > 0, height > 0 else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
  }
}
