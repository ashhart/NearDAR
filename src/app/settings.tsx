import { useEffect, useRef, useState } from 'react'
import { Platform, StyleSheet, Switch, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import * as Haptics from '../../modules/tensorfold-haptics/src'
import { Body, Button, Heading, Screen, StatusCard, TopBar, useColors } from '../components/ui'
import { VisionModelCard } from '../components/VisionModelCard'
import { useAppSettings } from '../lib/SettingsContext'
import { useGuidance } from '../lib/guidance/useGuidance'
import { announce } from '../lib/accessibility'

function Toggle({ label, caption, value, onChange }: { label: string; caption: string; value: boolean; onChange(value: boolean): void }) {
  const colors = useColors()
  return <View style={styles.toggle}>
    <View style={styles.toggleText}><Body>{label}</Body><Body muted>{caption}</Body></View>
    <Switch accessibilityLabel={label} value={value} onValueChange={onChange} trackColor={{ true: colors.accent, false: colors.border }} thumbColor={colors.panel} />
  </View>
}

const speechRates = [0.6, 0.8, 1, 1.25, 1.5] as const

function SpeakingSpeed({ value, onChange }: { value: number; onChange(value: number): void }) {
  const colors = useColors()
  const [dragging, setDragging] = useState<number>()
  const pending = useRef<number | undefined>(undefined)
  const trackWidth = useRef(0)
  const last = speechRates.length - 1
  const selected = speechRates.reduce((best, rate, index) => Math.abs(rate - value) < Math.abs(speechRates[best]! - value) ? index : best, 0)
  const index = dragging ?? selected
  const portion = `${index * 100 / last}%` as const
  const speed = speechRates[index]!

  function pick(locationX: number) {
    if (!trackWidth.current) return
    pending.current = Math.max(0, Math.min(last, Math.round(locationX * last / trackWidth.current)))
    setDragging(pending.current)
  }

  function adjust(step: number) {
    onChange(speechRates[Math.max(0, Math.min(last, selected + step))]!)
  }

  const keyboard = Platform.OS === 'web' ? {
    tabIndex: 0 as const,
    onKeyDown(event: { key: string; preventDefault(): void }) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') adjust(-1)
      else if (event.key === 'ArrowUp' || event.key === 'ArrowRight') adjust(1)
      else if (event.key === 'Home') onChange(speechRates[0])
      else if (event.key === 'End') onChange(speechRates[last]!)
      else return
      event.preventDefault()
    },
  } : undefined

  return <View
    {...keyboard}
    accessible accessibilityRole="adjustable" accessibilityLabel="Speaking speed"
    accessibilityValue={{ min: 0, max: last, now: index, text: speed === 1 ? 'Normal speed' : `${speed} times normal speed` }}
    accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
    onAccessibilityAction={({ nativeEvent }) => {
      if (nativeEvent.actionName === 'increment') adjust(1)
      if (nativeEvent.actionName === 'decrement') adjust(-1)
    }}
    onLayout={({ nativeEvent }) => { trackWidth.current = nativeEvent.layout.width }}
    onStartShouldSetResponder={() => true}
    onResponderGrant={({ nativeEvent }) => pick(nativeEvent.locationX)}
    onResponderMove={({ nativeEvent }) => pick(nativeEvent.locationX)}
    onResponderRelease={() => {
      if (pending.current !== undefined) onChange(speechRates[pending.current]!)
      pending.current = undefined
      setDragging(undefined)
    }}
    onResponderTerminate={() => { pending.current = undefined; setDragging(undefined) }}
    style={styles.slider}
  >
    <View pointerEvents="none" aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.sliderContents}>
      <View style={styles.sliderLabels}><Body>Speaking speed</Body><Body muted>{speed}×</Body></View>
      <View style={[styles.sliderTrack, { backgroundColor: colors.border }]}>
        <View style={[styles.sliderFill, { width: portion, backgroundColor: colors.accent }]} />
        <View style={[styles.sliderThumb, { left: portion, backgroundColor: colors.accent }]} />
      </View>
    </View>
  </View>
}

