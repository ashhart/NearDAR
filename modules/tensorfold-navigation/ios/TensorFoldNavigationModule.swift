import CoreLocation
import ExpoModulesCore
import Foundation
import MapKit

private final class NavigationController: NSObject, CLLocationManagerDelegate {
  private let manager = CLLocationManager()
  private var tracking = false
  private var backgroundEnabled = false
  private var pendingPermission: Promise?
  var emit: ((String, [String: Any]) -> Void)?

  private var isBackgroundLocationSupported: Bool {
    guard let modes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] else {
      return false
    }
    return modes.contains("location")
  }

  override init() {
    super.init()
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
    manager.activityType = .fitness
    manager.distanceFilter = 1.5
    manager.headingFilter = 3.0
  }

  func capabilities() -> [String: Any] {
    let status = manager.authorizationStatus
    let perm: String
    switch status {
    case .authorizedAlways, .authorizedWhenInUse: perm = "granted"
    case .denied: perm = "denied"
    case .restricted: perm = "restricted"
    case .notDetermined: perm = "notDetermined"
    @unknown default: perm = "unknown"
    }
    return [
      "available": true,
      "platform": "ios",
      "mapKitDirections": true,
      "compassHeading": CLLocationManager.headingAvailable(),
      "locationPermission": perm,
      "backgroundSupported": isBackgroundLocationSupported
    ]
  }

  func setBackgroundEnabled(_ enabled: Bool) {
    backgroundEnabled = enabled
    applyBackgroundMode(enabled)
  }

  private func applyBackgroundMode(_ enabled: Bool) {
    if enabled && isBackgroundLocationSupported {
      manager.allowsBackgroundLocationUpdates = true
      manager.pausesLocationUpdatesAutomatically = false
      manager.showsBackgroundLocationIndicator = true
    } else {
      if manager.allowsBackgroundLocationUpdates {
        manager.allowsBackgroundLocationUpdates = false
      }
      manager.pausesLocationUpdatesAutomatically = true
      manager.showsBackgroundLocationIndicator = false
    }
  }

  func startTracking(promise: Promise) {
    let status = manager.authorizationStatus
    switch status {
    case .authorizedWhenInUse, .authorizedAlways:
      beginUpdates()
      promise.resolve(["active": true])
    case .notDetermined:
      pendingPermission?.reject("E_NAV_REPLACED", "Superseded by another location permission request.")
      pendingPermission = promise
      manager.requestWhenInUseAuthorization()
    case .denied, .restricted:
      promise.reject("E_LOCATION_PERMISSION", "Location access is denied or restricted. Enable it in iOS Settings.")
    @unknown default:
      promise.reject("E_LOCATION_PERMISSION", "Location authorization state is unavailable.")
    }
  }

  func stopTracking() {
    tracking = false
    applyBackgroundMode(false)
    manager.stopUpdatingLocation()
    if CLLocationManager.headingAvailable() {
      manager.stopUpdatingHeading()
    }
  }

  func searchPlaces(query: String, nearLat: Double?, nearLng: Double?, promise: Promise) {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      promise.resolve([])
      return
    }
    let request = MKLocalSearch.Request()
    request.naturalLanguageQuery = trimmed
    request.resultTypes = [.pointOfInterest, .address]
    if let lat = nearLat, let lng = nearLng, lat.isFinite, lng.isFinite {
      let center = CLLocationCoordinate2D(latitude: lat, longitude: lng)
      request.region = MKCoordinateRegion(center: center, latitudinalMeters: 4_000, longitudinalMeters: 4_000)
    } else if let current = manager.location {
      request.region = MKCoordinateRegion(center: current.coordinate, latitudinalMeters: 4_000, longitudinalMeters: 4_000)
    }
    let search = MKLocalSearch(request: request)
    search.start { response, error in
      if let error {
        promise.reject("E_PLACE_SEARCH", error.localizedDescription)
        return
      }
      let origin: CLLocation?
      if let lat = nearLat, let lng = nearLng, lat.isFinite, lng.isFinite {
        origin = CLLocation(latitude: lat, longitude: lng)
      } else {
        origin = self.manager.location
      }
      let items = (response?.mapItems ?? []).prefix(8).map { item -> [String: Any] in
        let coord = item.placemark.coordinate
        let loc = CLLocation(latitude: coord.latitude, longitude: coord.longitude)
        let addressParts = [
          item.placemark.subThoroughfare,
          item.placemark.thoroughfare,
          item.placemark.locality
        ].compactMap { $0 }
        var entry: [String: Any] = [
          "name": item.name ?? trimmed,
          "address": addressParts.joined(separator: " "),
          "latitude": coord.latitude,
          "longitude": coord.longitude
        ]
        if let origin {
          entry["distanceMeters"] = origin.distance(from: loc)
        }
        return entry
      }
      let sorted = items.sorted { ($0["distanceMeters"] as? Double ?? .infinity) < ($1["distanceMeters"] as? Double ?? .infinity) }
      promise.resolve(sorted)
    }
  }

  func calculateWalkingRoute(
    fromLat: Double,
    fromLng: Double,
    toLat: Double,
    toLng: Double,
    destinationName: String?,
    promise: Promise
  ) {
    let source = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: fromLat, longitude: fromLng)))
    let dest = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: toLat, longitude: toLng)))
    dest.name = destinationName

    let request = MKDirections.Request()
    request.source = source
    request.destination = dest
    request.transportType = .walking
    request.requestsAlternateRoutes = false

    let directions = MKDirections(request: request)
    directions.calculate { response, error in
      if let error {
        promise.reject("E_DIRECTIONS", error.localizedDescription)
        return
      }
      guard let route = response?.routes.first else {
        promise.reject("E_NO_ROUTE", "No walking route was found to that destination.")
        return
      }
      let polyline = Self.extractCoordinates(from: route.polyline)
      let steps: [[String: Any]] = route.steps.compactMap { step in
        let text = step.instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        let coords = Self.extractCoordinates(from: step.polyline)
        guard !coords.isEmpty else { return nil }
        return [
          "instruction": text.isEmpty ? "Continue along the path" : text,
          "distanceMeters": step.distance,
          "coordinates": coords
        ]
      }
      promise.resolve([
        "id": UUID().uuidString,
        "destinationName": destinationName ?? "Destination",
        "destination": ["latitude": toLat, "longitude": toLng],
        "origin": ["latitude": fromLat, "longitude": fromLng],
        "distanceMeters": route.distance,
        "expectedTravelTimeSeconds": route.expectedTravelTime,
        "polyline": polyline,
        "steps": steps,
        "source": "mapkit",
        "createdAt": Date().timeIntervalSince1970 * 1000
      ])
    }
  }

  private static func extractCoordinates(from polyline: MKPolyline) -> [[String: Double]] {
    let count = polyline.pointCount
    guard count > 0 else { return [] }
    var coords = Array(repeating: CLLocationCoordinate2D(), count: count)
    polyline.getCoordinates(&coords, range: NSRange(location: 0, length: count))
    return coords.map { ["latitude": $0.latitude, "longitude": $0.longitude] }
  }

  private func beginUpdates() {
    tracking = true
    if backgroundEnabled {
      applyBackgroundMode(true)
    }
    manager.startUpdatingLocation()
    if CLLocationManager.headingAvailable() {
      manager.startUpdatingHeading()
    }
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    guard let pending = pendingPermission else { return }
    let status = manager.authorizationStatus
    if status == .notDetermined { return }
    pendingPermission = nil
    if status == .authorizedWhenInUse || status == .authorizedAlways {
      beginUpdates()
      pending.resolve(["active": true])
    } else {
      pending.reject("E_LOCATION_PERMISSION", "Location access was not granted.")
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard tracking, let loc = locations.last, loc.horizontalAccuracy >= 0 else { return }
    var payload: [String: Any] = [
      "type": "location",
      "latitude": loc.coordinate.latitude,
      "longitude": loc.coordinate.longitude,
      "accuracyMeters": loc.horizontalAccuracy,
      "timestampMs": loc.timestamp.timeIntervalSince1970 * 1000
    ]
    if loc.speed >= 0 { payload["speedMps"] = loc.speed }
    if loc.course >= 0 { payload["courseDegrees"] = loc.course }
    emit?("onNavigationEvent", payload)
  }

  func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
    guard tracking, newHeading.headingAccuracy >= 0 else { return }
    var payload: [String: Any] = [
      "type": "heading",
      "magneticHeadingDegrees": newHeading.magneticHeading,
      "accuracyDegrees": newHeading.headingAccuracy,
      "timestampMs": newHeading.timestamp.timeIntervalSince1970 * 1000
    ]
    if newHeading.trueHeading >= 0 {
      payload["trueHeadingDegrees"] = newHeading.trueHeading
    }
    emit?("onNavigationEvent", payload)
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    emit?("onNavigationEvent", [
      "type": "error",
      "message": error.localizedDescription,
      "timestampMs": Date().timeIntervalSince1970 * 1000
    ])
  }
}

