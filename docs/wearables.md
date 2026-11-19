# Wearable integration boundaries

## Meta AI glasses

Meta's Device Access Toolkit supplies native iOS and Android camera streaming, Bluetooth audio, display, and gesture APIs. A React Native host needs native adapters, paired glasses, Meta AI app registration, camera permission, and an active device session.

The app can use in-stream camera frames as an additional visual input. The native perception boundary accepts frames, timestamps, and actual frame dimensions. Only compact direction, severity, and scene-evidence records cross into React Native.

Current hard limits:

- No documented depth-map, LiDAR, or haptic-output API. Glasses IMU data is not a distance measurement.
- Camera streams do not provide camera intrinsics. Monocular inference must not be described as LiDAR or measured depth.
- Standalone high-quality photo capture cannot currently be published. In-stream camera audio and motion are beta capabilities.
- Meta's iOS integration currently triggers an App Store rejection associated with ExternalAccessory and privacy manifests. It is a development integration only until Meta changes that support.
- Camera capture indicators must remain visible. Session interruption, removal, and disconnection must pause guidance explicitly.
- Display output is limited to supported display glasses and is supplementary information, not the blind-user guidance path.

Primary sources: [toolkit overview](https://developers.meta.com/wearables/device-access-toolkit/), [setup](https://wearables.developer.meta.com/docs/develop/dat/getting-started-toolkit/), [streaming](https://wearables.developer.meta.com/docs/develop/dat/streaming/), [camera processing](https://wearables.developer.meta.com/docs/develop/dat/camera-stream-processing/), [audio](https://wearables.developer.meta.com/docs/develop/dat/microphones-and-speakers/), [iOS integration warning](https://wearables.developer.meta.com/docs/develop/dat/build-integration-ios/), [release channels](https://wearables.developer.meta.com/docs/develop/dat/set-up-release-channels/).

Integration sequence: Android development hardware first, foreground camera and A2DP speech, then microphone input over HFP. iOS remains a development-only adapter until store support changes. Glasses visual evidence can receive a direction only from a calibrated visual estimate; metric distances require a separately validated depth source.

## Watches and directional touch

A phone, Apple Watch, or typical Wear OS watch exposes one usable vibration location. The current haptic module therefore encodes direction as learned temporal patterns and always pairs them with speech. It does not claim continuous spatial localization.

Apple Watch requires a native watchOS companion and Watch Connectivity. Immediate messages require a reachable counterpart, queued transfers have no real-time guarantee, and background haptics are limited to specific workout or navigation sessions. Navigation haptic types also have session requirements. Sources: [Watch haptics](https://developer.apple.com/documentation/watchkit/wkinterfacedevice/play(_:)), [Watch Connectivity](https://developer.apple.com/documentation/watchconnectivity/wcsession).

Wear OS requires a native watch companion and Data Layer messages. Delivery is best-effort without persistence or built-in retry. Android multiple-vibrator IDs do not identify actuator positions and must not be treated as left/right locations. Sources: [Data Layer](https://developer.android.com/training/wearables/data/overview), [VibratorManager](https://developer.android.com/reference/android/os/VibratorManager).

Speech remains active when watch connectivity is unavailable or delayed. Hazard delivery must never depend solely on either watch transport.

## Multi-actuator wearables

A body-mapped band, sleeve, or belt is the appropriate hardware for continuous touch direction. bHaptics has a native iOS SDK with per-motor control, but its official list has no equivalent Android SDK and setup requires credentials and Internet-backed event deployment. Any pilot needs explicit body-actuator mapping, learned patterns, offline pattern playback, and redundant speech. Source: [bHaptics Swift SDK](https://docs.bhaptics.com/sdk/swift/guide/).
