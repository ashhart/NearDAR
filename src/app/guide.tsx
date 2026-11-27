import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Keyboard,
  Linking,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewProps,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { requireNativeViewManager } from 'expo-modules-core'
import { Body, Button, Icon, Label, Signal, useColors } from '../components/ui'
import { RadarHud } from '../components/RadarHud'
import { useSatnav } from '../lib/satnav/useSatnav'
import { useAppSettings } from '../lib/SettingsContext'
import { formatWalkingDistance } from '../lib/navigation/geo'
import { MOBILITY_SKILLS } from '../lib/satnav/modes'
import type { SatnavMode } from '../lib/guidance/types'

function CameraPreview(props: ViewProps) {
  const [Preview] = useState(() => requireNativeViewManager<ViewProps & { playing: boolean }>('TensorFoldPerception'))
  return <Preview {...props} playing />
}

const MODE_LABELS: Record<SatnavMode, string> = {
  satnav: 'Full Satnav',
  quiet: 'Quiet Haptics',
  explore: 'Explore',
}

export default function SatnavGuide() {
  const satnav = useSatnav()
  const { settings } = useAppSettings()
  const colors = useColors()

  const [navSheetOpen, setNavSheetOpen] = useState(false)
  const [destinationInput, setDestinationInput] = useState('')
  const [placeNameInput, setPlaceNameInput] = useState('')
  const [showCameraPreview, setShowCameraPreview] = useState(false)

  const autoStartedRef = useRef(false)
  const lastTapAtRef = useRef(0)
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdActiveRef = useRef(false)
  const satnavRef = useRef(satnav)
  satnavRef.current = satnav
  const talkGestureRef = useRef(settings.talkGesture)
  talkGestureRef.current = settings.talkGesture

  // Auto-start live LiDAR + compass + haptics immediately on open (unless paused by user)
  useEffect(() => {
    if (autoStartedRef.current) return
    autoStartedRef.current = true
    if (satnav.state === 'idle' && Platform.OS !== 'web') {
      void satnav.start()
    }
  }, [satnav])

  useEffect(() => {
    return () => {
      if (tapTimerRef.current) clearTimeout(tapTimerRef.current)
    }
  }, [])

  const openSettings = useCallback(() => {
    router.push('/settings')
  }, [])

  const handleSubmitDestination = useCallback(() => {
    const target = destinationInput.trim()
    if (!target) return
    Keyboard.dismiss()
    setDestinationInput('')
    setNavSheetOpen(false)
    void satnav.navigateToDestination(target)
  }, [destinationInput, satnav])

  const handleSavePlace = useCallback(() => {
    const label = placeNameInput.trim()
    if (!label) return
    Keyboard.dismiss()
    setPlaceNameInput('')
    void satnav.saveCurrentPlace(label)
  }, [placeNameInput, satnav])

  // Eyes-free gesture recognizer:
  // Swipe left/right = switch mode, Swipe up = scan ahead, Swipe down = orient me,
  // Double-tap = pause/resume, Tap (or Hold) = talk with barge-in.
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 18 || Math.abs(gesture.dy) > 18,
    onPanResponderGrant: () => {
      if (talkGestureRef.current === 'hold') {
        holdActiveRef.current = true
        void satnavRef.current.beginTalk()
      }
    },
    onPanResponderRelease: (_, gesture) => {
      if (holdActiveRef.current) {
        holdActiveRef.current = false
        void satnavRef.current.endTalk()
        return
      }
      // Horizontal swipe switches guidance mode
      if (Math.abs(gesture.dx) >= 70 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.4) {
        if (tapTimerRef.current) {
          clearTimeout(tapTimerRef.current)
          tapTimerRef.current = null
        }
        void satnavRef.current.cycleMode(gesture.dx > 0 ? 1 : -1)
        return
      }
      // Vertical swipe up -> instant TensorFold scan ahead (zero-talk)
      if (gesture.dy <= -75 && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.4) {
        if (tapTimerRef.current) {
          clearTimeout(tapTimerRef.current)
          tapTimerRef.current = null
        }
        void satnavRef.current.quickScanAhead()
        return
      }
      // Vertical swipe down -> calm street, heading, and surroundings orientation (zero-talk)
      if (gesture.dy >= 75 && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.4) {
        if (tapTimerRef.current) {
          clearTimeout(tapTimerRef.current)
          tapTimerRef.current = null
        }
        void satnavRef.current.orientMe(true)
        return
      }
      // Tap / Double-tap disambiguation
      if (Math.abs(gesture.dx) < 20 && Math.abs(gesture.dy) < 20) {
        const now = Date.now()
        if (now - lastTapAtRef.current <= 300) {
          lastTapAtRef.current = 0
          if (tapTimerRef.current) {
            clearTimeout(tapTimerRef.current)
            tapTimerRef.current = null
          }
          void satnavRef.current.togglePause()
        } else {
          lastTapAtRef.current = now
          tapTimerRef.current = setTimeout(() => {
            tapTimerRef.current = null
            void satnavRef.current.beginTalk()
          }, 260)
        }
      }
    },
    onPanResponderTerminate: () => {
      if (holdActiveRef.current) {
        holdActiveRef.current = false
        void satnavRef.current.endTalk()
      }
    },
  }), [])

  const route = satnav.routeProgress
  const routeActive = Boolean(route && route.active && !route.arrived)
  const headphones = satnav.voice?.route === 'headphones'

  const primaryCaption = satnav.listening
    ? (satnav.partialTranscript ? `“${satnav.partialTranscript}”` : 'Listening… ask anything or say a destination.')
    : satnav.thinking
      ? (satnav.lastReply?.text || 'Looking at what is ahead…')
      : satnav.lastReply?.text || satnav.fused.summary || satnav.statusMessage

  const canvasAccessibilityLabel = [
    satnav.active ? `${MODE_LABELS[satnav.mode]} active.` : 'Satnav paused.',
    routeActive && route ? `Route to ${route.route.destinationName}, ${formatWalkingDistance(route.remainingDistanceMeters, settings.stepLengthMeters, settings.distanceUnit)} left. ${route.currentStep.instruction}.` : '',
    satnav.activeSkill !== 'none' ? `${MOBILITY_SKILLS[satnav.activeSkill].label} active.` : '',
    satnav.fused.summary,
    satnav.lastReply?.text ? `Last message: ${satnav.lastReply.text}` : '',
  ].filter(Boolean).join(' ')

  if (settings.screenCurtain) {
    return (
      <SafeAreaView style={styles.curtainRoot}>
        <View
          {...panResponder.panHandlers}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`Screen curtain active. ${canvasAccessibilityLabel}`}
          accessibilityHint="Tap to talk. Swipe up to scan ahead. Swipe down to orient yourself. Double-tap to pause or resume. Say turn screen back on to lift curtain."
          accessibilityActions={[
            { name: 'activate', label: 'Talk to NearDar' },
            { name: 'scanAhead', label: 'Scan ahead now' },
            { name: 'orientMe', label: 'Orient me' },
            { name: 'liftCurtain', label: 'Turn screen back on' },
            { name: 'magicTap', label: satnav.active ? 'Pause satnav' : 'Resume satnav' },
          ]}
          onAccessibilityAction={({ nativeEvent }) => {
            switch (nativeEvent.actionName) {
              case 'activate': void satnav.beginTalk(); break
              case 'scanAhead': void satnav.quickScanAhead(); break
              case 'orientMe': void satnav.orientMe(true); break
              case 'liftCurtain': void satnav.toggleScreenCurtain(false); break
              case 'magicTap': void satnav.togglePause(); break
            }
          }}
          style={styles.curtainCanvas}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Turn screen back on"
            onPress={() => void satnav.toggleScreenCurtain(false)}
            style={styles.curtainLiftBtn}
          >
            <Text style={styles.curtainLiftText}>Screen Curtain On · Tap to Show Screen</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <View style={styles.shell}>
        {/* Compact Top Bar */}
        <View style={styles.topBar}>
          <View style={styles.topStatus}>
            <Signal tone={satnav.active ? (satnav.fused.standby ? 'quiet' : satnav.cameraReady ? 'ready' : 'attention') : 'quiet'}>
              {satnav.active ? (satnav.fused.standby ? 'Standby' : satnav.cameraReady ? 'LiDAR Live' : 'Starting') : 'Paused'}
            </Signal>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Guidance mode: ${MODE_LABELS[satnav.mode]}. Activate to switch mode.`}
              onPress={() => void satnav.cycleMode(1)}
              style={[styles.pill, { backgroundColor: colors.raised, borderColor: colors.border }]}
            >
              <Text style={[styles.pillText, { color: colors.text }]}>{MODE_LABELS[satnav.mode]}</Text>
            </Pressable>
            {headphones && settings.spatialBeacon && (
              <View accessible accessibilityLabel="3D headphone spatial beacon active" style={[styles.pill, { backgroundColor: colors.panel, borderColor: colors.divider }]}>
                <Icon name="headset-outline" size={14} color={colors.accent} />
                <Text style={[styles.pillText, { color: colors.accent }]}>3D</Text>
              </View>
            )}
          </View>

          <Button compact secondary icon="settings-outline" label="Settings" onPress={openSettings} />
        </View>

        {/* Active Route Maneuver Banner */}
        {routeActive && route && (
          <View style={[styles.routeCard, { backgroundColor: colors.raised, borderColor: colors.accent }]}>
            <View style={styles.routeHeader}>
              <View style={styles.routeMeta}>
                <Text numberOfLines={1} style={[styles.routeDest, { color: colors.text }]}>
                  {route.route.destinationName}
                </Text>
                <Text style={[styles.routeDist, { color: colors.accent }]}>
                  {formatWalkingDistance(route.remainingDistanceMeters, settings.stepLengthMeters, settings.distanceUnit)} left
                  {route.route.source !== 'mapkit' ? ' · Offline' : ''}
                </Text>
              </View>
              <Button compact secondary label="End" onPress={() => void satnav.cancelRoute()} />
            </View>
            <Text style={[styles.routeStep, { color: colors.text }]}>
              {route.offRoute ? 'Off route — follow the beacon to rejoin.' : route.currentStep.instruction}
            </Text>
          </View>
        )}

        {/* Active Mobility Skill Bar (Door Finder, Crossing, Bus Watcher, Vivid Scene) */}
        {satnav.activeSkill !== 'none' && (
          <View style={[styles.skillBar, { backgroundColor: colors.raised, borderColor: colors.accent }]}>
            <Text numberOfLines={1} style={[styles.skillLabel, { color: colors.text }]}>
              {satnav.activeSkill === 'transit' && satnav.watchedBus
                ? `Watching for Bus ${satnav.watchedBus}`
                : MOBILITY_SKILLS[satnav.activeSkill].label}
            </Text>
            <View style={styles.skillActions}>
              <Button
                compact
                secondary
                label="Re-scan"
                onPress={() => void satnav.runSkill(satnav.activeSkill === 'none' ? 'door-finder' : satnav.activeSkill, satnav.watchedBus)}
              />
              <Button compact secondary label="Done" onPress={satnav.clearSkill} />
            </View>
          </View>
        )}

        {/* Full-Screen Eyes-Free Gesture Canvas */}
        <View
          {...panResponder.panHandlers}
          accessible
          accessibilityRole="button"
          accessibilityLabel={canvasAccessibilityLabel}
          accessibilityHint={
            settings.talkGesture === 'hold'
              ? 'Press and hold anywhere to talk. Two-finger double-tap to pause or resume.'
              : 'Tap anywhere to talk. Swipe up to scan ahead. Swipe down to orient yourself. Double-tap to pause or resume. Swipe left or right to switch mode.'
          }
          accessibilityActions={[
            { name: 'activate', label: 'Talk to NearDar' },
            { name: 'scanAhead', label: 'Scan ahead now' },
            { name: 'orientMe', label: 'Orient me — where am I and what is around me' },
            { name: 'magicTap', label: satnav.active ? 'Pause satnav' : 'Resume satnav' },
            { name: 'cycleMode', label: 'Switch guidance mode' },
            { name: 'checkPath', label: 'Check path clearance' },
            { name: 'repeat', label: 'Repeat last message' },
          ]}
          onAccessibilityAction={({ nativeEvent }) => {
            switch (nativeEvent.actionName) {
              case 'activate': void satnav.beginTalk(); break
              case 'scanAhead': void satnav.quickScanAhead(); break
              case 'orientMe': void satnav.orientMe(true); break
              case 'magicTap': void satnav.togglePause(); break
              case 'cycleMode': void satnav.cycleMode(1); break
              case 'checkPath': void satnav.submitCommand('Which way is open?'); break
              case 'repeat': void satnav.submitCommand('Repeat'); break
            }
          }}
          style={[
            styles.canvas,
            {
              backgroundColor: satnav.listening ? colors.raised : colors.panel,
              borderColor: satnav.listening ? colors.accent : satnav.fused.primaryHazard?.severity === 'urgent' ? colors.stop : colors.divider,
            },
          ]}
        >
          <RadarHud
            corridor={satnav.snapshot?.corridor}
            snapshot={satnav.snapshot}
            fused={satnav.fused}
            headingDegrees={satnav.headingDegrees}
            distanceUnit={settings.distanceUnit}
            active={satnav.active}
          />

          <View style={styles.captionZone}>
            <View style={styles.stateChip}>
              <Icon
                name={satnav.listening ? 'mic' : satnav.thinking ? 'sparkles' : satnav.speaking ? 'volume-high' : 'hand-left-outline'}
                size={18}
                color={satnav.listening ? colors.accent : colors.muted}
              />
              <Text style={[styles.stateChipText, { color: satnav.listening ? colors.accent : colors.muted }]}>
                {satnav.listening
                  ? 'Listening (tap again to finish)'
                  : satnav.thinking
                    ? (satnav.usingTensorFoldEngine ? 'TensorFold analyzing view…' : 'On-device vision analyzing…')
                    : satnav.speaking
                      ? 'Speaking (tap to interrupt)'
                      : satnav.fused.standby
                        ? 'Camera lowered · Tap to talk'
                        : settings.talkGesture === 'hold'
                          ? 'Hold anywhere to talk · Swipe for mode'
                          : 'Tap to talk · Swipe up scan · Down orient'}
              </Text>
            </View>

            <Text style={[styles.captionText, { color: colors.text }]} numberOfLines={5}>
              {primaryCaption}
            </Text>

            {satnav.voiceNotice && (
              <Text style={[styles.noticeText, { color: colors.warning }]}>{satnav.voiceNotice}</Text>
            )}
          </View>

          {showCameraPreview && satnav.active && satnav.cameraPreviewAvailable && (
            <CameraPreview
              accessibilityElementsHidden
              aria-hidden
              importantForAccessibility="no-hide-descendants"
              pointerEvents="none"
              style={styles.cameraPreview}
            />
          )}
        </View>

        {/* Permission or Vision Download Helper Row (only when needed) */}
        {satnav.cameraPermissionBlocked && Platform.OS !== 'web' && (
          <Button secondary icon="settings-outline" label="Allow Camera in iOS Settings" onPress={() => void Linking.openSettings().catch(() => {})} />
        )}
        {satnav.vision?.available && satnav.visionStatus.state === 'not-installed' && (
          <Button
            compact
            secondary
            icon="download-outline"
            label={satnav.usingTensorFoldEngine ? 'Download TensorFold Mobile (1.5 GB)' : 'Download offline vision model (363 MB)'}
            onPress={() => router.push('/offline')}
          />
        )}
        {satnav.voiceModelMissing && Platform.OS === 'android' && (
          <Button compact secondary icon="download-outline" label="Download offline speech" busy={satnav.speechDownloadPending} onPress={() => void satnav.downloadOfflineSpeech()} />
        )}

        {/* Minimal 3-Button Bottom Dock */}
        <View style={[styles.dock, { borderTopColor: colors.divider }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Navigate to a destination or saved place"
            onPress={() => setNavSheetOpen(true)}
            style={({ pressed }) => [styles.dockBtn, { backgroundColor: colors.panel, borderColor: colors.border }, pressed && styles.pressed]}
          >
            <Icon name="navigate-outline" size={24} color={colors.text} />
            <Text style={[styles.dockLabel, { color: colors.text }]}>Navigate</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={satnav.listening ? 'Stop listening and send' : 'Talk to NearDar'}
            onPress={() => { if (settings.talkGesture === 'tap') void satnav.beginTalk() }}
            onPressIn={() => { if (settings.talkGesture === 'hold') void satnav.beginTalk() }}
            onPressOut={() => { if (settings.talkGesture === 'hold') void satnav.endTalk() }}
            style={({ pressed }) => [
              styles.dockPrimary,
              { backgroundColor: satnav.listening ? colors.stop : colors.accent },
              pressed && styles.pressed,
            ]}
          >
            <Icon name={satnav.listening ? 'mic' : 'mic-outline'} size={28} color={colors.ink} />
            <Text style={[styles.dockPrimaryLabel, { color: colors.ink }]}>
              {satnav.listening ? 'Listening' : 'Talk'}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={satnav.active ? 'Pause satnav and sensors' : 'Resume satnav and sensors'}
            onPress={() => void satnav.togglePause()}
            style={({ pressed }) => [
              styles.dockBtn,
              { backgroundColor: satnav.active ? colors.stopSurface : colors.raised, borderColor: satnav.active ? colors.stop : colors.accent },
              pressed && styles.pressed,
            ]}
          >
            <Icon name={satnav.active ? 'pause-circle-outline' : 'play-circle-outline'} size={24} color={satnav.active ? colors.stop : colors.accent} />
            <Text style={[styles.dockLabel, { color: satnav.active ? colors.stop : colors.accent }]}>
              {satnav.active ? 'Pause' : 'Start'}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Accessible Destination & Offline Places Sheet */}
      <Modal
        visible={navSheetOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setNavSheetOpen(false)}
      >
        <SafeAreaView style={[styles.modalSafe, { backgroundColor: colors.background }]}>
          <View style={styles.modalHeader}>
            <Label>Navigate</Label>
            <Button compact secondary label="Close" onPress={() => setNavSheetOpen(false)} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.modalBody}>
            <View style={[styles.modalCard, { backgroundColor: colors.panel, borderColor: colors.divider }]}>
              <Label>Go to a place</Label>
              <Body muted>Type a destination or say “Take me to…” anytime from the main screen.</Body>
              <TextInput
                accessibilityLabel="Destination address or place name"
                value={destinationInput}
                onChangeText={setDestinationInput}
                onSubmitEditing={handleSubmitDestination}
                returnKeyType="go"
                placeholder="Nearest pharmacy, Costa Coffee, Home…"
                placeholderTextColor={colors.muted}
                style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
              />
              <Button icon="navigate-outline" label="Start Walking Route" disabled={!destinationInput.trim()} onPress={handleSubmitDestination} />
            </View>

            {/* Quick Street Assistants & Everyday Companion Skills */}
            <View style={[styles.modalCard, { backgroundColor: colors.panel, borderColor: colors.divider }]}>
              <Label>Street Assistants</Label>
              <Body muted>One tap or say “find the door”, “help me cross”, “watch for bus 73”, or “describe the view”.</Body>
              <View style={styles.skillGrid}>
                <Button
                  compact
                  secondary
                  icon="enter-outline"
                  label="Find the door"
                  onPress={() => {
                    setNavSheetOpen(false)
                    void satnav.runSkill('door-finder', route?.route.destinationName)
                  }}
                />
                <Button
                  compact
                  secondary
                  icon="walk-outline"
                  label="Crossing assistant"
                  onPress={() => {
                    setNavSheetOpen(false)
                    void satnav.runSkill('crossing')
                  }}
                />
                <Button
                  compact
                  secondary
                  icon="bus-outline"
                  label="Transit / Bus"
                  onPress={() => {
                    setNavSheetOpen(false)
                    void satnav.runSkill('transit')
                  }}
                />
                <Button
                  compact
                  secondary
                  icon="color-palette-outline"
                  label="Describe view"
                  onPress={() => {
                    setNavSheetOpen(false)
                    void satnav.runSkill('vivid')
                  }}
                />
                <Button
                  compact
                  secondary
                  icon="flashlight-outline"
                  label={satnav.torchEnabled ? 'Torch off' : 'Torch on'}
                  onPress={() => void satnav.toggleTorch()}
                />
                <Button
                  compact
                  secondary
                  icon="share-social-outline"
                  label="Share location"
                  onPress={() => {
                    setNavSheetOpen(false)
                    void satnav.shareLocationWithContact()
                  }}
                />
              </View>
            </View>

            {/* Quick Orientation & Offline Return */}
            <View style={[styles.modalCard, { backgroundColor: colors.panel, borderColor: colors.divider }]}>
              <Label>Get Your Bearings</Label>
              <Body muted>
                Hear your street address, compass heading, and what is immediately around you—or trace your breadcrumbs back offline.
              </Body>
              <Button
                secondary
                icon="compass-outline"
                label="Orient me (I’m lost)"
                onPress={() => {
                  setNavSheetOpen(false)
                  void satnav.orientMe(true)
                }}
              />
              <Button
                secondary
                icon="return-up-back-outline"
                label={satnav.breadcrumbCount >= 2 ? `Take me back (${satnav.breadcrumbCount} breadcrumbs)` : 'Take me back to where I started'}
                disabled={satnav.breadcrumbCount < 2}
                onPress={() => {
                  setNavSheetOpen(false)
                  void satnav.navigateBack()
                }}
              />
            </View>

            {/* Saved Places (Offline-ready) */}
            <View style={[styles.modalCard, { backgroundColor: colors.panel, borderColor: colors.divider }]}>
              <Label>Saved Places (Works Offline)</Label>
              {satnav.savedPlaces.length === 0 ? (
                <Body muted>No saved places yet. Save where you are standing now for offline beacon and route guidance.</Body>
              ) : (
                satnav.savedPlaces.map((place) => (
                  <Button
                    key={place.id}
                    row
                    secondary
                    icon="location-outline"
                    label={place.name}
                    onPress={() => {
                      setNavSheetOpen(false)
                      void satnav.navigateToSavedPlace(place)
                    }}
                  />
                ))
              )}
              <TextInput
                accessibilityLabel="Name for current location"
                value={placeNameInput}
                onChangeText={setPlaceNameInput}
                onSubmitEditing={handleSavePlace}
                placeholder="Save current spot as (e.g. Home)"
                placeholderTextColor={colors.muted}
                style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
              />
              <Button compact secondary icon="bookmark-outline" label="Save Current Location" disabled={!placeNameInput.trim()} onPress={handleSavePlace} />
            </View>

            {satnav.active && satnav.cameraPreviewAvailable && (
              <Button
                compact
                secondary
                icon="eye-outline"
                label={showCameraPreview ? 'Hide sighted camera preview' : 'Show sighted camera preview'}
                onPress={() => setShowCameraPreview(!showCameraPreview)}
              />
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  shell: { flex: 1, width: '100%', maxWidth: 560, alignSelf: 'center', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, gap: 12 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  topStatus: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: 1 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, borderWidth: 1 },
  pillText: { fontSize: 13, fontWeight: '700' },
  routeCard: { borderRadius: 18, borderWidth: 1.5, padding: 14, gap: 6 },
  routeHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  routeMeta: { flex: 1, gap: 2 },
  routeDest: { fontSize: 19, fontWeight: '800' },
  routeDist: { fontSize: 14, fontWeight: '700' },
  routeStep: { fontSize: 17, lineHeight: 23, fontWeight: '600' },
  canvas: { flex: 1, borderRadius: 26, borderWidth: 2, padding: 16, justifyContent: 'space-between', gap: 14 },
  captionZone: { flex: 1, justifyContent: 'center', gap: 10 },
  stateChip: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stateChipText: { fontSize: 14, fontWeight: '700' },
  captionText: { fontSize: 23, lineHeight: 31, fontWeight: '700' },
  noticeText: { fontSize: 15, lineHeight: 21, fontWeight: '600' },
  cameraPreview: { width: '100%', height: 140, borderRadius: 14, overflow: 'hidden', backgroundColor: '#000' },
  dock: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 10, borderTopWidth: 1 },
  dockBtn: { flex: 1, minHeight: 68, borderRadius: 18, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 8 },
  dockPrimary: { flex: 1.35, minHeight: 72, borderRadius: 22, alignItems: 'center', justifyContent: 'center', gap: 3, paddingHorizontal: 10 },
  dockLabel: { fontSize: 14, fontWeight: '700' },
  dockPrimaryLabel: { fontSize: 16, fontWeight: '800' },
  pressed: { opacity: 0.8 },
  modalSafe: { flex: 1 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14 },
  modalBody: { paddingHorizontal: 20, paddingBottom: 32, gap: 16 },
  modalCard: { borderRadius: 20, borderWidth: 1, padding: 16, gap: 12 },
  input: { minHeight: 54, fontSize: 18, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1.5 },
  skillBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 16, borderWidth: 1.5 },
  skillLabel: { fontSize: 16, fontWeight: '800', flex: 1 },
  skillActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  skillGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  curtainRoot: { flex: 1, backgroundColor: '#000000' },
  curtainCanvas: { flex: 1, backgroundColor: '#000000', justifyContent: 'flex-start', alignItems: 'center', paddingTop: 20 },
  curtainLiftBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, borderWidth: 1, borderColor: '#333333' },
  curtainLiftText: { color: '#888888', fontSize: 13, fontWeight: '700' },
})
