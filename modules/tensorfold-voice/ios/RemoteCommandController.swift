import Foundation
import MediaPlayer

final class RemoteCommandController {
  private(set) var isEnabled = false
  var onTrigger: ((String) -> Void)?

  private var targets: [(command: MPRemoteCommand, token: Any)] = []
  private var lastTitle = "NearDar"
  private var lastSubtitle = "Hands-free walking guidance"
  private var lastTriggerAction: String?
  private var lastTriggerTime: TimeInterval = 0

  func setEnabled(_ enabled: Bool) {
    guard enabled != isEnabled else {
      if enabled {
        publishNowPlaying()
      }
      return
    }

    isEnabled = enabled
    if enabled {
      let center = MPRemoteCommandCenter.shared()
      // Single click on AirPods stem / wired earbud / Lock Screen play-pause starts or stops talking.
      register(center.togglePlayPauseCommand, action: "talk")
      register(center.playCommand, action: "talk")
      register(center.pauseCommand, action: "talk")
      // Double click on AirPods stem / Lock Screen next track scans ahead.
      register(center.nextTrackCommand, action: "scan")
      // Triple click on AirPods stem / Lock Screen previous track runs calm "Orient me" briefing.
      register(center.previousTrackCommand, action: "orient")
      publishNowPlaying()
    } else {
      teardownTargets()
      let nowPlaying = MPNowPlayingInfoCenter.default()
      nowPlaying.nowPlayingInfo = nil
      nowPlaying.playbackState = .stopped
    }
  }

  func updateNowPlaying(title: String, subtitle: String) {
    let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedSubtitle = subtitle.trimmingCharacters(in: .whitespacesAndNewlines)
    lastTitle = trimmedTitle.isEmpty ? "NearDar" : trimmedTitle
    lastSubtitle = trimmedSubtitle.isEmpty ? "Hands-free walking guidance" : trimmedSubtitle
    guard isEnabled else { return }
    publishNowPlaying()
  }

  private func register(_ command: MPRemoteCommand, action: String) {
    command.isEnabled = true
    let token = command.addTarget { [weak self] _ in
      guard let self, self.isEnabled else { return .commandFailed }
      self.handleTrigger(action)
      return .success
    }
    targets.append((command: command, token: token))
  }

  private func teardownTargets() {
    for entry in targets {
      entry.command.removeTarget(entry.token)
      entry.command.isEnabled = false
    }
    targets.removeAll()
  }

  private func publishNowPlaying() {
    let info: [String: Any] = [
      MPMediaItemPropertyTitle: lastTitle,
      MPMediaItemPropertyArtist: lastSubtitle,
      MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
      MPNowPlayingInfoPropertyIsLiveStream: true,
      MPNowPlayingInfoPropertyPlaybackRate: 1.0
    ]
    let center = MPNowPlayingInfoCenter.default()
    center.nowPlayingInfo = info
    center.playbackState = .playing
  }

  private func handleTrigger(_ action: String) {
    let deliver = { [weak self] in
      guard let self, self.isEnabled else { return }
      let now = ProcessInfo.processInfo.systemUptime
      if self.lastTriggerAction == action, (now - self.lastTriggerTime) < 0.2 {
        return
      }
      self.lastTriggerAction = action
      self.lastTriggerTime = now
      self.onTrigger?(action)
    }
    if Thread.isMainThread {
      deliver()
    } else {
      DispatchQueue.main.async(execute: deliver)
    }
  }
}
