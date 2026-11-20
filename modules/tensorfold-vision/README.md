# TensorFold Vision

This Expo module runs user-invoked SmolVLM2-500M image queries on the device through LiteRT-LM. It does not capture images, poll the camera, install or load automatically, or run in the background. The parent must call `describeScene` after an explicit capture action. ARKit and ARCore remain the source of geometry and hazard warnings.

SmolVLM2 is supplemental evidence for naming visible objects and discussing seat occupancy. Its output can be wrong. The module returns model text without treating it as geometry or guidance. Do not use it for distance estimates, safe-path decisions, autonomous hazard classification, crossings, or other critical automated decisions. FastVLM is not included or referenced by the implementation.

## JavaScript contract

`describeScene(request): Promise<string>` resolves to the raw generated string. The parent owns schema checks, grounding, uncertainty wording, and any decision about whether an answer is useful. No structured result is invented when the model output does not conform.

The default export is the native Expo module object, so `new EventEmitter(Vision)` works. Named exports are also available for `getCapabilities`, `getStatus`, `installModel`, `cancelInstall`, `loadModel`, `unloadModel`, `describeScene`, `cancel`, and `addVisionListener`. The module uses `requireOptionalNativeModule`; web gets `available: false` and `vision: false`, while operations that need native inference reject instead of returning simulated output.

```ts
const status = await Vision.installModel()
await Vision.loadModel(status.installationId)
const text = await Vision.describeScene({
  requestId: 'query-1',
  prompt: 'Name the prominent objects in this image. Do not estimate distance.',
  imageBase64,
  maxTokens: 96,
})
```

`loadModel` accepts the pinned revision as its optional `installationId`. `cancel(requestId)` cancels only the matching active scene conversation through LiteRT-LM's native cancellation API. Unknown request IDs are no-ops. `cancelInstall()` disconnects an active model download and prevents staged publication; the corresponding `installModel` promise rejects with `E_INSTALL_CANCELLED`, and temporary staging files are removed. Calling it without an active installation is a no-op. `unloadModel` cancels an active query and waits for it to finish before releasing the engine.

Events are emitted on `onVisionEvent` with `type` equal to `status`, `started`, `completed`, `cancelled`, or `error`. Status events carry `event.status`; generation events also carry `requestId`. Download progress is reported in `status.progress`, `status.downloadedBytes`, and `status.totalBytes`. Loading emits truthful start and completion states because LiteRT-LM exposes no byte-level load callback.

## Model and integrity

- Repository: `litert-community/SmolVLM2-500M`
- File: `SmolVLM2-500M.litertlm`
- Immutable repository revision: `8dbba113efdeca80107357d76ab00fc0c71048fd`
- Size: `363085824` bytes, about 363 MB in decimal units
- SHA-256: `7b432bbc0a5c54ba15ecb2f039a7711c1cfb1fe38badec01397a076b5043f74e`
- Conversion and base model license: Apache-2.0. See `THIRD_PARTY_NOTICES.txt`.
- Conversion card: https://huggingface.co/litert-community/SmolVLM2-500M
- Runtime overview: https://developers.google.com/edge/litert-lm/overview

Only the pinned HTTPS URL is used, and redirects must use HTTPS on both platforms. Downloads are streamed, size-checked, and SHA-256-checked in a fresh staging directory. Publication uses same-filesystem atomic renames. `installation.json` persists the model identity and integrity metadata beside the bundle. Existing installations are fully checked again before every model load. Corrupt staged data is never published.

An install needs the model size plus 64 MiB of temporary free space. Android rejects downloads that exceed five redirects, exceed the expected byte count, stall for its configured socket timeouts, or return a non-200 response. iOS has a 60-second request timeout and a one-hour resource timeout.

## Runtime and lifecycle

