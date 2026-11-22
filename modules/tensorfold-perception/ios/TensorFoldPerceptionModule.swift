import ExpoModulesCore
import UIKit
import Foundation

public final class TensorFoldPerceptionModule: Module {
  private var lifecycleObservers: [NSObjectProtocol] = []
  private lazy var controller: PerceptionController = {
    let controller = PerceptionController()
    controller.emit = { [weak self] name, body in
      guard let self else { return }
      switch name {
      case "onSnapshot": self.sendEvent("onPerceptionEvent", ["type": "snapshot", "snapshot": PerceptionContract.snapshot(body)])
      case "onWarning": self.sendEvent("onPerceptionEvent", ["type": "warning", "warning": PerceptionContract.warning(body)])
      case "onStatus":
        if let message = PerceptionContract.statusMessage(body) { self.sendEvent("onPerceptionEvent", ["type": "status", "message": message]) }
      case "onError": self.sendEvent("onPerceptionEvent", ["type": "error", "message": body["message"] as? String ?? "Perception failed."])
      default: break
      }
    }
    return controller
  }()

  public func definition() -> ModuleDefinition {
    Name("TensorFoldPerception")
    Events("onPerceptionEvent")

    View(CameraPreviewView.self) {
      Prop("playing") { [weak self] (view: CameraPreviewView, playing: Bool) in
        view.bind(playing ? self?.controller : nil)
      }
    }

    OnCreate {
      let center = NotificationCenter.default
      lifecycleObservers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
        self?.sendEvent("onPerceptionEvent", ["type": "lifecycle", "foreground": false])
      })
      lifecycleObservers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
        self?.sendEvent("onPerceptionEvent", ["type": "lifecycle", "foreground": true])
      })
    }

    AsyncFunction("getCapabilities") { controller.capabilities() }

    AsyncFunction("isForeground") {
      UIApplication.shared.applicationState == .active
    }

    AsyncFunction("getStatus") { controller.currentStatus() }

    AsyncFunction("startSession") { (options: [String: Any]?, promise: Promise) in
      controller.start(options: options) { result in
        switch result {
        case .success: promise.resolve(nil)
        case .failure(let error): promise.reject(error.code, error.message)
        }
      }
    }

    AsyncFunction("stopSession") { (promise: Promise) in
      controller.stop { _ in promise.resolve(nil) }
    }

    AsyncFunction("captureScene") { (options: [String: Any]?, promise: Promise) in
      controller.capture(options: options) { result in
        switch result {
        case .success(let value): promise.resolve(PerceptionContract.snapshot(value))
        case .failure(let error): promise.reject(error.code, error.message)
        }
      }
    }

    AsyncFunction("releaseCapture") { (uri: String) in controller.release(uri) }
    AsyncFunction("alignToSeat") { (id: String, observedAt: Double, promise: Promise) in
      controller.alignToSeat(id: id, observedAt: observedAt) { result in promise.resolve(result) }
    }
    AsyncFunction("cancelSeatAlignment") { controller.cancelSeatAlignment() }
    OnDestroy {
      lifecycleObservers.forEach(NotificationCenter.default.removeObserver)
      lifecycleObservers.removeAll()
      controller.stop { _ in }
    }
  }
}

final class CameraPreviewView: ExpoView {
  private let imageView = UIImageView()
  private weak var controller: PerceptionController?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    isUserInteractionEnabled = false
    clipsToBounds = true
    imageView.contentMode = .scaleAspectFit
    addSubview(imageView)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    imageView.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    updateSubscription()
  }

  func bind(_ controller: PerceptionController?) {
    if self.controller !== controller {
      self.controller?.setPreview(id: ObjectIdentifier(self), display: nil)
      self.controller = controller
    }
    updateSubscription()
  }

  private func updateSubscription() {
    let id = ObjectIdentifier(self)
    guard window != nil, let controller else {
      imageView.image = nil
      controller?.setPreview(id: id, display: nil)
      return
    }
    controller.setPreview(id: id) { [weak self] image in
      DispatchQueue.main.async {
        guard let self, self.window != nil, self.controller != nil else { return }
        self.imageView.image = UIImage(cgImage: image)
      }
    }
  }
}
