import { useEffect, useRef } from 'react'
import { AccessibilityInfo, Platform, StyleSheet, View } from 'react-native'
import { VISION_MODEL } from '../../modules/tensorfold-vision/src'
import { useGuidance } from '../lib/guidance/useGuidance'
import { Body, Button, Icon, Label, Signal, useColors } from './ui'

const states = {
  'not-installed': 'Download available',
  downloading: 'Downloading offline descriptions',
  installed: 'Downloaded',
  loading: 'Getting offline descriptions ready',
  ready: 'Ready to use offline',
  unloading: 'Releasing memory',
  error: 'Offline descriptions need attention',
}

export function VisionModelCard({ manageMemory = false, onReady }: { manageMemory?: boolean; onReady?(): void }) {
  const colors = useColors()
  const { vision, visionStatus, prepareVisionModel, cancelVisionInstall, unloadVisionModel, questionPhase } = useGuidance()
  const { state, downloadedBytes, totalBytes, progress, message } = visionStatus
  const size = Math.round((totalBytes ?? VISION_MODEL.sizeBytes) / 1_000_000)
  const percentage = Math.round(Math.max(0, Math.min(1, progress ?? 0)) * 100)
  const canPrepare = vision?.available && (state === 'not-installed' || state === 'installed' || state === 'error')
  const action = onReady
    ? state === 'installed' ? 'Load and continue' : state === 'error' ? 'Try setup again' : 'Download and continue'
    : state === 'installed' ? 'Load offline descriptions' : state === 'error' ? 'Retry offline descriptions' : 'Download offline descriptions'
  const status = !vision ? 'Checking this device' : vision.platform === 'web' ? 'Available in the mobile app' : !vision.available ? 'Unavailable on this device' : states[state]
  const previous = useRef(status)

  useEffect(() => {
    if (Platform.OS === 'ios' && previous.current !== status && vision?.available) {
      AccessibilityInfo.announceForAccessibilityWithOptions(status, { queue: true })
    }
    previous.current = status
  }, [status, vision?.available])

  return <View style={[styles.card, { backgroundColor: colors.panel, borderColor: colors.divider }]}>
    <View style={styles.header}>
      <View style={[styles.icon, { backgroundColor: colors.raised }]}><Icon name="sparkles-outline" color={colors.accent} /></View>
      <View style={styles.details}>
        <Label>Offline descriptions</Label>
        {(state !== 'not-installed' || !vision?.available) && <Signal live tone={state === 'ready' ? 'ready' : state === 'error' ? 'attention' : 'quiet'}>{status}</Signal>}
      </View>
    </View>
    {!vision?.available && vision ? <Body muted>{vision.platform === 'web' ? 'Run the visual model in NearDAR for iOS or Android.' : vision.reason || 'This phone cannot load the visual model.'}</Body>
      : state === 'ready' ? null
      : state === 'loading' ? <Body muted>The first load can take a moment.</Body>
      : state === 'installed' ? <Body muted>You can load it again without downloading.</Body>
      : state === 'error' ? <Body>{message || 'The visual model couldn’t start. Try again.'}</Body>
      : state !== 'downloading' && <Body muted>Download {size} MB once to recognise objects and look for seats on your phone.</Body>}
    {state === 'downloading' && <>
      <View accessibilityRole="progressbar" accessibilityLabel="Offline descriptions download" accessibilityValue={{ min: 0, max: 100, now: percentage }} style={[styles.progress, { backgroundColor: colors.raised }]}>
        <View style={[styles.fill, { width: `${percentage}%`, backgroundColor: colors.accent }]} />
      </View>
      <Body muted>{Math.floor((downloadedBytes ?? 0) / 1_000_000)} of {size} MB</Body>
      <Button compact secondary label="Cancel download" onPress={() => void cancelVisionInstall()} />
    </>}
    {canPrepare && <Button secondary={!onReady} icon={state === 'not-installed' ? 'download-outline' : 'play-outline'} label={action} onPress={() => void prepareVisionModel().then((ready) => { if (ready) onReady?.() })} />}
    {manageMemory && state === 'ready' && <Button compact secondary label="Free model memory" disabled={!!questionPhase} onPress={() => void unloadVisionModel()} />}
  </View>
}

const styles = StyleSheet.create({
  card: { padding: 16, gap: 12, borderRadius: 21, borderWidth: 1 },
  header: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  icon: { width: 45, height: 45, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  details: { flex: 1, gap: 3 },
  progress: { height: 8, borderRadius: 4, overflow: 'hidden' },
  fill: { height: '100%' },
})
