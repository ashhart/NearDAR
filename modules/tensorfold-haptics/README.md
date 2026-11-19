# TensorFold haptics

This module turns a warning into one finite vibration pattern. Speech remains the redundant warning channel. The vibration does not replace object names, instructions, or sensor status.

## Learn the patterns

Practice while stationary with the phone held in the hand normally used during guidance. Play each `info` cue without walking. Say its name aloud before checking the table, then repeat until the rhythms are consistently recognized. Add `caution` and `urgent` only after the direction patterns are familiar.

A fast gap means the next vibration follows the short 80 ms tap after 110 ms of silence. A slow gap has 330 ms of silence. Actual motor strength varies by device, so teach rhythm before strength.

| Direction or condition | Rhythm |
| --- | --- |
| `ahead` | One short tap. |
| `ahead-left` | Two short taps with a fast gap. |
| `ahead-right` | Three short taps with fast gaps. |
| `left` | Two taps with a slow gap. |
| `right` | Three taps with slow gaps. |
| `behind` | Two long vibrations with a short gap. |
| `unknown` | Four short taps in two pairs with a wider gap between the pairs. This reports degraded or unavailable sensor health, not a physical direction. |

On iOS, `behind` uses two continuous Core Haptics events. The other signatures use transient taps. Android represents the same signatures as long and short vibration intervals.

The urgency suffix comes after a 240 ms pause, separate from the direction signature:

| Severity | Direction intensity and suffix |
| --- | --- |
| `info` | Base intensity, no suffix. |
| `caution` | Higher intensity, one tap after the pause. |
| `urgent` | Highest intensity, two fast taps after the pause. |

On Android devices without amplitude control, the intensity cannot change. Timing and the urgency suffix still work. `getCapabilities()` reports `amplitudeControl: false` in that case.

Distance only provides a coarse intensity adjustment. A finite, nonnegative `distanceMeters` value of 1.5 or less adds a small intensity increase when the actuator supports amplitude control. Every greater or missing distance uses the base intensity. Pulse counts and timing never represent meters. Do not speak an estimated distance just because the vibration changed.

## Limitations and integration

A phone has one vibration actuator. These learned rhythms name a direction; they do not make the vibration feel as if it comes from that direction. Never describe this as continuous spatial localization, and never ask a blind user to steer from vibration alone. Keep the spoken direction available.

Call `play()` once for a warning accepted by the app's warning scheduler. Do not add a second speech announcement as a consequence of playing haptics. This module contains no speech code and emits no speech events. A later call replaces a pattern already in progress instead of layering over it.

Check `getCapabilities()` before training or guidance. If haptics are unavailable, `play()` resolves with `{ status: "unavailable", reason }` and does nothing. There is no generic vibration fallback because a different, untrained buzz could be mistaken for a direction. `stop()` is safe on unsupported hardware and cancels playback on backgrounding, activity loss, or module teardown. The app should also call `stop()` whenever guidance pauses.
