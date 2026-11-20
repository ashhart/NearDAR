import { router } from 'expo-router'
import { Body, Button, Heading, Screen, TopBar } from '../components/ui'
import { VisionModelCard } from '../components/VisionModelCard'
import { useGuidance } from '../lib/guidance/useGuidance'

export default function OfflineDescriptions() {
  const { visionStatus } = useGuidance()
  const ready = visionStatus.state === 'ready'
  const returnToGuide = () => router.canGoBack() ? router.back() : router.replace('/guide')

  return <Screen footer={ready ? <Button label="Continue to NearDAR" icon="arrow-forward" onPress={returnToGuide} /> : undefined}>
    <TopBar back={returnToGuide} />
    <Heading editorial focusOnEntry>Describe what’s nearby</Heading>
    <Body muted>Ask about the people, objects and seats in the camera view. The descriptions are generated on your phone.</Body>
    <VisionModelCard />
  </Screen>
}
