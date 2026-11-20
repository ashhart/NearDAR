import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Keyboard, Linking, Platform, StyleSheet, Text, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import { Body, Button, Heading, Icon, Label, Screen, Signal, StatusCard, TopBar, useColors } from '../components/ui'
import { useGuidance } from '../lib/guidance/useGuidance'
import { useAppSettings } from '../lib/SettingsContext'

const actions = [
  { label: 'Find a seat', icon: 'restaurant-outline', question: 'Which seat looks free?' },
  { label: 'Find a product', icon: 'search-outline', question: null },
  { label: 'Find checkout', icon: 'card-outline', question: 'Find the checkout' },
  { label: 'What’s ahead?', icon: 'scan-outline', question: 'What is ahead?' },
  { label: 'Read text', icon: 'text-outline', question: 'Read this' },
] as const

const phases = {
  capturing: 'Capturing the view',
  'loading-model': 'Preparing offline descriptions',
  looking: 'Checking the captured view',
  answering: 'Preparing the answer',
  locating: 'Looking up your location',
}

export default function Guide() {
  const guide = useGuidance()
  const { settings } = useAppSettings()
  const colors = useColors()
  const [typing, setTyping] = useState<'question' | 'product' | null>(null)
  const [question, setQuestion] = useState('')
  const openingScreen = useRef(false)
  const typeButton = useRef<View>(null)
  const restoreFocus = useRef(false)
  const active = guide.state === 'active' || guide.state === 'degraded'
  const stopping = guide.state === 'stopping'
  const starting = guide.state === 'starting'
  const seen = !!guide.snapshot?.trackingReady
  const busy = !!guide.questionPhase
  const canAsk = active && seen && !busy
  const voiceInput = guide.voice?.onDeviceRecognition === true
  const modelState = guide.visionStatus.state
  const modelAction = modelState === 'not-installed' ? 'Get offline descriptions'
    : modelState === 'downloading' ? 'View download'
    : modelState === 'error' ? 'Fix offline descriptions' : undefined
  const depthReady = guide.snapshot?.depthState === 'ready'
  const warning = active && guide.warning && Date.now() - guide.warning.observedAt <= 3_000 ? guide.warning : undefined
  const phase = guide.questionPhase ? phases[guide.questionPhase] : guide.listening ? 'Listening. Ask your question.' : guide.speaking && active ? 'Speaking' : guide.handsFree && active ? 'Hands-free on' : undefined
  const cameraStatus = stopping ? 'Stopping camera' : starting ? 'Starting camera' : active ? 'Camera on' : 'Camera off'
  const output = guide.voice?.route === 'headphones' ? 'Headphones' : guide.voice?.route === 'speaker' && settings.speakerFallback ? 'Phone speaker' : undefined
  const reply = guide.lastReply
  const checkingProduct = reply?.errand?.kind === 'item'

  useEffect(() => {
    const target = typeButton.current
    if (typing || busy || !restoreFocus.current || !target || !active) return
    restoreFocus.current = false
    if (Platform.OS === 'web') target.focus()
    else AccessibilityInfo.sendAccessibilityEvent(target, 'focus')
  }, [active, busy, typing])

  function closeTyping() {
    restoreFocus.current = true
    Keyboard.dismiss()
    setTyping(null)
    guide.setTextEntry(false)
  }

  function submitQuestion() {
    const value = question.trim()
    if (!value || !canAsk) return
    setQuestion('')
    void guide.ask(typing === 'product' ? `Find ${value}` : value)
    closeTyping()
  }

  function openTyping(mode: 'question' | 'product' = 'question') {
    guide.setTextEntry(true)
    setTyping(mode)
  }

  function startCamera(handsFree: boolean) {
    setTyping(null)
    void guide.start(handsFree)
  }

  async function stopCamera(silent = false) {
    restoreFocus.current = false
    Keyboard.dismiss()
    setTyping(null)
    await guide.stop(silent)
  }

  async function openScreen(screen: '/settings' | '/offline') {
    if (openingScreen.current || stopping) return
    openingScreen.current = true
    try {
      if (active || starting || busy) await stopCamera(true)
      router.push(screen)
    } finally {
      openingScreen.current = false
    }
  }

  const stopControl = active || starting || stopping ? <Button
    stop
    icon="stop-circle-outline"
    label="Stop camera"
    hint="Turns off the camera and microphone."
    busy={stopping}
    onPress={() => void stopCamera()}
  /> : undefined

  return <Screen footer={stopControl}>
    <TopBar settings={() => void openScreen('/settings')} settingsDisabled={stopping} />

    <View style={[styles.welcome, { backgroundColor: colors.raised }]}>
      <View style={styles.statusRow}>
        <Signal live tone={active ? 'ready' : 'quiet'}>{cameraStatus}</Signal>
        {active && output && <View style={styles.output}><Icon name={guide.voice?.route === 'headphones' ? 'headset-outline' : 'volume-medium-outline'} color={colors.muted} size={18} /><Text style={[styles.outputText, { color: colors.muted }]}>{output}</Text></View>}
      </View>
      <Heading editorial focusOnEntry>{active ? 'How can I help?' : settings.companionName ? `Hello, ${settings.companionName}` : 'Explore nearby'}</Heading>
      <Body muted>{guide.state === 'error' ? guide.statusMessage : active ? 'Point your phone at what you want to ask about.' : 'Hear what’s nearby, find a seat or read something aloud.'}</Body>
      {active && !seen && !busy && <Body muted>Getting a clear view. Hold the phone steady for a moment.</Body>}
      {guide.voiceNotice && <Body muted live>{guide.voiceNotice}</Body>}
      {!busy && guide.voiceModelMissing && Platform.OS === 'android' && Platform.Version >= 34 &&
        <Button secondary label="Download offline speech" icon="download-outline" hint="Uses an internet connection once to prepare voice input." busy={guide.speechDownloadPending} onPress={() => void guide.downloadOfflineSpeech()} />}

      {phase && <Text aria-live="polite" style={[styles.phase, { color: colors.text }]}>{phase}</Text>}
      {busy ? <Button secondary label="Cancel question" icon="close-outline" onPress={() => void guide.stopSpeech()} /> : !active ? <>
        {voiceInput && <Button label="Start hands-free" icon="mic-outline" hint="Turns on the camera. The microphone listens again after each reply." busy={guide.startPending || stopping} onPress={() => startCamera(true)} />}
        <Button
          label={guide.state === 'error' ? 'Retry camera' : 'Start camera'}
          icon="camera-outline"
          secondary={voiceInput}
          hint="The microphone stays off until you ask by voice."
          busy={!voiceInput && (guide.startPending || stopping)}
          disabled={voiceInput && (guide.startPending || stopping)}
          onPress={() => startCamera(false)}
        />
        {guide.state === 'error' && guide.cameraPermissionBlocked && Platform.OS !== 'web' && <Button secondary label="Open phone settings" icon="settings-outline" hint="Find NearDAR and allow camera access." onPress={() => void Linking.openSettings().catch(() => {})} />}
      </> : typing ? <View style={styles.composer}>
          <Label>{typing === 'product' ? 'Find a product' : 'Type a question'}</Label>
          <TextInput
            accessibilityLabel={typing === 'product' ? 'Product name' : 'Question about this view'}
            autoFocus
            returnKeyType="send"
            onSubmitEditing={submitQuestion}
            onKeyPress={({ nativeEvent }) => { if (nativeEvent.key === 'Escape') closeTyping() }}
            maxLength={360}
            value={question}
            onChangeText={setQuestion}
            placeholder={typing === 'product' ? 'Baked beans' : 'What’s on my left?'}
            placeholderTextColor={colors.muted}
            style={[styles.input, { color: colors.text, backgroundColor: colors.panel, borderColor: colors.border }]}
          />
          <View style={styles.actions}>
            <Button compact label={typing === 'product' ? 'Find product' : 'Ask'} icon="arrow-up" disabled={!canAsk || !question.trim()} onPress={submitQuestion} />
            <Button compact secondary label="Cancel typing" onPress={closeTyping} />
          </View>
        </View> : <>
          {voiceInput && (guide.listening || guide.handsFree ? <Button secondary label="Stop listening" icon="mic-off-outline" hint="Turns off the microphone and keeps the camera on." onPress={guide.stopListeningInput} />
            : <Button label="Ask by voice" icon="mic-outline" hint="Try saying Help me find a seat." disabled={!canAsk} onPress={() => void guide.ask()} />)}
          <View style={voiceInput ? styles.actions : undefined}>
            <Button compact={voiceInput} hostRef={typeButton} secondary={voiceInput} label="Type a question" icon="create-outline" disabled={!canAsk} onPress={() => openTyping()} />
            {voiceInput && !guide.handsFree && !guide.listening && <Button compact secondary label="Enable hands-free" icon="mic-outline" disabled={!canAsk} onPress={guide.enableHandsFree} />}
          </View>
          {guide.handsFree && <Body muted>Say “What can I ask?” for examples.</Body>}
        </>}
    </View>

    {warning && <View style={[styles.warning, { backgroundColor: colors.warningSurface }]}>
      <Icon name="warning-outline" color={colors.warning} />
      <Text style={[styles.warningText, { color: colors.warning }]}>{warning.message}</Text>
    </View>}

    {reply && <StatusCard title="Last answer">
      {reply.question && <Body muted>You asked “{reply.question}”</Body>}
      <Text aria-live={guide.voice?.offlineSpeech ? undefined : 'polite'} style={[styles.answer, { color: colors.text }]}>{reply.text}</Text>
      {reply.detail && <Body muted>{reply.detail}</Body>}
      <View style={styles.actions}>
        {reply.question && (reply.source === 'location' || canAsk) && <Button compact secondary label="Check again" icon="refresh-outline" disabled={busy || starting || stopping || !!typing} hint={reply.source === 'view' ? 'Takes a fresh camera image for the same question.' : 'Looks up your location again.'} onPress={() => void guide.checkAgain()} />}
        {active && checkingProduct && <Button compact secondary label="Check the label" icon="text-outline" disabled={!canAsk || !!typing} hint="Hold one product label close to the camera." onPress={() => void guide.checkLabel()} />}
        <Button compact secondary label="Repeat answer" icon="volume-medium-outline" disabled={busy} onPress={() => void guide.repeat()} />
        {guide.speaking && <Button compact secondary label="Stop speech" icon="stop-outline" onPress={() => void guide.stopSpeech()} />}
      </View>
    </StatusCard>}

    {!!guide.shoppingList.length && <StatusCard title="Shopping list">
      {guide.shoppingList.map((item) => <Button row secondary key={item} label={item} icon="search-outline" disabled={!canAsk || !!typing} hint="Look for this item in the camera view." onPress={() => void guide.ask(`Find ${item}`)} />)}
      <Button compact secondary label="Clear shopping list" disabled={busy || !!typing} onPress={() => void guide.ask('Clear shopping list')} />
    </StatusCard>}

    <View style={styles.quick}>
      <Label>Quick questions</Label>
      <View style={[styles.list, { backgroundColor: colors.panel }]}>
        {active && actions.map(({ label, icon, question: prompt }, index) => <View key={label} style={index === 0 ? undefined : { borderTopWidth: 1, borderTopColor: colors.divider }}>
          <Button row secondary label={label} icon={icon} disabled={!canAsk || !!typing} onPress={() => prompt ? void guide.ask(prompt) : openTyping('product')} />
        </View>)}
        <View style={active ? { borderTopWidth: 1, borderTopColor: colors.divider } : undefined}>
          <Button row secondary label="Where am I?" icon="location-outline" hint="Reads your approximate location. Your phone may use the network to find an address." disabled={busy || starting || stopping || !!typing} onPress={() => void guide.ask('Where am I?')} />
        </View>
      </View>
      {active && !depthReady && seen && <Body muted>Descriptions can include direction. Distance and step estimates are unavailable.</Body>}
    </View>

    {modelState === 'loading' && <Signal live>Preparing offline descriptions</Signal>}
    {modelAction && guide.vision?.available && <Button compact secondary icon="download-outline" label={modelAction} onPress={() => void openScreen('/offline')} />}
  </Screen>
}

const styles = StyleSheet.create({
  welcome: { padding: 18, gap: 13, borderRadius: 25 },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  output: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  outputText: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  phase: { fontSize: 17, lineHeight: 24, fontWeight: '700' },
  composer: { gap: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  input: { minHeight: 56, fontSize: 19, padding: 13, borderRadius: 13, borderWidth: 1.5 },
  quick: { gap: 11 },
  list: { padding: 4, borderRadius: 19 },
  answer: { fontSize: 24, lineHeight: 32, fontWeight: '600' },
  warning: { borderRadius: 15, padding: 13, flexDirection: 'row', alignItems: 'center', gap: 10 },
  warningText: { fontSize: 17, lineHeight: 25, flex: 1 },
})
