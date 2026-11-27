import { useRef, useState } from 'react'
import { Platform, StyleSheet, Switch, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import { Body, Button, Heading, Screen, StatusCard, TopBar, useColors } from '../components/ui'
import { VisionModelCard } from '../components/VisionModelCard'
import { useAppSettings } from '../lib/SettingsContext'
import { useSatnav } from '../lib/satnav/useSatnav'
import type { DirectionStyle, SatnavMode, TalkGesture } from '../lib/guidance/types'

function Toggle({ label, caption, value, onChange }: { label: string; caption: string; value: boolean; onChange(value: boolean): void }) {
  const colors = useColors()
  return (
    <View style={styles.toggle}>
      <View style={styles.toggleText}>
        <Body>{label}</Body>
        <Body muted>{caption}</Body>
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors.accent, false: colors.border }}
        thumbColor={colors.panel}
      />
    </View>
  )
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

  return (
    <View
      {...keyboard}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Speaking speed"
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
  )
}

export default function Settings() {
  const colors = useColors()
  const { settings, update } = useAppSettings()
  const satnav = useSatnav()
  const [showVoices, setShowVoices] = useState(false)
  const [voiceSearch, setVoiceSearch] = useState('')

  const voices = satnav.voice?.installedVoices ?? []
  const currentVoice = voices.find(({ id }) => id === settings.voiceIdentifier)
  const query = voiceSearch.trim().toLocaleLowerCase()
  const matchingVoices = voices.filter(({ name, language }) => `${name} ${language}`.toLocaleLowerCase().includes(query))

  return (
    <Screen>
      <TopBar back={() => router.canGoBack() ? router.back() : router.replace('/guide')} />
      <View style={styles.title}>
        <Heading editorial focusOnEntry>Settings</Heading>
      </View>

      <StatusCard title="Walking Mode & Talk Gesture">
        <Body>Default guidance mode</Body>
        <View style={styles.options}>
          {([
            ['satnav', 'Full Satnav'],
            ['quiet', 'Quiet Haptics'],
            ['explore', 'Explore'],
          ] as [SatnavMode, string][]).map(([mode, label]) => (
            <Button
              key={mode}
              compact
              secondary={settings.guidanceMode !== mode}
              selected={settings.guidanceMode === mode}
              label={label}
              onPress={() => void update({ guidanceMode: mode })}
            />
          ))}
        </View>

        <Body>How to talk on the main screen</Body>
        <View style={styles.options}>
          {([
            ['tap', 'Tap anywhere'],
            ['hold', 'Press & hold'],
          ] as [TalkGesture, string][]).map(([gesture, label]) => (
            <Button
              key={gesture}
              compact
              secondary={settings.talkGesture !== gesture}
              selected={settings.talkGesture === gesture}
              label={label}
              onPress={() => void update({ talkGesture: gesture })}
            />
          ))}
        </View>
        <Body>Direction phrasing</Body>
        <View style={styles.options}>
          {([
            ['natural', 'Natural (ahead left)'],
            ['clock', 'Clock face (11 o’clock)'],
          ] as [DirectionStyle, string][]).map(([directionStyle, label]) => (
            <Button
              key={directionStyle}
              compact
              secondary={settings.directionStyle !== directionStyle}
              selected={settings.directionStyle === directionStyle}
              label={label}
              onPress={() => void update({ directionStyle })}
            />
          ))}
        </View>

        <Toggle
          label="OLED True-Black high contrast"
          caption="Pure black background with yellow and white contrast to eliminate glare for low-vision users."
          value={settings.oledHighContrast}
          onChange={(oledHighContrast) => void update({ oledHighContrast })}
        />
      </StatusCard>

      <StatusCard title="Haptics & 3D Spatial Audio">
        <Toggle
          label="Master haptics"
          caption="Enable tactile steering, proximity radar, and hazard alerts."
          value={settings.urgentHaptics}
          onChange={(urgentHaptics) => void update({ urgentHaptics })}
        />
        <Toggle
          label="Compass & corridor steering beat"
          caption="Gentle steady pulse while your phone points on-course or down an open corridor."
          value={settings.hapticSteering}
          onChange={(hapticSteering) => void update({ hapticSteering })}
        />
        <Toggle
          label="Proximity obstacle radar"
          caption="Parking-sensor style pulses that speed up as obstacles come closer than 2.2 metres."
          value={settings.hapticProximity}
          onChange={(hapticProximity) => void update({ hapticProximity })}
        />
        <Toggle
          label="3D headphone waypoint beacon"
          caption="Binaural directional audio beacon in headphones so you hear turns and open space in 3D."
          value={settings.spatialBeacon}
          onChange={(spatialBeacon) => void update({ spatialBeacon })}
        />
        <Body muted>Preview tactile &amp; audio cues:</Body>
        <View style={styles.options}>
          <Button compact secondary label="On-course" onPress={() => void satnav.previewFeedback('compass-lock')} />
          <Button compact secondary label="Proximity" onPress={() => void satnav.previewFeedback('proximity')} />
          <Button compact secondary label="Fast mover" onPress={() => void satnav.previewFeedback('fast-mover')} />
          <Button compact secondary label="Dog / presence" onPress={() => void satnav.previewFeedback('animal')} />
          <Button compact secondary label="Turn right" onPress={() => void satnav.previewFeedback('turn-right')} />
          <Button compact secondary label="Head hazard" onPress={() => void satnav.previewFeedback('head-hazard')} />
          <Button compact secondary label="Drop-off" onPress={() => void satnav.previewFeedback('drop-off')} />
          <Button compact secondary label="Arrived" onPress={() => void satnav.previewFeedback('arrived')} />
        </View>
      </StatusCard>

      <StatusCard title="Voice & Speech">
        <Toggle
          label="Use phone speaker without headphones"
          caption="Keep spoken guidance audible when headphones are disconnected."
          value={settings.speakerFallback}
          onChange={(speakerFallback) => void update({ speakerFallback })}
        />
        <Toggle
          label="Name blocking obstacles automatically"
          caption="Uses TensorFold Mobile to identify roadworks, pushbikes, bins, signs, and barriers blocking your path."
          value={settings.ambientObstacleNaming}
          onChange={(ambientObstacleNaming) => void update({ ambientObstacleNaming })}
        />
        <Toggle
          label="Proactive street & crossing narrator"
          caption="Calls out crossings before turns and passing shops, entrances, or hazards while you walk."
          value={settings.proactiveNarration}
          onChange={(proactiveNarration) => void update({ proactiveNarration })}
        />
        {voices.length > 0 && (
          <>
            <Button
              compact
              secondary
              expanded={showVoices}
              label={`Speaking voice: ${currentVoice?.name ?? 'System default'}`}
              onPress={() => setShowVoices(!showVoices)}
            />
            {showVoices && (
              <>
                <TextInput
                  accessibilityLabel="Search voices by name or language"
                  placeholder="Search voices"
                  placeholderTextColor={colors.muted}
                  value={voiceSearch}
                  onChangeText={setVoiceSearch}
                  style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
                />
                <Button compact secondary label="System default" selected={!currentVoice} onPress={() => void update({ voiceIdentifier: undefined })} />
                {matchingVoices.map(({ id, name, language }) => (
                  <Button
                    key={id}
                    compact
                    secondary
                    label={`${name}, ${language}`}
                    selected={id === settings.voiceIdentifier}
                    onPress={() => void update({ voiceIdentifier: id })}
                  />
                ))}
              </>
            )}
          </>
        )}
        <SpeakingSpeed value={settings.speechRate} onChange={(speechRate) => void update({ speechRate })} />
      </StatusCard>

      <StatusCard title="LiDAR Calibration">
        <Body>Step length</Body>
        <View style={styles.options}>
          {[0.5, 0.65, 0.75, 0.9].map((stepLengthMeters) => (
            <Button
              key={stepLengthMeters}
              compact
              secondary={settings.stepLengthMeters !== stepLengthMeters}
              selected={settings.stepLengthMeters === stepLengthMeters}
              label={`${stepLengthMeters.toFixed(2)} m`}
              onPress={() => void update({ stepLengthMeters })}
            />
          ))}
        </View>
        <Body>Obstacle warning distance</Body>
        <View style={styles.options}>
          {[1.5, 2.2, 3.0].map((warningDistanceMeters) => (
            <Button
              key={warningDistanceMeters}
              compact
              secondary={settings.warningDistanceMeters !== warningDistanceMeters}
              selected={settings.warningDistanceMeters === warningDistanceMeters}
              label={`${warningDistanceMeters.toFixed(1)} m`}
              onPress={() => void update({ warningDistanceMeters })}
            />
          ))}
        </View>
      </StatusCard>

      <VisionModelCard manageMemory />

      <StatusCard title="Saved Places & Offline Routes">
        <Body muted>
          {satnav.savedPlaces.length} saved places · {satnav.cachedRoutes.length} offline cached walking routes.
        </Body>
        {satnav.savedPlaces.map((place) => (
          <View key={place.id} style={styles.placeRow}>
            <Body>{place.name}</Body>
            <Button compact secondary label="Remove" onPress={() => void satnav.deleteSavedPlace(place.id)} />
          </View>
        ))}
        {satnav.cachedRoutes.length > 0 && (
          <Button compact secondary label="Clear cached routes" onPress={() => void satnav.clearRouteCache()} />
        )}
      </StatusCard>

      <StatusCard title="Privacy & Setup">
        <Body muted>
          All camera frames, LiDAR depth maps, vision AI inference, speech recognition, haptics, and 3D beacons stay on your device. Online network access is used only when searching new addresses or fetching fresh walking routes.
        </Body>
        <Button compact secondary label="Repeat onboarding" onPress={() => void update({ onboardingComplete: false }).then(() => router.replace('/setup'))} />
      </StatusCard>
    </Screen>
  )
}

const styles = StyleSheet.create({
  title: { gap: 8 },
  toggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14 },
  toggleText: { flex: 1, gap: 3 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  placeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  input: { minHeight: 54, fontSize: 18, padding: 12, borderRadius: 12, borderWidth: 1.5 },
  slider: { minHeight: 56, paddingBottom: 12 },
  sliderContents: { gap: 12 },
  sliderLabels: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  sliderTrack: { marginHorizontal: 9, height: 6, borderRadius: 3 },
  sliderFill: { height: 6, borderRadius: 3 },
  sliderThumb: { position: 'absolute', top: -6, marginLeft: -9, width: 18, height: 18, borderRadius: 9 },
})
