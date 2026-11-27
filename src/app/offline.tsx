import { router } from 'expo-router'
import { Body, Button, Heading, Screen, TopBar } from '../components/ui'
import { VisionModelCard } from '../components/VisionModelCard'
import { useSatnav } from '../lib/satnav/useSatnav'

export default function OfflineDescriptions() {
  const { visionStatus } = useSatnav()
  const ready = visionStatus.state === 'ready'
  const returnToGuide = () => router.canGoBack() ? router.back() : router.replace('/guide')

  return <Screen footer={ready ? <Button label="Back to Satnav" icon="arrow-forward" onPress={returnToGuide} /> : undefined}>
    <TopBar back={returnToGuide} />
    <Heading editorial focusOnEntry>TensorFold Mobile</Heading>
    <Body muted>Talk naturally to NearDar about roadworks, cyclists, animals, doorways, signs, crossings, and obstacles around you. Vision and conversation run locally on TensorFold Metal.</Body>
    <VisionModelCard />
  </Screen>
}