public final class TensorFoldNavigationModule: Module {
  private lazy var controller: NavigationController = {
    let ctrl = NavigationController()
    ctrl.emit = { [weak self] name, payload in
      self?.sendEvent(name, payload)
    }
    return ctrl
  }()

  public func definition() -> ModuleDefinition {
    Name("TensorFoldNavigation")
    Events("onNavigationEvent")

    AsyncFunction("getCapabilities") {
      self.controller.capabilities()
    }.runOnQueue(.main)

    AsyncFunction("startTracking") { (promise: Promise) in
      self.controller.startTracking(promise: promise)
    }.runOnQueue(.main)

    AsyncFunction("stopTracking") {
      self.controller.stopTracking()
    }.runOnQueue(.main)

    AsyncFunction("setBackgroundEnabled") { (enabled: Bool) in
      self.controller.setBackgroundEnabled(enabled)
    }.runOnQueue(.main)

    AsyncFunction("searchPlaces") { (query: String, nearLat: Double?, nearLng: Double?, promise: Promise) in
      self.controller.searchPlaces(query: query, nearLat: nearLat, nearLng: nearLng, promise: promise)
    }.runOnQueue(.main)

    AsyncFunction("calculateWalkingRoute") { (fromLat: Double, fromLng: Double, toLat: Double, toLng: Double, destinationName: String?, promise: Promise) in
      self.controller.calculateWalkingRoute(
        fromLat: fromLat,
        fromLng: fromLng,
        toLat: toLat,
        toLng: toLng,
        destinationName: destinationName,
        promise: promise
      )
    }.runOnQueue(.main)

    OnDestroy {
      self.controller.stopTracking()
    }
  }
}
