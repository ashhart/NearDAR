import ARKit
import Foundation
import ImageIO
import simd

struct MeshGeometry {
  let label: String
  let faceCount: Int
  let totalFaceCount: Int
  let center: SIMD3<Float>
  let minimum: SIMD3<Float>
  let maximum: SIMD3<Float>

  var support: Double { totalFaceCount > 0 ? Double(faceCount) / Double(totalFaceCount) : 0 }
}

final class MeshStore {
  private var classifications: [UUID: [MeshGeometry]] = [:]

  func update(_ anchor: ARMeshAnchor) {
    var byLabel: [String: (count: Int, total: Int, sum: SIMD3<Float>, min: SIMD3<Float>, max: SIMD3<Float>)] = [:]
    let geometry = anchor.geometry
    let triangles = geometry.faces
    let vertices = geometry.vertices
    guard let classifications = geometry.classification, triangles.indexCountPerPrimitive == 3,
      triangles.bytesPerIndex == 2 || triangles.bytesPerIndex == 4,
      vertices.format == .float3, vertices.stride >= MemoryLayout<Float>.size * 3,
      classifications.stride > 0, classifications.count >= triangles.count,
      triangles.count <= triangles.buffer.length / (3 * triangles.bytesPerIndex) else {
      self.classifications[anchor.identifier] = []
      return
    }
    let totalFaces = triangles.count
    let vertexBytes = geometry.vertices.buffer.contents()
    let indexBytes = triangles.buffer.contents()
    let classBytes = classifications.buffer.contents().assumingMemoryBound(to: UInt8.self)
    for face in 0..<totalFaces {
      let classOffset = classifications.offset + face * classifications.stride
      guard classOffset >= 0, classOffset < classifications.buffer.length else { continue }
      let raw = classBytes[classOffset]
      guard let classification = ARMeshClassification(rawValue: Int(raw)), let label = MeshStore.label(classification) else { continue }
      var faceVertices: [SIMD3<Float>] = []
      for corner in 0..<3 {
        let indexPosition = (face * 3 + corner) * triangles.bytesPerIndex
        let index: Int
        if triangles.bytesPerIndex == 2 {
          var value: UInt16 = 0
          memcpy(&value, indexBytes.advanced(by: indexPosition), 2)
          index = Int(value)
        } else {
          var value: UInt32 = 0
          memcpy(&value, indexBytes.advanced(by: indexPosition), 4)
          index = Int(value)
        }
        let offset = vertices.offset + index * vertices.stride
        let byteCount = MemoryLayout<Float>.size * 3
        guard index < vertices.count, offset >= 0, offset <= vertices.buffer.length - byteCount else { faceVertices = []; break }
        var value = SIMD3<Float>()
        memcpy(&value, vertexBytes.advanced(by: offset), byteCount)
        guard value.x.isFinite, value.y.isFinite, value.z.isFinite else { faceVertices = []; break }
        faceVertices.append(value)
      }
      guard faceVertices.count == 3 else { continue }
      let center = (faceVertices[0] + faceVertices[1] + faceVertices[2]) / 3
      if var current = byLabel[label] {
        current.count += 1
        current.sum += center
        current.min = simd.min(current.min, simd.min(faceVertices[0], simd.min(faceVertices[1], faceVertices[2])))
        current.max = simd.max(current.max, simd.max(faceVertices[0], simd.max(faceVertices[1], faceVertices[2])))
        byLabel[label] = current
      } else {
        let minimum = simd.min(faceVertices[0], simd.min(faceVertices[1], faceVertices[2]))
        let maximum = simd.max(faceVertices[0], simd.max(faceVertices[1], faceVertices[2]))
        byLabel[label] = (1, totalFaces, center, minimum, maximum)
      }
    }
    self.classifications[anchor.identifier] = byLabel.map { label, value in
      MeshGeometry(label: label, faceCount: value.count, totalFaceCount: totalFaces,
        center: value.sum / Float(max(1, value.count)), minimum: value.min, maximum: value.max)
    }
  }

  func remove(_ anchors: [ARAnchor]) {
    for anchor in anchors { classifications.removeValue(forKey: anchor.identifier) }
  }

  func clear() { classifications.removeAll() }

  func position(ofSeatIn anchorID: UUID, frame: ARFrame) -> SIMD3<Float>? {
    guard let seat = classifications[anchorID]?.first(where: { $0.label == "seat" && $0.faceCount >= 3 }),
      let anchor = frame.anchors.first(where: { $0.identifier == anchorID }) as? ARMeshAnchor else { return nil }
    let world = anchor.transform * SIMD4(seat.center, 1)
    return SIMD3(world.x, world.y, world.z)
  }

