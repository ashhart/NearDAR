import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { Body, Button, Heading, Screen, StatusCard, TopBar } from '../components/ui'
import { VisionModelCard } from '../components/VisionModelCard'
import * as Voice from '../../modules/tensorfold-voice/src'
import { useAppSettings } from '../lib/SettingsContext'
import { useSatnav } from '../lib/satnav/useSatnav'

export default function Setup() {
  const { settings, update } = useAppSettings()
  const satnav = useSatnav()
  const [continuing, setContinuing] = useState(false)
  const leaving = useRef(false)
  const mounted = useRef(true)
  const waitingForDownload = satnav.visionStatus.state === 'downloading' || satnav.visionStatus.state === 'loading'
  const hasDownload = satnav.visionStatus.state === 'installed' || satnav.visionStatus.state === 'ready'

  useEffect(() => {
    mounted.current = true
    let started = false
    void AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
      if (!mounted.current || enabled) return
      started = true
      return Voice.speak(
        'Welcome to NearDar, your on-device voice and haptic walking satnav. Download TensorFold Mobile to hear about roadworks, cyclists, animals, doorways, crossings, and signs. Use open-ear headphones or Transparency mode so you can still hear traffic, and always use NearDar alongside your cane, guide dog, and mobility training.',
        {
          voiceIdentifier: settings.voiceIdentifier,
          rate: settings.speechRate,
          priority: 'answer',
          interrupt: true,
          speakerFallback: settings.speakerFallback,
        },
      )
    }).catch(() => {})
    return () => {
      mounted.current = false
      if (started) void Voice.stopSpeaking().catch(() => {})
    }
  }, [settings.speechRate, settings.speakerFallback, settings.voiceIdentifier])

  async function finish() {
    if (leaving.current || !mounted.current) return
    leaving.current = true
    setContinuing(true)
    await update({ onboardingComplete: true }).catch(() => {})
    if (mounted.current) router.replace('/guide')
  }

  const continueLabel = waitingForDownload
    ? 'Start Walking while downloading'
    : satnav.vision?.available && !hasDownload
      ? 'Start without vision model'
      : 'Start Walking'

  return (
    <Screen
      footer={
        <Button
          label={continueLabel}
          secondary={!!satnav.vision?.available && !hasDownload}
          icon="walk-outline"
          hint="Opens the eyes-free NearDar satnav."
          busy={continuing}
          onPress={() => void finish()}
        />
      }
    >
      <TopBar />
      <View style={styles.intro}>
        <Heading editorial focusOnEntry>Voice &amp; haptic satnav.</Heading>
        <Body muted>
          Follow gentle steering pulses, 3D headphone beacons, and live LiDAR hazard cues—and tap anywhere to talk about what is ahead, all on your phone.
        </Body>
      </View>

      <VisionModelCard onReady={() => void finish()} />

      <StatusCard title="Feel the satnav cues">
        <Body muted>Test how NearDar feels in your hand and sounds in headphones before walking.</Body>
        <View style={styles.cues}>
          <Button compact secondary label="On-course beat" onPress={() => void satnav.previewFeedback('compass-lock')} />
          <Button compact secondary label="Fast mover" onPress={() => void satnav.previewFeedback('fast-mover')} />
          <Button compact secondary label="Dog / presence" onPress={() => void satnav.previewFeedback('animal')} />
          <Button compact secondary label="Head hazard" onPress={() => void satnav.previewFeedback('head-hazard')} />
          <Button compact secondary label="Step / drop-off" onPress={() => void satnav.previewFeedback('drop-off')} />
        </View>
      </StatusCard>

      <StatusCard title="Keep your ears open to the street">
        <Body muted>
          For the best 3D beacons without blocking traffic or footsteps, use bone-conduction headphones or Transparency mode—never noise cancellation outdoors. NearDar works alongside your white cane, guide dog, and orientation and mobility training.
        </Body>
      </StatusCard>
    </Screen>
  )
}

const styles = StyleSheet.create({
  intro: { gap: 10, paddingTop: 4 },
  cues: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
})
