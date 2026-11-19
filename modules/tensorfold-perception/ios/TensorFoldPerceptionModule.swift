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
    OnDestroy {
      lifecycleObservers.forEach(NotificationCenter.default.removeObserver)
      lifecycleObservers.removeAll()
      controller.stop { _ in }
    }
  }
}
