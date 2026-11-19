# Sonar

A standalone React Native application for eyes-free, on-device spatial assistance. TensorFold is the embedded language-inference engine, not a desktop server or a cloud fallback.

## Runtime architecture

1. Native ARKit or ARCore captures timestamped camera, tracking, depth, and confidence data.
2. Native geometry and detectors produce proximity warnings, coarse direction and distance, step estimates, seat evidence, and OCR. This path does not wait for a language model.
3. An explicit scene question can freeze one current frame for SmolVLM2-500M through LiteRT-LM. Its strict `object | direction` labels are supplemental appearance evidence, never depth or movement-safety decisions.
4. The guidance layer associates a visual label with measured geometry only for an unambiguous coarse-direction match. Otherwise it speaks the label without distance.
5. TensorFold answers open questions when the platform has its native conversation backend. Every platform can use deterministic native scene facts. Generated prose is rejected when evidence IDs, known labels, directions, or numeric measurements do not match.
6. Offline speech synthesis speaks the answer. Recognition restarts afterward while hands-free mode and guidance remain active.

Pausing, backgrounding, disabling hands-free mode, or losing a headphone route stops the relevant camera and microphone work. Speech and inference have request-specific cancellation. Sensor degradation and recovery have separate spoken status cues.

## Platform capabilities

| Capability | iOS 17+ | Android 10+ |
| --- | --- | --- |
| Camera and tracking | ARKit on supported devices | ARCore on supported devices |
| Measured depth | LiDAR scene depth when present | ARCore raw depth and confidence when supported |
| Object evidence | Mesh classes, person detection, and supplemental SmolVLM2 labels | Generic depth geometry and supplemental SmolVLM2 labels |
| Free-seat evidence | Native visual/geometry evidence plus supplemental image evidence | Requires compatible visual and geometric evidence; ambiguous scenes return no seat |
| OCR | Apple Vision | Bundled offline ML Kit |
| Conversation | Embedded TensorFold with Metal | Unavailable: upstream Vulkan lacks a served mobile checkpoint-loading generation engine |
| Visual model | LiteRT-LM 0.19.1 with SmolVLM2-500M | LiteRT-LM 0.19.1 with SmolVLM2-500M |
| Voice | On-device speech recognition and an installed offline synthesis voice | On-device recognizer and installed offline voice data |
| Directional haptics | Core Haptics | Android vibration patterns |

Unsupported hardware or missing offline assets returns an explicit unavailable state. The app does not replace those failures with cloud inference or simulated measurements. ARCore depth is optional on supported ARCore devices; distances and steps are omitted when depth confidence or freshness is insufficient.

## Models

- **TensorFold:** Qwen3.5-2B language inference for open scene questions. Installation uses pinned artifacts, checksums, atomic installation, explicit loading, and cancellation.
- **Vision:** `litert-community/SmolVLM2-500M`, revision `8dbba113efdeca80107357d76ab00fc0c71048fd`, Apache-2.0, approximately 363 MB. Model output is limited to validated line-based object/seat labels and one conversation per frozen image.

FastVLM is not used: its model license excludes product development. Model downloads use the network. Installed inference, perception, recognition, and synthesis run locally; the operating system must have the required offline speech assets.

## Wearables

The phone provides one vibration location, so direction uses learned temporal patterns with redundant speech, not spatial vibration. See [wearable integration boundaries](docs/wearables.md) for Meta glasses, watches, and multi-actuator devices. Glasses camera APIs do not supply LiDAR or metric depth, and Meta's current iOS store restriction prevents presenting that adapter as a store-ready feature.

## Repository layout

- `src/app/`: Expo Router screens and spoken onboarding.
- `src/lib/guidance/`: request lifecycle, grounding, command, alert, and recovery policy.
- `modules/tensorfold-engine/`: embedded TensorFold native module.
- `modules/tensorfold-vision/`: pinned LiteRT-LM visual inference.
- `modules/tensorfold-perception/`: native camera, depth, detection, frozen captures, and scene snapshots.
- `modules/tensorfold-voice/`: offline speech and audio routing.
- `modules/tensorfold-haptics/`: native directional patterns.
- `engine/`: app-owned TensorFold build adaptation.
- `vendor/TensorFold/`: pinned upstream source, fetched by the bootstrap script.

## Development

Install Bun, Xcode with an iOS device target, Android SDK tools, and the exact Zig version from `vendor/TensorFold/.zig-version` after bootstrapping.

```sh
bun install
./scripts/bootstrap-engine.sh
node scripts/engine/build-mobile.mjs
bun run verify
bun run ios
bun run android
```

The engine build creates both device and arm64 Simulator libraries, packages them as `engine/out/ios/TensorFoldMobile.xcframework`, copies that XCFramework into the engine pod's ignored vendor directory, and builds Android arm64 and x86_64 libraries.

The iOS run script downloads and verifies the pinned LiteRT-LM 0.19.1 XCFramework before building. For direct `expo prebuild`, CocoaPods, or `xcodebuild` commands, run `bun run vendor:litert-ios` first. The generated binary stays out of Git; the pinned production Swift wrappers and their license are in `modules/tensorfold-vision/ios/LiteRTLM/`.

Use physical devices for camera, depth, Bluetooth, haptics, offline speech assets, model-memory, and thermal testing. Simulators and the web surface can verify interface and some native-runtime behavior but cannot qualify spatial guidance or device performance. Guidance supplements usual mobility aids; it never decides when a path is safe or when to cross a road.
