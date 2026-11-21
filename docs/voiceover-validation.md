# VoiceOver device checks

Use a signed build on a physical iPhone with VoiceOver and the phone speaker. Test camera and vibration cues while standing in a familiar room. Record the build, device, result and any unexpected focus or speech for each issue.

| Issue | Check |
| --- | --- |
| [#2](https://github.com/ashhart/NearDAR/issues/2) | Start hands-free and ask what you see. Repeat using Start camera and Type a question. A fresh frame supports both paths. Verify old frames and proximity warnings with the [LiDAR checks](lidar-validation.md). |
| [#3](https://github.com/ashhart/NearDAR/issues/3) | Start the camera and wait for one ready announcement and a short tap with vibrations enabled. If tracking stalls, listen for a recovery action. Verify one ready cue after recovery. |
| [#4](https://github.com/ashhart/NearDAR/issues/4) | With hands-free off, use Where am I? and Check again. Listen for a single VoiceOver reply each time. Start hands-free and verify replies use NearDAR’s voice. |
| [#5](https://github.com/ashhart/NearDAR/issues/5) | Expand Conversation model, start the download, cancel, then retry. Listen for the status changes and verify an accessible retry if the network fails. |
| [#6](https://github.com/ashhart/NearDAR/issues/6) | Use Download and continue from a fresh test install. Swipe through the progress UI. Verify meaningful progress stops, a completion announcement, and focus on the available camera start action. |
| [#7](https://github.com/ashhart/NearDAR/issues/7) | Read setup from the beginning. Verify Point your camera, the purpose and size of the download, and the guidance about missed hazards and mobility aids. |
| [#8](https://github.com/ashhart/NearDAR/issues/8) | Swipe to Speaking speed once. Swipe up and down through the five rates. Focus stays on the slider and VoiceOver names the current rate. |
| [#9](https://github.com/ashhart/NearDAR/issues/9) | Use the headings rotor to reach Warning vibrations. Play each preview and check that the spoken direction matches the selected pattern. |
| [#10](https://github.com/ashhart/NearDAR/issues/10) | Load offline descriptions, choose Unload offline descriptions, and cancel once. Then confirm. Verify focus moves to Load offline descriptions and the model loads again from disk. |
| [#11](https://github.com/ashhart/NearDAR/issues/11) | Show the optional preview while the camera is active. Check that it tracks framing and VoiceOver skips the image. Hide it and confirm it stays hidden after stopping and restarting the camera. |
