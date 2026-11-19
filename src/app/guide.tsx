import { useEffect } from 'react'
import { View } from 'react-native'
import { router } from 'expo-router'
import { Body, Button, Heading, Label, Screen, SonarMark, StatusCard } from '../components/ui'
import { useGuidance } from '../lib/guidance/useGuidance'

export default function Guide() {
  const guide = useGuidance()
  const running = guide.state === 'active' || guide.state === 'degraded' || guide.state === 'starting'
  const active = guide.state === 'active' || guide.state === 'degraded'
  const title = guide.state === 'error' ? 'Sonar needs attention' : guide.state === 'starting' ? 'Starting Sonar' : active ? guide.processing ? 'Looking now' : guide.listening ? 'I’m listening' : 'Sonar is on' : 'Sonar is paused'
  const audioRoute = guide.voice?.route === 'headphones' ? 'AirPods or headphones connected' : guide.voice?.route === 'speaker' ? 'Phone speaker' : 'Audio route not confirmed'

  useEffect(() => {
    if (guide.state === 'idle') void guide.start()
  }, [guide])

  return <Screen>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
      <Heading small>Sonar</Heading>
      <Button compact secondary label="Settings" onPress={() => router.push('/settings')} />
    </View>

    <View style={{ alignItems: 'center', gap: 10, paddingVertical: 8 }}>
      <SonarMark active={active} size={194} />
      <Label center>On-device guidance</Label>
      <Heading center>{title}</Heading>
      <Body center>{guide.statusMessage}</Body>
      <Body muted center>{audioRoute}</Body>
      {guide.voice && !guide.voice.available && guide.voice.reason ? <Body center>{guide.voice.reason}</Body> : null}
    </View>

    <Button
      label={guide.state === 'error' ? 'Try again' : running ? 'Pause Sonar' : 'Start Sonar'}
      busy={guide.state === 'starting'}
      hint={running ? 'Stops the camera and microphone' : 'Starts spoken guidance through headphones or the phone speaker'}
      onPress={() => void (running ? guide.stop() : guide.start())}
    />

    {!guide.listening && <Button
      secondary
      label={guide.processing ? 'Inspecting this view' : guide.speaking ? 'Interrupt and ask' : 'Ask by voice'}
      busy={guide.processing}
      disabled={!running}
      hint="Speak naturally. Sonar stops listening while it speaks or processes a scene."
      onPress={() => void guide.ask()}
    />}

    <Label>Or ask with a tap</Label>
    <View style={{ gap: 12 }}>
      <Button secondary label="What’s ahead?" disabled={!active || guide.processing} onPress={() => void guide.ask('What is ahead?')} />
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ flex: 1 }}><Button secondary label="Find a seat" disabled={!active || guide.processing} onPress={() => void guide.ask('Find a free seat')} /></View>
        <View style={{ flex: 1 }}><Button secondary label="Read text" disabled={!active || guide.processing} onPress={() => void guide.ask('Read this')} /></View>
      </View>
    </View>

    {!!guide.lastAnswer && <StatusCard title="Sonar said">
      <Body>{guide.lastAnswer}</Body>
      <Body muted>{guide.lastTranscript ? `You asked: ${guide.lastTranscript}` : 'Latest spoken answer'}</Body>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ flex: 1 }}><Button compact secondary label="Repeat" onPress={() => void guide.repeat()} /></View>
        <View style={{ flex: 1 }}><Button compact secondary label="Stop speech" disabled={!guide.speaking} onPress={() => void guide.stopSpeech()} /></View>
      </View>
    </StatusCard>}

    <Body muted center>Private and on-device. Keep using your usual mobility aid.</Body>
  </Screen>
}
