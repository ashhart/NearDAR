import ExpoModulesCore
import Foundation

public final class TensorFoldVisionModule: Module {
  private lazy var controller = VisionController { [weak self] event in
    self?.sendEvent("onVisionEvent", event)
  }

  public func definition() -> ModuleDefinition {
    Name("TensorFoldVision")
    Events("onVisionEvent")

    AsyncFunction("getCapabilities") { (promise: Promise) in
      Task { promise.resolve(await controller.capabilities()) }
    }

    AsyncFunction("getStatus") { (promise: Promise) in
      Task { promise.resolve(await controller.status()) }
    }

    AsyncFunction("installModel") { (modelId: String?, promise: Promise) in
      Task {
        do {
          promise.resolve(try await controller.install(modelId: modelId))
        } catch {
          reject(promise, error: error, fallback: "E_INSTALL")
        }
      }
    }

    AsyncFunction("loadModel") { (installationId: String?, promise: Promise) in
      Task {
        do {
          promise.resolve(try await controller.load(installationId: installationId))
        } catch {
          reject(promise, error: error, fallback: "E_MODEL_LOAD")
        }
      }
    }

    AsyncFunction("unloadModel") { (promise: Promise) in
      Task {
        do {
          try await controller.unload()
          promise.resolve(nil)
        } catch {
          reject(promise, error: error, fallback: "E_MODEL_UNLOAD")
        }
      }
    }

    AsyncFunction("describeScene") { (request: [String: Any], promise: Promise) in
      Task {
        do {
          promise.resolve(try await controller.describe(request))
        } catch {
          reject(promise, error: error, fallback: "E_VISION_INFERENCE")
        }
      }
    }

    AsyncFunction("cancel") { (requestId: String, promise: Promise) in
      Task {
        do {
          try await controller.cancel(requestId: requestId)
          promise.resolve(nil)
        } catch {
          reject(promise, error: error, fallback: "E_VISION_CANCEL")
        }
      }
    }
    AsyncFunction("cancelInstall") { controller.cancelInstall() }


    OnDestroy { controller.shutdown() }
  }

  private func reject(_ promise: Promise, error: Error, fallback: String) {
    if let failure = error as? VisionFailure {
      promise.reject(failure.code, failure.message)
    } else {
      promise.reject(fallback, error.localizedDescription)
    }
  }
}