  func objects(frame: ARFrame, timestamp: Double, orientation: CGImagePropertyOrientation, settings: PerceptionSettings) -> [[String: Any]] {
    let meshes = frame.anchors.compactMap { $0 as? ARMeshAnchor }
    let view = frame.camera.transform.inverse
    var output: [[String: Any]] = []
    for anchor in meshes {
      guard let geometries = classifications[anchor.identifier] else { continue }
      let transform = view * anchor.transform
      for geometry in geometries where geometry.faceCount >= 3 {
        let center4 = transform * simd_float4(geometry.center, 1)
        let center = SIMD3<Double>(Double(center4.x), Double(center4.y), Double(-center4.z))
        guard center.z > 0.1 else { continue }
        var minimum = SIMD3<Double>(Double.infinity, Double.infinity, Double.infinity)
        var maximum = SIMD3<Double>(-Double.infinity, -Double.infinity, -Double.infinity)
        var projected: [(Double, Double)] = []
        for x in [geometry.minimum.x, geometry.maximum.x] {
          for y in [geometry.minimum.y, geometry.maximum.y] {
            for z in [geometry.minimum.z, geometry.maximum.z] {
              let corner4 = transform * simd_float4(SIMD3(x, y, z), 1)
              let corner = SIMD3<Double>(Double(corner4.x), Double(corner4.y), Double(-corner4.z))
              minimum = simd.min(minimum, corner)
              maximum = simd.max(maximum, corner)
              if corner.z > 0.1 {
                let pixel = Geometry.project(corner, camera: frame.camera)
                projected.append((pixel.x, pixel.y))
              }
            }
          }
        }
        let size = maximum - minimum
        let distance = simd.length(center)
        var object: [String: Any] = [
          "id": "mesh-\(anchor.identifier.uuidString)-\(geometry.label)",
          "anchorId": anchor.identifier,
          "label": geometry.label, "confidence": geometry.support, "source": "arkit-mesh-classification",
          "trackingState": tracking(frame.camera.trackingState), "cameraTimestampMs": timestamp, "depthTimestampMs": timestamp,
          "direction": Geometry.direction(sensorX: center.x, sensorY: -center.y, z: center.z, orientation: orientation),
          "distanceMeters": distance, "robustDistanceMeters": distance,
          "nearestPoint": ["x": center.x, "y": center.y, "z": center.z],
          "center": ["x": center.x, "y": center.y, "z": center.z],
          "sizeMeters": ["width": max(0, size.x), "height": max(0, size.y), "depth": max(0, size.z)]
        ]
        if let xs = projected.map({ $0.0 }).min(), let maxX = projected.map({ $0.0 }).max(),
          let ys = projected.map({ $0.1 }).min(), let maxY = projected.map({ $0.1 }).max() {
          let left = max(0, xs), top = max(0, ys)
          let width = min(1, maxX) - left, height = min(1, maxY) - top
          guard width > 0, height > 0 else { continue }
          object["bounds"] = ["x": left, "y": top, "width": width, "height": height]
        }
        if let steps = Geometry.steps(distance, settings: settings) { object["steps"] = steps }
        output.append(object)
      }
    }
    return output
  }

  static func label(_ classification: ARMeshClassification) -> String? {
    switch classification {
    case .seat: return "seat"
    case .table: return "table"
    case .door: return "door"
    case .window: return "window"
    case .wall: return "wall"
    default: return nil
    }
  }
}

func tracking(_ state: ARCamera.TrackingState) -> String {
  switch state {
  case .normal: return "normal"
  case .limited: return "limited"
  case .notAvailable: return "notAvailable"
  }
}

func isNormalTracking(_ state: ARCamera.TrackingState) -> Bool {
  if case .normal = state { return true }
  return false
}

func trackingReason(_ state: ARCamera.TrackingState) -> String? {
  switch state {
  case .normal: return nil
  case .notAvailable: return "Camera tracking is unavailable."
  case .limited(let reason):
    switch reason {
    case .excessiveMotion: return "Tracking is limited by excessive motion."
    case .initializing: return "Camera tracking is initializing."
    case .insufficientFeatures: return "Tracking needs more visible surface detail."
    case .relocalizing: return "Camera tracking is recovering its position."
    @unknown default: return "Camera tracking is limited."
    }
  }
}