export default function Settings() {
  const colors = useColors()
  const { settings, update, saveError } = useAppSettings()
  const guide = useGuidance()
  const [name, setName] = useState(settings.companionName)
  const [testMessage, setTestMessage] = useState('')
  const [showConversation, setShowConversation] = useState(false)
  const [showVoices, setShowVoices] = useState(false)
  const [voiceSearch, setVoiceSearch] = useState('')
  const voices = guide.voice?.installedVoices ?? []
  const currentVoice = voices.find(({ id }) => id === settings.voiceIdentifier)
  const query = voiceSearch.trim().toLocaleLowerCase()
  const matchingVoices = voices.filter(({ name, language }) => `${name} ${language}`.toLocaleLowerCase().includes(query))
  const model = guide.engineStatus
  const previousModel = useRef(model.state)
  const engineBusy = model.state === 'loading' || model.state === 'unloading' || !!guide.questionPhase

  useEffect(() => {
    const previous = previousModel.current
    previousModel.current = model.state
    if (!showConversation || previous === model.state) return
    if (model.state === 'downloading') announce('Downloading the conversation model.')
    if (model.state === 'installed' && previous === 'downloading') announce('Conversation model downloaded. It is ready to use offline.')
    if (model.state === 'error') announce(`Conversation model download failed. ${model.message ?? 'Try downloading again.'}`)
    if (previous === 'downloading' && model.state === 'not-installed' && model.message) announce(model.message)
  }, [model.message, model.state, showConversation])

  async function testHaptics(direction: 'ahead' | 'left' | 'right' | 'behind') {
    try {
      const result = await Haptics.play({ direction, severity: 'caution' })
      const message = result.status === 'played' ? `Pattern played for ${direction}.` : result.reason || 'Haptics are unavailable.'
      setTestMessage(message)
      announce(message)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not play the pattern.'
      setTestMessage(message)
      announce(message)
    }
  }

  return <Screen>
    <TopBar back={() => router.canGoBack() ? router.back() : router.replace('/guide')} />
    <View style={styles.title}>
      <Heading editorial focusOnEntry>Settings</Heading>
    </View>

    <VisionModelCard manageMemory />

    <StatusCard title="Your companion">
      <Body muted>Choose what NearDAR calls you. Your name and preferences stay on your phone.</Body>
      <TextInput
        accessibilityLabel="Your preferred name"
        autoComplete="off"
        maxLength={40}
        value={name}
        onChangeText={setName}
        placeholder="Your preferred name"
        placeholderTextColor={colors.muted}
        style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
      />
      <View style={styles.options}>
        <Button compact label="Save name" disabled={!name.trim() || name.trim() === settings.companionName} onPress={() => void update({ companionName: name })} />
        {!!settings.companionName && <Button compact secondary label="Forget name" onPress={() => { setName(''); void update({ companionName: '' }) }} />}
      </View>
      {saveError && <Body>{saveError}</Body>}
    </StatusCard>

    <StatusCard title="Voice and audio">
      <Toggle label="Hands-free after Ask by voice" caption="Keep listening after each reply until you turn off the microphone." value={settings.continuousListening} onChange={(continuousListening) => void update({ continuousListening })} />
      <Toggle label="Use phone speaker without headphones" caption="When off, losing headphones pauses guidance." value={settings.speakerFallback} onChange={(speakerFallback) => void update({ speakerFallback })} />
      {voices.length > 0 && <>
        <Button compact secondary expanded={showVoices}
          label={`NearDAR speaking voice, ${currentVoice?.name ?? 'System default'}`}
          onPress={() => setShowVoices(!showVoices)} />
        {showVoices && <>
          <Body muted>Hands-free replies use this voice. VoiceOver reads ordinary replies when hands-free is off.</Body>
          <TextInput accessibilityLabel="Search voices by name or language" placeholder="Search voices"
            value={voiceSearch} onChangeText={setVoiceSearch}
            style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]} />
          <Button compact secondary label="System default" selected={!currentVoice} onPress={() => void update({ voiceIdentifier: undefined })} />
          {!matchingVoices.length && <Body muted>No voices match your search.</Body>}
          {matchingVoices.map(({ id, name, language }) =>
            <Button key={id} compact secondary label={`${name}, ${language}`} selected={id === settings.voiceIdentifier}
              onPress={() => void update({ voiceIdentifier: id })} />)}
        </>}
      </>}
      <SpeakingSpeed value={settings.speechRate} onChange={(speechRate) => void update({ speechRate })} />
      {guide.voice?.reason && <Body muted>{guide.voice.reason}</Body>}
    </StatusCard>

    <StatusCard title="Warning vibrations">
      <Toggle label="Use vibrations" caption="The patterns help you recognise which direction a warning refers to." value={settings.urgentHaptics} onChange={(urgentHaptics) => void update({ urgentHaptics })} />
      <View style={styles.options}>
        {(['left', 'right', 'ahead', 'behind'] as const).map((direction) => <Button compact secondary key={direction} label={`Preview ${direction}`} onPress={() => void testHaptics(direction)} />)}
      </View>
      {!!testMessage && <Body muted>{testMessage}</Body>}
    </StatusCard>

    <StatusCard title="Distance">
      <Body>Estimated step length</Body>
      <View style={styles.options}>
        {[0.5, 0.65, 0.75, 0.9].map((stepLengthMeters) => <Button compact key={stepLengthMeters} secondary={settings.stepLengthMeters !== stepLengthMeters} selected={settings.stepLengthMeters === stepLengthMeters} label={`${stepLengthMeters.toFixed(2)} m`} onPress={() => void update({ stepLengthMeters })} />)}
      </View>
    </StatusCard>

    {guide.engine?.available && <StatusCard title="TensorFold conversation">
      <Button compact secondary label={showConversation ? 'Hide conversation model' : 'Conversation model'} expanded={showConversation} onPress={() => setShowConversation(!showConversation)} />
      {showConversation && <>
        <Body muted>Answers open questions about the camera view on your phone. Download it once to use it automatically when the app has enough information.</Body>
        <Body>{model.message || (model.state === 'ready' || model.state === 'installed' ? 'Ready to use offline.' : 'About 1.75 GB.')}</Body>
        {model.state === 'downloading' && <>
          <Body>{Math.round((model.downloadedBytes ?? 0) / 1_000_000)} of {Math.round((model.totalBytes ?? 1_749_077_616) / 1_000_000)} MB</Body>
          <Button compact secondary label="Cancel conversation download" onPress={() => void guide.cancelModelInstall()} />
        </>}
        {(model.state === 'not-installed' || (model.state === 'error' && !model.installationId)) && <Button compact secondary label={model.state === 'error' ? 'Retry conversation download' : 'Download conversation model'} icon="download-outline" disabled={engineBusy} onPress={() => void guide.installModel()} />}
      </>}
    </StatusCard>}

    <StatusCard title="Privacy">
      <Body muted>NearDAR processes camera and voice on your phone. It releases each captured image after answering. “Where am I?” uses location only on request. Your phone may use the network to find an address.</Body>
      <Button compact secondary label="Repeat spoken setup" onPress={() => void update({ onboardingComplete: false }).then(() => router.replace('/setup'))} />
    </StatusCard>
  </Screen>
}

const styles = StyleSheet.create({
  title: { gap: 8 },
  toggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14 },
  toggleText: { flex: 1, gap: 3 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: { minHeight: 55, fontSize: 18, padding: 12, borderRadius: 12, borderWidth: 1.5 },
  slider: { minHeight: 56, paddingBottom: 12 },
  sliderContents: { gap: 12 },
  sliderLabels: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  sliderTrack: { marginHorizontal: 9, height: 6, borderRadius: 3 },
  sliderFill: { height: 6, borderRadius: 3 },
  sliderThumb: { position: 'absolute', top: -6, marginLeft: -9, width: 18, height: 18, borderRadius: 9 },
})
