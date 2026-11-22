import { useState } from 'react'
import { AccessibilityInfo, StyleSheet, Switch, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import * as Haptics from '../../modules/tensorfold-haptics/src'
import { Body, Button, Heading, Screen, StatusCard, TopBar, useColors } from '../components/ui'
import { VisionModelCard } from '../components/VisionModelCard'
import { useAppSettings } from '../lib/SettingsContext'
import { useGuidance } from '../lib/guidance/useGuidance'

function Toggle({ label, caption, value, onChange }: { label: string; caption: string; value: boolean; onChange(value: boolean): void }) {
  const colors = useColors()
  return <View style={styles.toggle}>
    <View style={styles.toggleText}><Body>{label}</Body><Body muted>{caption}</Body></View>
    <Switch accessibilityLabel={label} value={value} onValueChange={onChange} trackColor={{ true: colors.accent, false: colors.border }} thumbColor={colors.panel} />
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
  const currentVoice = voices.find(voice => voice.id === settings.voiceIdentifier)
  const model = guide.engineStatus
  const engineBusy = model.state === 'loading' || model.state === 'unloading' || !!guide.questionPhase

  async function testHaptics(direction: 'ahead' | 'left' | 'right' | 'behind') {
    try {
      const result = await Haptics.play({ direction, severity: 'caution' })
      const message = result.status === 'played' ? `Pattern played for ${direction}.` : result.reason || 'Haptics are unavailable.'
      setTestMessage(message)
      AccessibilityInfo.announceForAccessibility(message)
    } catch (error) {
      setTestMessage(error instanceof Error ? error.message : 'Could not play the pattern.')
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
          label={`NearDAR speaking voice, ${currentVoice ? currentVoice.name + ', ' + currentVoice.language : 'System default'}`}
          onPress={() => setShowVoices(!showVoices)} />
        {showVoices && <>
          <Body muted>Hands-free replies use this voice. With hands-free off, VoiceOver reads replies in your VoiceOver voice.</Body>
          <TextInput accessibilityLabel="Search voices by name or language" placeholder="Search voices"
            value={voiceSearch} onChangeText={setVoiceSearch} style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
          <Button compact secondary label="System default" selected={!currentVoice} onPress={() => void update({ voiceIdentifier: undefined })} />
          {voices.filter(voice => (voice.name + ' ' + voice.language).toLowerCase().includes(voiceSearch.trim().toLowerCase())).map(voice =>
            <Button key={voice.id} compact secondary label={voice.name + ', ' + voice.language} selected={voice.id === settings.voiceIdentifier}
              onPress={() => void update({ voiceIdentifier: voice.id })} />)}
        </>}
      </>}
      <Body>Speaking speed</Body>
      <View style={styles.options}>
        {[0.6, 0.8, 1, 1.25, 1.5].map((speechRate) => <Button compact key={speechRate} secondary={settings.speechRate !== speechRate} selected={settings.speechRate === speechRate} label={`${speechRate}×`} hint={`${speechRate} times normal voice speed`} onPress={() => void update({ speechRate })} />)}
      </View>
      {guide.voice?.reason && <Body muted>{guide.voice.reason}</Body>}
    </StatusCard>

    <StatusCard title="Alerts and distance">
      <Toggle label="Warning vibrations" caption="Pair hazard alerts with vibration patterns." value={settings.urgentHaptics} onChange={(urgentHaptics) => void update({ urgentHaptics })} />
      <View style={styles.options}>
        {(['ahead', 'left', 'right', 'behind'] as const).map((direction) => <Button compact secondary key={direction} label={`Feel ${direction}`} onPress={() => void testHaptics(direction)} />)}
      </View>
      {!!testMessage && <Body muted>{testMessage}</Body>}
      <Body>Estimated step length</Body>
      <View style={styles.options}>
        {[0.5, 0.65, 0.75, 0.9].map((stepLengthMeters) => <Button compact key={stepLengthMeters} secondary={settings.stepLengthMeters !== stepLengthMeters} selected={settings.stepLengthMeters === stepLengthMeters} label={`${stepLengthMeters.toFixed(2)} m`} onPress={() => void update({ stepLengthMeters })} />)}
      </View>
    </StatusCard>

    {guide.engine?.available && <>
      <Button compact secondary label={showConversation ? 'Hide conversation model' : 'Conversation model'} icon="chatbubble-outline" onPress={() => setShowConversation(!showConversation)} />
      {showConversation && <StatusCard title="TensorFold conversation">
        <Body muted>Optional. Answers open questions using available scene facts. The download is about 1.75 GB.</Body>
        <Body>{model.message || (model.state === 'ready' ? 'Ready on this phone.' : model.state === 'installed' ? 'Downloaded.' : 'Download and load to enable.')}</Body>
        {model.state === 'downloading' && <>
          <Body>{Math.round((model.downloadedBytes ?? 0) / 1_000_000)} of {Math.round((model.totalBytes ?? 1_749_077_616) / 1_000_000)} MB</Body>
          <Button compact secondary label="Cancel conversation download" onPress={() => void guide.cancelModelInstall()} />
        </>}
        {(model.state === 'not-installed' || model.state === 'error') && <Button compact secondary label="Download conversation model" disabled={engineBusy} onPress={() => void guide.installModel()} />}
        {(model.state === 'installed' || (model.state === 'error' && !!model.installationId)) && <Button compact secondary label="Load conversation model" disabled={engineBusy} onPress={() => void guide.loadModel()} />}
        {model.state === 'ready' && <Button compact secondary label="Free conversation memory" disabled={engineBusy} onPress={() => void guide.unloadModel()} />}
      </StatusCard>}
    </>}

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
})
