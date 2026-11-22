import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Image, StyleSheet, View, useWindowDimensions } from 'react-native'
import { router } from 'expo-router'
import { Body, Button, Heading, Screen, TopBar, useColors } from '../components/ui'
import { VisionModelCard } from '../components/VisionModelCard'
import * as Voice from '../../modules/tensorfold-voice/src'
import { useAppSettings } from '../lib/SettingsContext'
import { useGuidance } from '../lib/guidance/useGuidance'

export default function Setup() {
  const { settings, update } = useAppSettings()
  const { vision, visionStatus } = useGuidance()
  const colors = useColors()
  const { fontScale, width } = useWindowDimensions()
  const photoHeight = Math.round((Math.min(width, 550) - 40) / 1.6)
  const [continuing, setContinuing] = useState(false)
  const leaving = useRef(false)
  const mounted = useRef(true)
  const waitingForDownload = visionStatus.state === 'downloading' || visionStatus.state === 'loading'
  const hasDownload = visionStatus.state === 'installed' || visionStatus.state === 'ready'

  useEffect(() => {
    mounted.current = true
    let started = false
    void AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
      if (!mounted.current || enabled) return
      started = true
      return Voice.speak('Point your camera. Download offline descriptions to recognise nearby objects and look for seats. Choose Start hands-free to ask a question using your voice. Say stop camera to finish. NearDAR can miss hazards. Use it alongside your cane, guide dog, and orientation and mobility training.', {
        voiceIdentifier: settings.voiceIdentifier, rate: settings.speechRate, priority: 'answer', interrupt: true, speakerFallback: settings.speakerFallback,
      })
    }).catch(() => {})
    return () => {
      mounted.current = false
      if (started) void Voice.stopSpeaking().catch(() => {})
    }
  }, [settings.speechRate, settings.speakerFallback, settings.voiceIdentifier])

  async function finish(downloadReady = false) {
    if (leaving.current || !mounted.current) return
    leaving.current = true
    setContinuing(true)
    await update({ onboardingComplete: true }).catch(() => {})
    if (mounted.current) router.replace({ pathname: '/guide', params: { setup: downloadReady ? 'downloaded' : 'complete' } })
  }

  const continueLabel = waitingForDownload ? 'Open NearDAR while preparing' : vision?.available && !hasDownload ? 'Continue without download' : 'Continue to NearDAR'

  return <Screen footer={<Button label={continueLabel} secondary={!!vision?.available && !hasDownload} icon="arrow-forward" hint="Choose Start hands-free or Start camera on the next screen." busy={continuing} onPress={() => void finish()} />}>
    <TopBar />
    <View style={styles.intro}>
      <Heading editorial focusOnEntry>Point your camera.</Heading>
      <Body muted>Ask what’s nearby, look for a seat, find an object, or read text aloud.</Body>
    </View>
    {fontScale < 1.5 && <Image
      source={require('../../assets/neardar-welcome.jpg')}
      accessible={false}
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      resizeMode="cover"
      style={[styles.photo, { height: photoHeight, backgroundColor: colors.raised }]}
    />}
    <VisionModelCard onReady={() => void finish(true)} />
    <Body muted>NearDAR can miss hazards. Use it alongside your cane, guide dog, and orientation and mobility training.</Body>
  </Screen>
}

const styles = StyleSheet.create({
  intro: { gap: 10, paddingTop: 4 },
  photo: { width: '100%', borderRadius: 20 },
})
