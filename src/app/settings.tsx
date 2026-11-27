import { useRef, useState } from 'react'
import { Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import {
  Body,
  Button,
  Heading,
  Icon,
  Screen,
  SegmentedControl,
  StatusCard,
  TopBar,
  useColors,
  type IconName,
} from '../components/ui'
import { VisionModelCard } from '../components/VisionModelCard'
import { useAppSettings } from '../lib/SettingsContext'
import { useSatnav } from '../lib/satnav/useSatnav'
import { MOBILITY_PROFILES, MOBILITY_PROFILE_ORDER } from '../lib/satnav/profiles'
import type { DirectionStyle, DistanceUnit, MobilityProfile, MountMode, SatnavMode, TalkGesture } from '../lib/guidance/types'

const PROFILE_ICONS: Record<MobilityProfile, IconName> = {
  standard: 'compass-outline',
  cane: 'walk-outline',
  'guide-dog': 'paw-outline',
  'low-vision': 'eye-outline',
}

function Toggle({ label, caption, value, onChange }: { label: string; caption: string; value: boolean; onChange(value: boolean): void }) {
  const colors = useColors()
  return (
    <View style={[styles.toggle, { borderTopColor: colors.divider }]}>
      <View style={styles.toggleText}>
        <Text style={[styles.rowTitle, { color: colors.text }]}>{label}</Text>
        <Text style={[styles.rowCaption, { color: colors.muted }]}>{caption}</Text>
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors.accent, false: colors.raised }}
        thumbColor="#FFFFFF"
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
        <View style={styles.sliderLabels}>
          <Text style={[styles.rowTitle, { color: colors.text }]}>Speaking speed</Text>
          <Text style={[styles.speedBadge, { color: colors.accent }]}>{speed}×</Text>
        </View>
        <View style={[styles.sliderTrack, { backgroundColor: colors.raised }]}>
          <View style={[styles.sliderFill, { width: portion, backgroundColor: colors.accent }]} />
          <View style={[styles.sliderThumb, { left: portion, backgroundColor: '#FFFFFF', borderColor: colors.accent }]} />
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

      <StatusCard title="Mobility Profile">
        <View style={styles.profileGrid}>
          {MOBILITY_PROFILE_ORDER.map((profile) => {
            const active = settings.mobilityProfile === profile
            const meta = MOBILITY_PROFILES[profile]
            return (
              <Pressable
                key={profile}
                accessibilityRole="button"
                accessibilityLabel={meta.label}
                accessibilityState={{ selected: active }}
                onPress={() => void satnav.applyMobilityProfile(profile)}
                style={({ pressed }) => [
                  styles.profileCard,
                  {
                    backgroundColor: active ? colors.accentSoft : colors.raised,
                    borderColor: active ? colors.accent : 'transparent',
                  },
                  pressed && styles.pressed,
                ]}
              >
                <View style={[styles.profileIconWrap, { backgroundColor: active ? colors.accent : colors.panel }]}>
                  <Icon name={PROFILE_ICONS[profile]} size={18} color={active ? colors.ink : colors.accent} />
                </View>
                <Text numberOfLines={1} style={[styles.profileName, { color: colors.text }]}>
                  {profile === 'guide-dog' ? 'Guide Dog' : meta.label}
                </Text>
              </Pressable>
            )
          })}
        </View>
        <Text style={[styles.rowCaption, { color: colors.muted }]}>
          {MOBILITY_PROFILES[settings.mobilityProfile].shortDescription}
        </Text>
      </StatusCard>

      <StatusCard title="Guidance & Display">
        <Text style={[styles.fieldLabel, { color: colors.muted }]}>Default walking mode</Text>
        <SegmentedControl<SatnavMode>
          value={settings.guidanceMode}
          options={[
            ['satnav', 'Satnav'],
            ['quiet', 'Quiet'],
            ['explore', 'Explore'],
          ]}
          onChange={(guidanceMode) => void update({ guidanceMode })}
        />

        <Text style={[styles.fieldLabel, { color: colors.muted }]}>Talk gesture</Text>
        <SegmentedControl<TalkGesture>
          value={settings.talkGesture}
          options={[
            ['tap', 'Tap anywhere'],
            ['hold', 'Press & hold'],
          ]}
          onChange={(talkGesture) => void update({ talkGesture })}
        />

        <Text style={[styles.fieldLabel, { color: colors.muted }]}>Direction style</Text>
        <SegmentedControl<DirectionStyle>
          value={settings.directionStyle}
          options={[
            ['natural', 'Natural (left)'],
            ['clock', 'Clock (11 o’clock)'],
          ]}
          onChange={(directionStyle) => void update({ directionStyle })}
        />

        <Text style={[styles.fieldLabel, { color: colors.muted }]}>Distance units</Text>
        <SegmentedControl<DistanceUnit>
          value={settings.distanceUnit}
          options={[
            ['metric', 'Metres'],
            ['imperial', 'Feet & miles'],
          ]}
          onChange={(distanceUnit) => void update({ distanceUnit })}
        />

        <Toggle
          label="OLED True-Black high contrast"
          caption="Pure black canvas with crisp yellow focus and maximum contrast."
          value={settings.oledHighContrast}
          onChange={(oledHighContrast) => void update({ oledHighContrast })}
        />
      </StatusCard>

      <StatusCard title="Hands-Free Carry & Pocket Satnav">
        <Text style={[styles.fieldLabel, { color: colors.muted }]}>Phone carry orientation</Text>
        <SegmentedControl<MountMode>
          value={settings.mountMode}
          options={[
            ['handheld', 'Handheld'],
            ['lanyard', 'Chest lanyard'],
          ]}
          onChange={(mountMode) => void update({ mountMode })}
        />
        <Toggle
          label="Keep satnav running in pocket"
          caption="Keeps GPS turns, 3D audio beacons, and AirPods buttons active while locked."
          value={settings.backgroundSatnav}
          onChange={(backgroundSatnav) => void update({ backgroundSatnav })}
        />
        <Toggle
          label="Screen curtain"
          caption="Black out display for privacy and battery while keeping all touch gestures live."
          value={settings.screenCurtain}
          onChange={(screenCurtain) => void update({ screenCurtain })}
        />
        <Toggle
          label="Auto low-light torch"
          caption="Soft torch assist in dark streets for reading doors and signs. LiDAR works in 0 lux."
          value={settings.autoTorch}
          onChange={(autoTorch) => void update({ autoTorch })}
        />
      </StatusCard>

      <StatusCard title="Haptics & 3D Spatial Audio">
        <Toggle
          label="Master haptics"
          caption="Tactile steering beats, proximity radar, and hazard alerts."
          value={settings.urgentHaptics}
          onChange={(urgentHaptics) => void update({ urgentHaptics })}
        />
        <Toggle
          label="Compass & corridor lock pulse"
          caption="Gentle steady pulse while aligned on-course or down a clear corridor."
          value={settings.hapticSteering}
          onChange={(hapticSteering) => void update({ hapticSteering })}
        />
        <Toggle
          label="Proximity obstacle radar"
          caption="Parking-sensor cadence that speeds up closer than 2.2 metres."
          value={settings.hapticProximity}
          onChange={(hapticProximity) => void update({ hapticProximity })}
        />
        <Toggle
          label="3D headphone waypoint beacon"
          caption="Binaural directional audio beacon in open-ear or Transparency headphones."
          value={settings.spatialBeacon}
          onChange={(spatialBeacon) => void update({ spatialBeacon })}
        />
        <Text style={[styles.fieldLabel, { color: colors.muted }]}>Preview cues</Text>
        <View style={styles.options}>
          <Button compact secondary label="On-course" onPress={() => void satnav.previewFeedback('compass-lock')} />
          <Button compact secondary label="Fast mover" onPress={() => void satnav.previewFeedback('fast-mover')} />
          <Button compact secondary label="Dog" onPress={() => void satnav.previewFeedback('animal')} />
          <Button compact secondary label="Turn right" onPress={() => void satnav.previewFeedback('turn-right')} />
          <Button compact secondary label="Head hazard" onPress={() => void satnav.previewFeedback('head-hazard')} />
          <Button compact secondary label="Drop-off" onPress={() => void satnav.previewFeedback('drop-off')} />
        </View>
      </StatusCard>

      <StatusCard title="Voice & TensorFold Narrator">
        <Toggle
          label="Phone speaker without headphones"
          caption="Keep spoken guidance audible when headphones disconnect."
          value={settings.speakerFallback}
          onChange={(speakerFallback) => void update({ speakerFallback })}
        />
        <Toggle
          label="Identify blocking obstacles"
          caption="Uses TensorFold Mobile to name roadworks, pushbikes, bins, and parked cars."
          value={settings.ambientObstacleNaming}
          onChange={(ambientObstacleNaming) => void update({ ambientObstacleNaming })}
        />
        <Toggle
          label="Proactive street & crossing narrator"
          caption="Calls out crossings before turns and passing shops or doorways while walking."
          value={settings.proactiveNarration}
          onChange={(proactiveNarration) => void update({ proactiveNarration })}
        />
        {voices.length > 0 && (
          <>
            <Button
              compact
              secondary
              expanded={showVoices}
              label={`Voice: ${currentVoice?.name ?? 'System default'}`}
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
        <Text style={[styles.fieldLabel, { color: colors.muted }]}>Calibrated step length</Text>
        <SegmentedControl
          value={settings.stepLengthMeters.toFixed(2)}
          options={[
            ['0.50', '0.50 m'],
            ['0.65', '0.65 m'],
            ['0.75', '0.75 m'],
            ['0.90', '0.90 m'],
          ]}
          onChange={(v) => void update({ stepLengthMeters: Number(v) })}
        />
        <Text style={[styles.fieldLabel, { color: colors.muted }]}>Obstacle alert distance</Text>
        <SegmentedControl
          value={settings.warningDistanceMeters.toFixed(1)}
          options={[
            ['1.5', '1.5 m'],
            ['2.2', '2.2 m'],
            ['3.0', '3.0 m'],
          ]}
          onChange={(v) => void update({ warningDistanceMeters: Number(v) })}
        />
      </StatusCard>

      <VisionModelCard manageMemory />

      <StatusCard title="Trusted Contact">
        <Text style={[styles.rowCaption, { color: colors.muted }]}>
          Say “Share my location” or “Call my emergency contact” anytime.
        </Text>
        <TextInput
          accessibilityLabel="Trusted contact name"
          placeholder="Name (e.g. Alex)"
          placeholderTextColor={colors.muted}
          value={settings.emergencyContactName}
          onChangeText={(emergencyContactName) => void update({ emergencyContactName })}
          style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
        />
        <TextInput
          accessibilityLabel="Trusted contact phone number"
          keyboardType="phone-pad"
          placeholder="Phone number"
          placeholderTextColor={colors.muted}
          value={settings.emergencyContactPhone}
          onChangeText={(emergencyContactPhone) => void update({ emergencyContactPhone })}
          style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
        />
        <Button compact secondary icon="share-social-outline" label="Test location share" onPress={() => void satnav.shareLocationWithContact()} />
      </StatusCard>

      <StatusCard title="Saved Places & Offline Routes">
        <Body muted>
          {satnav.savedPlaces.length} saved places · {satnav.cachedRoutes.length} cached walking routes.
        </Body>
        {satnav.savedPlaces.map((place) => (
          <View key={place.id} style={styles.placeRow}>
            <Text style={[styles.rowTitle, { color: colors.text }]}>{place.name}</Text>
            <Button compact secondary label="Remove" onPress={() => void satnav.deleteSavedPlace(place.id)} />
          </View>
        ))}
        {satnav.cachedRoutes.length > 0 && (
          <Button compact secondary label="Clear cached routes" onPress={() => void satnav.clearRouteCache()} />
        )}
      </StatusCard>

      <StatusCard title="Privacy & Onboarding">
        <Text style={[styles.rowCaption, { color: colors.muted }]}>
          Camera frames, LiDAR depth, TensorFold Metal AI, speech, haptics, and 3D beacons stay 100% on your device.
        </Text>
        <Button compact secondary label="Repeat onboarding" onPress={() => void update({ onboardingComplete: false }).then(() => router.replace('/setup'))} />
      </StatusCard>
    </Screen>
  )
}

const styles = StyleSheet.create({
  title: { paddingTop: 2, paddingBottom: 2 },
  profileGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  profileCard: {
    width: '48%',
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1.5,
  },
  profileIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileName: { fontSize: 14, fontWeight: '700', flex: 1 },
  fieldLabel: { fontSize: 13, fontWeight: '600', marginTop: 4 },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowCaption: { fontSize: 13, lineHeight: 19 },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  toggleText: { flex: 1, gap: 2 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  placeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  input: { minHeight: 48, fontSize: 16, paddingHorizontal: 14, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  slider: { minHeight: 54, paddingTop: 8, paddingBottom: 8 },
  sliderContents: { gap: 12 },
  sliderLabels: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  speedBadge: { fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] },
  sliderTrack: { marginHorizontal: 9, height: 6, borderRadius: 3 },
  sliderFill: { height: 6, borderRadius: 3 },
  sliderThumb: { position: 'absolute', top: -7, marginLeft: -10, width: 20, height: 20, borderRadius: 10, borderWidth: 2 },
  pressed: { opacity: 0.78, transform: [{ scale: 0.985 }] },
})
