import { useEffect, useRef } from 'react'
import { Alert, Platform, StyleSheet, View } from 'react-native'
import { VISION_MODEL } from '../../modules/tensorfold-vision/src'
import { useGuidance } from '../lib/guidance/useGuidance'
import { announce, focusAccessible } from '../lib/accessibility'
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
  const lastProgress = useRef(0)
  const restoreLoadFocus = useRef(false)
  const prepareButton = useRef<View>(null)

  useEffect(() => {
    if (Platform.OS === 'ios' && vision?.available) {
      if (previous.current !== status && !(state === 'ready' && onReady)) announce(state === 'error' && message ? `${status}. ${message}` : status)
      if (state === 'downloading') {
        const milestone = Math.floor(percentage / 25) * 25
        if (milestone > lastProgress.current && milestone < 100) announce(`Offline descriptions, ${milestone} percent downloaded.`)
        lastProgress.current = milestone
      } else {
        lastProgress.current = 0
      }
    }
    previous.current = status
  }, [message, onReady, percentage, state, status, vision?.available])

  useEffect(() => {
    if (!restoreLoadFocus.current) return
    if (state === 'installed' && prepareButton.current) {
      restoreLoadFocus.current = false
      focusAccessible(prepareButton.current)
    } else if (state === 'ready' && message) {
      restoreLoadFocus.current = false
      announce(message)
    }
  }, [message, state])

  function confirmUnload() {
    Alert.alert('Unload offline descriptions?', 'This frees memory on your phone. Your download stays on this device. Choose Load offline descriptions in Settings to use it again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unload', onPress: () => {
        restoreLoadFocus.current = true
        void unloadVisionModel()
      } },
    ])
  }

  return <View style={[styles.card, { backgroundColor: colors.panel, borderColor: colors.divider }]}>
    <View style={styles.header}>
      <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.icon, { backgroundColor: colors.raised }]}><Icon name="sparkles-outline" color={colors.accent} /></View>
      <View style={styles.details}>
        <Label>Offline descriptions</Label>
        {(state !== 'not-installed' || !vision?.available) && <Signal live={Platform.OS !== 'ios'} tone={state === 'ready' ? 'ready' : state === 'error' ? 'attention' : 'quiet'}>{status}</Signal>}
      </View>
    </View>
    {!vision?.available && vision ? <Body muted>{vision.platform === 'web' ? 'Run the visual model in NearDAR for iOS or Android.' : vision.reason || 'This phone cannot load the visual model.'}</Body>
      : state === 'ready' ? message && <Body muted>{message}</Body>
      : state === 'loading' ? <Body muted>The first load can take a moment.</Body>
      : state === 'installed' ? <Body muted>You can load it again without downloading.</Body>
      : state === 'error' ? <Body>{message || 'The visual model couldn’t start. Try again.'}</Body>
      : state !== 'downloading' && <Body muted>Download offline descriptions to recognise nearby objects and look for seats. One-time download, {size} MB.</Body>}
    {state === 'downloading' && <>
      <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.progress, { backgroundColor: colors.raised }]}>
        <View style={[styles.fill, { width: `${percentage}%`, backgroundColor: colors.accent }]} />
      </View>
      <Body muted>{percentage}% downloaded. {Math.floor((downloadedBytes ?? 0) / 1_000_000)} of {size} MB.</Body>
      <Button compact secondary label="Cancel download" onPress={() => void cancelVisionInstall()} />
    </>}
    {canPrepare && <Button hostRef={prepareButton} secondary={!onReady} icon={state === 'not-installed' ? 'download-outline' : 'play-outline'} label={action} onPress={() => void prepareVisionModel().then((ready) => { if (ready) onReady?.() })} />}
    {manageMemory && state === 'ready' && <Button compact secondary label="Unload offline descriptions" disabled={!!questionPhase} onPress={confirmUnload} />}
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
