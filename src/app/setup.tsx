import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { router } from 'expo-router'
import { useAppSettings } from '../lib/SettingsContext'
import { Body, Button, Heading, Label, Screen, SonarMark, StatusCard } from '../components/ui'
import * as Voice from '../../modules/tensorfold-voice/src'

export default function Setup() {
  const { settings, update } = useAppSettings()
  const [speechError, setSpeechError] = useState<string | null>(null)

  useEffect(() => {
    void Voice.speak('Welcome to Sonar. Point your camera and ask what is around you. Use AirPods, headphones, or your phone speaker. Keep using your usual mobility aid. Start Sonar when you are ready.', {
      rate: settings.speechRate, priority: 'answer', interrupt: true, speakerFallback: settings.speakerFallback,
    }).catch((error: unknown) => setSpeechError(error instanceof Error ? error.message : 'Spoken setup is unavailable.'))
    return () => { void Voice.stopSpeaking().catch(() => {}) }
  }, [settings.speechRate, settings.speakerFallback])

  async function finish() {
    await update({ onboardingComplete: true })
    router.replace('/guide')
  }

  return <Screen>
    <Heading small>Sonar</Heading>
    <View style={{ alignItems: 'center', gap: 10, paddingVertical: 10 }}>
      <SonarMark active size={200} />
      <Label center>Your surroundings, spoken</Label>
      <Heading center>Hear what’s around you.</Heading>
      <Body center>Point your camera. Ask naturally. Sonar describes nearby objects, seats, text, and obstacles through AirPods or your phone speaker.</Body>
    </View>

    <StatusCard title="Before you start">
      <Body>Keep using your cane, guide dog, and mobility training. Sonar can miss hazards and never decides when it is safe to cross.</Body>
      <Body muted>Images and voice stay on your device. During guidance, Sonar listens again after each answer. Pause to stop the camera and microphone.</Body>
      {speechError ? <Body>{speechError} You can continue with VoiceOver or TalkBack.</Body> : null}
    </StatusCard>

    <Button label="Start Sonar" hint="Starts the camera and spoken guidance on the next screen" onPress={() => void finish()} />
    <Body muted center>No account. No cloud guidance.</Body>
  </Screen>
}
