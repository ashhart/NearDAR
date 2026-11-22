# LiDAR validation

On macOS, run `sh scripts/test-ios-perception.sh`. It tests the production clock, projection, depth-buffer validation, and alignment timing with synthetic Core Video buffers. `bun run verify` checks the app’s guidance logic and bridge types.

## Physical iPhone checks

Run a signed release build on a LiDAR iPhone in a controlled, familiar room. Install the offline descriptions model first. Record the phone model, iOS version, distance and result for each scenario.

| Scenario | Expected result |
| --- | --- |
| Place a visible chair one to three metres away. Ask for a seat with the phone in portrait, first to its left and then to its right. | The side in the answer agrees with the view. Compare any spoken distance with a tape measure. |
| Run “Align to the seat” while standing still and turning the phone towards the chair. Repeat from both sides. | One tap and spoken confirmation when the phone holds the direction with enough depth evidence. |
| Cover the chair’s seat with a bag, place a person between the camera and the chair, then move or remove the chair after the answer. | An obscured seat stays uncertain. Alignment gives no confirmation when the measured target is hidden or has moved. |
| Cover the camera, turn away quickly, move the phone more than half a metre from the capture position, or send the app to the background during alignment. | Alignment gives no confirmation on an interrupted, stale or shifted view. A fresh scan can be used after recovery. |
| Try a reflective or poorly measured surface, then repeat on an iPhone without LiDAR. | The app withholds unsupported distance and alignment cues. Camera-based questions remain available when tracking is usable. |

The alignment tap confirms where the phone is pointing. Keep mobility aids in use throughout the test.

## Design references

- The scanner pairs the depth and confidence buffers with calibration and camera pose from the same frame. Its capture lifecycle also explains limits to tracking recovery. [LiDAR Scanner](https://github.com/Dominik-Hagmann/lidar-scanner-ios#data-provenance)
- The sample shows how confidence varies across a scene and documents the relationship between depth and confidence pixels. [ExampleOfiOSLiDAR](https://github.com/TokyoYoshida/ExampleOfiOSLiDAR/blob/main/ExampleOfiOSLiDAR/Samples/ConfidenceMap/ConfidenceMap.md)
- Apple documents the depth buffer formats, reflective surfaces and tracking interruptions. [ARDepthData](https://developer.apple.com/documentation/arkit/ardepthdata) · [Tracking quality](https://developer.apple.com/documentation/arkit/managing-session-life-cycle-and-tracking-quality)
