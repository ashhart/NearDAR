import { useEffect, useRef } from 'react'
import { Alert, Platform, StyleSheet, View } from 'react-native'
import { defaultInstallSizeBytes } from '../../modules/tensorfold-engine/src'
import { VISION_MODEL } from '../../modules/tensorfold-vision/src'
import { useSatnav } from '../lib/satnav/useSatnav'
import { announce, focusAccessible } from '../lib/accessibility'
import { Body, Button, Icon, Label, Signal, useColors } from './ui'

const states = {
  'not-installed': 'Download available',
  downloading: 'Downloading model',
  installed: 'Downloaded',
  loading: 'Warming Metal GPU',
  ready: 'Ready offline',
  unloading: 'Releasing memory',
  error: 'Needs attention',
}

export function VisionModelCard({ manageMemory = false, onReady }: { manageMemory?: boolean; onReady?(): void }) {
  const colors = useColors()
  const { vision, visionStatus, usingTensorFoldEngine, prepareVisionModel, cancelVisionInstall, unloadVisionModel, thinking } = useSatnav()
  const { state, downloadedBytes, totalBytes, progress, message } = visionStatus
  const expectedBytes = totalBytes ?? vision?.installSizeBytes ?? (usingTensorFoldEngine ? defaultInstallSizeBytes : VISION_MODEL.sizeBytes)
  const sizeLabel = expectedBytes >= 1_000_000_000
    ? `${(expectedBytes / 1_000_000_000).toFixed(1)} GB`
    : `${Math.round(expectedBytes / 1_000_000)} MB`
  const title = usingTensorFoldEngine ? 'TensorFold Mobile (LFM3-VL-2B)' : 'On-device vision (SmolVLM2)'
  const percentage = Math.round(Math.max(0, Math.min(1, progress ?? 0)) * 100)
  const canPrepare = vision?.available && (state === 'not-installed' || state === 'installed' || state === 'error')
  const action = onReady
    ? state === 'installed' ? 'Load and continue' : state === 'error' ? 'Try setup again' : 'Download and continue'
    : state === 'installed' ? 'Load TensorFold' : state === 'error' ? 'Retry download' : 'Download TensorFold'
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
        if (milestone > lastProgress.current && milestone < 100) announce(`TensorFold Mobile, ${milestone} percent downloaded.`)
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
    Alert.alert('Unload TensorFold from memory?', 'This frees GPU memory on your phone. Your downloaded weights stay on this device and can be reloaded anytime.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unload',
        onPress: () => {
          restoreLoadFocus.current = true
          void unloadVisionModel()
        },
      },
    ])
  }

  return <View style={[styles.card, { backgroundColor: colors.panel, borderColor: colors.divider }]}>
    <View style={styles.header}>
      <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.icon, { backgroundColor: colors.raised }]}><Icon name="sparkles-outline" color={colors.accent} /></View>
      <View style={styles.details}>
        <Label>{title}</Label>
        {(state !== 'not-installed' || !vision?.available) && <Signal live={Platform.OS !== 'ios'} tone={state === 'ready' ? 'ready' : state === 'error' ? 'attention' : 'quiet'}>{status}</Signal>}
      </View>
    </View>
    {!vision?.available && vision ? <Body muted>{vision.platform === 'web' ? 'Run TensorFold Mobile in NearDar for iOS or Android.' : vision.reason || 'This phone cannot load the on-device vision engine.'}</Body>
      : state === 'ready' ? <Body muted>{message || (usingTensorFoldEngine ? 'Native TensorFold Metal vision + conversation engine is warm and ready offline.' : 'On-device vision is warm and ready offline.')}</Body>
      : state === 'loading' ? <Body muted>Loading weights onto Apple Metal GPU…</Body>
      : state === 'installed' ? <Body muted>Downloaded locally. Warms automatically when satnav starts.</Body>
      : state === 'error' ? <Body>{message || 'TensorFold Mobile could not start. Try again.'}</Body>
      : state !== 'downloading' && <Body muted>Native TensorFold vision and conversation engine running 100% on-device. One-time download, {sizeLabel}.</Body>}
    {state === 'downloading' && <>
      <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.progress, { backgroundColor: colors.raised }]}>
        <View style={[styles.fill, { width: `${percentage}%`, backgroundColor: colors.accent }]} />
      </View>
      <Body muted>{percentage}% downloaded. {Math.floor((downloadedBytes ?? 0) / 1_000_000)} of {Math.round(expectedBytes / 1_000_000)} MB.</Body>
      <Button compact secondary label="Cancel download" onPress={() => void cancelVisionInstall()} />
    </>}
    {canPrepare && <Button hostRef={prepareButton} secondary={!onReady} icon={state === 'not-installed' ? 'download-outline' : 'play-outline'} label={action} onPress={() => void prepareVisionModel().then((ready) => { if (ready) onReady?.() })} />}
    {manageMemory && state === 'ready' && <Button compact secondary label="Unload from GPU memory" disabled={thinking} onPress={confirmUnload} />}
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
