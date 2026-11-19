import { useState } from 'react'
import { AccessibilityInfo, View } from 'react-native'
import { router } from 'expo-router'
import { Body, Button, Heading, Label, Screen, StatusCard } from '../components/ui'
import { useAppSettings } from '../lib/SettingsContext'
import { useGuidance } from '../lib/guidance/useGuidance'
import type { EngineStatus } from '../lib/guidance/types'
import * as Haptics from '../../modules/tensorfold-haptics/src'

const statusNames: Record<EngineStatus['state'], string> = {
  'not-installed': 'Not installed', downloading: 'Downloading', installed: 'Installed, not loaded',
  loading: 'Loading', ready: 'Ready on this device', unloading: 'Unloading', error: 'Needs attention',
}

function statusText(status: EngineStatus) {
  return status.message || statusNames[status.state]
}

export default function Settings() {
  const { settings, update } = useAppSettings()
  const guide = useGuidance()
  const [hapticMessage, setHapticMessage] = useState('')
  const [showModels, setShowModels] = useState(false)

  return <Screen>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <Heading small>Settings</Heading>
      <Button compact secondary label="Back to Sonar" onPress={() => router.back()} />
    </View>

    <StatusCard title="Audio">
      <Body>{guide.voice?.route === 'headphones' ? 'AirPods or headphones connected' : guide.voice?.route === 'speaker' ? 'Using the phone speaker' : 'Choose how Sonar speaks to you.'}</Body>
      <Body muted>{settings.speakerFallback ? 'Automatic uses AirPods when connected and your phone speaker otherwise.' : 'Headphones only pauses guidance if your headphones disconnect.'}</Body>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ flex: 1 }}><Button secondary={!settings.speakerFallback} label="Automatic" onPress={() => void update({ speakerFallback: true })} /></View>
        <View style={{ flex: 1 }}><Button secondary={settings.speakerFallback} label="Headphones only" onPress={() => void update({ speakerFallback: false })} /></View>
      </View>
      {guide.voice?.reason ? <Body muted>{guide.voice.reason}</Body> : null}
    </StatusCard>

    <StatusCard title="Hands-free">
      <Body>{settings.continuousListening ? 'Speak naturally after each answer. No tap needed.' : 'Tap Ask by voice each time you want to speak.'}</Body>
      <Button secondary={!settings.continuousListening} label={settings.continuousListening ? 'Continuous listening on' : 'Continuous listening off'} onPress={() => void update({ continuousListening: !settings.continuousListening })} />
    </StatusCard>

    <StatusCard title="Voice pace">
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {[0.6, 0.8, 1, 1.25, 1.5].map((value) => <Button compact key={value} secondary={settings.speechRate !== value} label={`${value} times`} onPress={() => void update({ speechRate: value })} />)}
      </View>
    </StatusCard>

    <StatusCard title="Step estimate">
      <Body muted>Sonar converts measured distance using your step length. This is always an estimate.</Body>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {[0.5, 0.65, 0.75, 0.9].map((value) => <Button compact key={value} secondary={settings.stepLengthMeters !== value} label={`${value.toFixed(2)} m`} onPress={() => void update({ stepLengthMeters: value })} />)}
      </View>
    </StatusCard>

    <StatusCard title="Directional haptics">
      <Body muted>Practice the rhythms while stationary. Speech always carries the same direction.</Body>
      {hapticMessage ? <Body>{hapticMessage}</Body> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {(['ahead', 'left', 'right', 'behind'] as const).map((direction) => <Button compact key={direction} secondary label={`Feel ${direction}`} onPress={() => void Haptics.play({ direction, severity: 'caution' }).then((result) => {
          const message = result.status === 'played' ? `${direction} pattern played${result.amplitudeControl === false ? ' without intensity control' : ''}` : result.reason || 'Haptics are unavailable on this device.'
          setHapticMessage(message)
          AccessibilityInfo.announceForAccessibility(message)
        }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Haptic playback failed.'
          setHapticMessage(message)
          AccessibilityInfo.announceForAccessibility(message)
        })} />)}
      </View>
      <Button secondary={!settings.urgentHaptics} label={settings.urgentHaptics ? 'Warning haptics on' : 'Warning haptics off'} onPress={() => void update({ urgentHaptics: !settings.urgentHaptics })} />
    </StatusCard>

    <Button secondary label={showModels ? 'Hide on-device models' : 'On-device models'} onPress={() => setShowModels(!showModels)} />
    {showModels && <StatusCard title="On-device models">
      <Body muted>Downloads use the network. After installation, inference stays on your device. Sensor guidance works without these models.</Body>
      <View style={{ gap: 10 }}>
        <Label>Conversation</Label>
        <Body>{statusText(guide.engineStatus)}</Body>
        {guide.engineStatus.totalBytes ? <Body muted>{Math.round((guide.engineStatus.downloadedBytes || 0) / 1_000_000)} of {Math.round(guide.engineStatus.totalBytes / 1_000_000)} MB</Body> : null}
        {guide.engineStatus.state === 'not-installed' || guide.engineStatus.state === 'error' ? <Button label="Download conversation" onPress={() => void guide.installModel()} /> : null}
        {guide.engineStatus.state === 'downloading' ? <Button secondary label="Cancel download" onPress={() => void guide.cancelModelInstall()} /> : null}
        {guide.engineStatus.state === 'installed' || (guide.engineStatus.state === 'error' && guide.engineStatus.installationId) ? <Button label="Load conversation" onPress={() => void guide.loadModel()} /> : null}
        {guide.engineStatus.state === 'loading' ? <Button label="Loading conversation" busy onPress={() => void guide.loadModel()} /> : null}
        {guide.engineStatus.state === 'ready' ? <Button secondary label="Unload conversation" onPress={() => void guide.unloadModel()} /> : null}
      </View>
      <View style={{ gap: 10 }}>
        <Label>Visual labels</Label>
        <Body>{statusText(guide.visionStatus)}</Body>
        {guide.visionStatus.totalBytes ? <Body muted>{Math.round((guide.visionStatus.downloadedBytes || 0) / 1_000_000)} of {Math.round(guide.visionStatus.totalBytes / 1_000_000)} MB</Body> : null}
        {guide.vision && !guide.vision.available ? <Body muted>{guide.vision.reason}</Body> : null}
        {guide.visionStatus.state === 'not-installed' || guide.visionStatus.state === 'error' ? <Button label="Download visual model" onPress={() => void guide.installVisionModel()} /> : null}
        {guide.visionStatus.state === 'downloading' ? <Button secondary label="Cancel download" onPress={() => void guide.cancelVisionInstall()} /> : null}
        {guide.visionStatus.state === 'installed' || (guide.visionStatus.state === 'error' && guide.visionStatus.installationId) ? <Button label="Load visual model" onPress={() => void guide.loadVisionModel()} /> : null}
        {guide.visionStatus.state === 'loading' ? <Button label="Loading visual model" busy onPress={() => void guide.loadVisionModel()} /> : null}
        {guide.visionStatus.state === 'ready' ? <Button secondary label="Unload visual model" onPress={() => void guide.unloadVisionModel()} /> : null}
      </View>
    </StatusCard>}

    <StatusCard title="Privacy and limits">
      <Body>No continuous images, videos, or voice recordings are uploaded or saved. One frozen frame is released after each visual question.</Body>
      <Body muted>Sonar can miss hazards. Keep using your usual mobility aid.</Body>
    </StatusCard>
    <Button compact secondary label="Repeat spoken setup" onPress={() => {
      void update({ onboardingComplete: false }).then(() => router.replace('/setup'))
    }} />
  </Screen>
}