LiteRT-LM is pinned to 0.19.1 on both platforms. GitHub has no official v0.19.2 release or tag, and Google Maven currently lists 0.19.1 as the latest Android artifact, so the implementation does not reference a nonexistent 0.19.2 package. The current SmolVLM2 card identifies 0.16.0 as the vision-conversation failure and reports successful conversation startup for 0.17.0 through 0.19.2. Its Android GPU external-weights requirement is 0.19.0 or newer. iOS uses GPU decoding and GPU vision. Android explicitly uses CPU decoding and GPU vision because its GPU-decoder sampler fails on the verified emulator with a missing OpenCL library. There is no silent cloud, text-only, or fabricated-vision fallback.

A load requires 1.5 GB of currently available memory as an application resource budget. This is a conservative admission check, not a measured model minimum or a promise that initialization will succeed. The actual LiteRT-LM initializer determines device compatibility. Low-memory callbacks cancel active work and unload the engine. A query rejected by missing storage, insufficient resources, missing runtime support, integrity failure, or initialization failure rejects with an error.

Every `describeScene` call creates a new conversation with exactly one image and no tools. It uses a fixed sampler (`topK=40`, `topP=0.9`, `temperature=0.2`, `seed=0`), the model's 2048-token context, and the caller's `maxTokens` from 1 through 256. Queries time out after 90 seconds and invoke native cancellation. Only one query runs at a time. The returned text is not trimmed or rewritten.

Input may be base64 or one file in an app-owned temporary/cache directory. The image must be a valid image with a regular file size from 1 byte through 20 MiB. Base64 is decoded into a private vision-owned temporary file, validated with the platform image decoder, and deleted after the request. Caller-supplied temporary files are validated but never deleted by this module.

## Build requirements

### Android

- Use the parent app's Android API 29 minimum and Expo/RN Gradle setup.
- `modules/tensorfold-vision/android/build.gradle` pins `com.google.ai.edge.litertlm:litertlm-android:0.19.1` and Kotlin coroutines 1.11.0. The parent app uses Kotlin 2.3.0, which can read LiteRT's Kotlin 2.4 metadata and is accepted by Expo's KSP mapping. Expo also lists 2.3.1, but Maven has no Kotlin 2.3.1 Gradle plugin release.
- The module manifest declares optional `libvndksupport.so` and `libOpenCL.so` native libraries inside `<application>`, as required by the official Android GPU guide.
- The final app must keep Internet permission for installation. Inference itself is local to LiteRT-LM.

### iOS

- Xcode 15 or newer and iOS 15 or newer are required by the official runtime package. The parent app currently targets iOS 17.
- Run `bun run vendor:litert-ios` before a direct prebuild, Pod installation, or Xcode build. `bun run ios` runs it automatically. The script downloads the official 0.19.1 `CLiteRTLM.xcframework` release and verifies its SHA-256 before extraction.
- The generated XCFramework lives under `modules/tensorfold-vision/ios/vendor/`, inside the pod source root and outside Git. The build no longer resolves the remote Swift package or its Git LFS checkout.
- The exact 0.19.1 production Swift wrappers and Apache-2.0 license are vendored under `ios/LiteRTLM/` and compiled into `TensorFoldVision`. Tests, samples, and the unused Apple Foundation Models adapter are excluded.

## Integrated verification

On the Android API 36 arm64 emulator with 6 GiB RAM, the real settings surface installed the pinned 363 MB bundle and loaded the CPU-decoder/GPU-vision configuration. The original GPU-decoder configuration failed with `Can not find OpenCL library on this device`; the explicit decoder change avoided that sampler failure without a cloud or fabricated-response fallback.

The real `What's ahead?` flow captured a frozen emulator frame, ran offline perception and OCR, and generated `unoccupied chair | center` in one measured 5.2-second probe. The strict parser accepted the line but required native geometry for seat availability. The final visible response was `From the captured view: Looks like chair ahead.` with no steps or metric distance, matching camera-only sensor limits.

Focused guidance tests cover market object queries, seat-evidence rejection and corroboration, street-object direction and step estimates, stale snapshots, generated-answer evidence binding, and malformed visual output. These tests do not establish recognition quality in physical stores, restaurants, or streets.

Physical-device validation is pending for camera and depth quality, Bluetooth, haptics, offline speech, model cancellation, sustained latency, memory pressure, and thermal behavior.
