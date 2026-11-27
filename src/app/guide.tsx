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
import { router, useLocalSearchParams } from 'expo-router'
import { requireNativeViewManager } from 'expo-modules-core'
import { Body, Button, Icon, Label, Signal, useColors, type IconName } from '../components/ui'
import { RadarHud } from '../components/RadarHud'
import { useSatnav } from '../lib/satnav/useSatnav'
import { useAppSettings } from '../lib/SettingsContext'
import { formatWalkingDistance } from '../lib/navigation/geo'
import { MOBILITY_SKILLS } from '../lib/satnav/modes'
import { getWebDemoOverride } from '../lib/satnav/webDemo'
import type { SatnavMode } from '../lib/guidance/types'

function CameraPreview(props: ViewProps) {
  const [Preview] = useState(() => requireNativeViewManager<ViewProps & { playing: boolean }>('TensorFoldPerception'))
  return <Preview {...props} playing />
}

const MODE_LABELS: Record<SatnavMode, string> = {
  satnav: 'Satnav',
  quiet: 'Quiet',
  explore: 'Explore',
}

function SkillTile({
  icon,
  label,
  active = false,
  onPress,
}: {
  icon: IconName
  label: string
  active?: boolean
  onPress(): void
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.skillTile,
        {
          backgroundColor: active ? colors.accentSoft : colors.raised,
          borderColor: active ? colors.accent : 'transparent',
        },
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.skillTileIcon, { backgroundColor: active ? colors.accent : colors.panel }]}>
        <Icon name={icon} size={20} color={active ? colors.ink : colors.accent} />
      </View>
      <Text numberOfLines={1} style={[styles.skillTileLabel, { color: colors.text }]}>
        {label}
      </Text>
    </Pressable>
  )
}

export default function SatnavGuide() {
  const satnav = useSatnav()
  const { settings, update } = useAppSettings()
  const params = useLocalSearchParams<{ demo?: string }>()
  const webDemo = Platform.OS === 'web' ? getWebDemoOverride(typeof params.demo === 'string' ? params.demo : undefined) : undefined
  const colors = useColors()

  const [navSheetOpen, setNavSheetOpen] = useState(Boolean(webDemo?.openSheet))
  const [destinationInput, setDestinationInput] = useState('')
  const [placeNameInput, setPlaceNameInput] = useState('')
  const [showCameraPreview, setShowCameraPreview] = useState(false)

  useEffect(() => {
    if (!webDemo) return
    const wantOled = Boolean(webDemo.forceOled)
    if (wantOled !== settings.oledHighContrast) {
      void update({ oledHighContrast: wantOled })
    }
    setNavSheetOpen(Boolean(webDemo.openSheet))
  }, [webDemo, settings.oledHighContrast, update])

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
      if (Math.abs(gesture.dx) >= 70 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.4) {
        if (tapTimerRef.current) {
          clearTimeout(tapTimerRef.current)
          tapTimerRef.current = null
        }
        void satnavRef.current.cycleMode(gesture.dx > 0 ? 1 : -1)
        return
      }
      if (gesture.dy <= -75 && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.4) {
        if (tapTimerRef.current) {
          clearTimeout(tapTimerRef.current)
          tapTimerRef.current = null
        }
        void satnavRef.current.quickScanAhead()
        return
      }
      if (gesture.dy >= 75 && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.4) {
        if (tapTimerRef.current) {
          clearTimeout(tapTimerRef.current)
          tapTimerRef.current = null
        }
        void satnavRef.current.orientMe(true)
        return
      }
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

  const isActive = webDemo ? true : satnav.active
  const isCameraReady = webDemo ? true : satnav.cameraReady
  const liveSnapshot = webDemo?.snapshot ?? satnav.snapshot
  const liveFused = webDemo?.fused ?? satnav.fused
  const liveHeading = webDemo?.headingDegrees ?? satnav.headingDegrees
  const liveSkill = webDemo?.activeSkill ?? satnav.activeSkill
  const route = webDemo?.routeProgress ?? satnav.routeProgress
  const routeActive = Boolean(route && route.active && !route.arrived)
  const headphones = webDemo ? webDemo.headphones : satnav.voice?.route === 'headphones'
  const urgentAlert = liveFused.primaryHazard?.severity === 'urgent'

  const primaryCaption = satnav.listening
    ? (satnav.partialTranscript ? `“${satnav.partialTranscript}”` : 'Listening… ask anything or say a destination.')
    : satnav.thinking
      ? (satnav.lastReply?.text || 'Looking at what is ahead…')
      : webDemo?.caption || satnav.lastReply?.text || liveFused.summary || satnav.statusMessage

  const canvasAccessibilityLabel = [
    isActive ? `${MODE_LABELS[satnav.mode]} mode active.` : 'Satnav paused.',
    routeActive && route
      ? `Route to ${route.route.destinationName}, ${formatWalkingDistance(route.remainingDistanceMeters, settings.stepLengthMeters, settings.distanceUnit)} left. ${route.currentStep.instruction}.`
      : '',
    liveSkill !== 'none' ? `${MOBILITY_SKILLS[liveSkill].label} active.` : '',
    liveFused.summary,
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
            <Text style={styles.curtainLiftText}>Screen Curtain · Tap to Reveal</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <View style={styles.shell}>
        {/* Sleek Single-Row Header */}
        <View style={styles.topBar}>
          <View style={styles.topPills}>
            <Signal tone={isActive ? (liveFused.standby ? 'quiet' : isCameraReady ? 'ready' : 'attention') : 'quiet'}>
              {isActive ? (liveFused.standby ? 'Standby' : isCameraReady ? 'LiDAR' : 'Starting') : 'Paused'}
            </Signal>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Guidance mode: ${MODE_LABELS[satnav.mode]}. Activate to switch mode.`}
              onPress={() => void satnav.cycleMode(1)}
              style={({ pressed }) => [
                styles.modePill,
                { backgroundColor: colors.panel, borderColor: colors.border },
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.modePillText, { color: colors.text }]}>{MODE_LABELS[satnav.mode]}</Text>
            </Pressable>

            {headphones && settings.spatialBeacon && (
              <View
                accessible
                accessibilityLabel="3D headphone spatial beacon active"
                style={[styles.spatialBadge, { backgroundColor: colors.accentSoft }]}
              >
                <Icon name="headset-outline" size={14} color={colors.accent} />
                <Text style={[styles.spatialBadgeText, { color: colors.accent }]}>3D</Text>
              </View>
            )}
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings"
            onPress={openSettings}
            style={({ pressed }) => [
              styles.settingsCircle,
              { backgroundColor: colors.panel, borderColor: colors.border },
              pressed && styles.pressed,
            ]}
          >
            <Icon name="settings-outline" size={20} color={colors.text} />
          </Pressable>
        </View>

        {/* Sleek Walking Turn-by-Turn Strip */}
        {routeActive && route && (
          <View style={[styles.routeCard, { backgroundColor: colors.panel, borderColor: colors.divider }]}>
            <View style={[styles.routeIconWrap, { backgroundColor: colors.accentSoft }]}>
              <Icon name="navigate" size={20} color={colors.accent} />
            </View>
            <View style={styles.routeBody}>
              <View style={styles.routeTitleRow}>
                <Text numberOfLines={1} style={[styles.routeDest, { color: colors.text }]}>
                  {route.route.destinationName}
                </Text>
                <Text style={[styles.routeDist, { color: colors.accent }]}>
                  {formatWalkingDistance(route.remainingDistanceMeters, settings.stepLengthMeters, settings.distanceUnit)}
                </Text>
              </View>
              <Text numberOfLines={2} style={[styles.routeStep, { color: colors.muted }]}>
                {route.offRoute ? 'Off route — follow the beacon to rejoin.' : route.currentStep.instruction}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="End walking route"
              onPress={() => void satnav.cancelRoute()}
              style={({ pressed }) => [styles.routeClose, { backgroundColor: colors.raised }, pressed && styles.pressed]}
            >
              <Icon name="close" size={16} color={colors.muted} />
            </Pressable>
          </View>
        )}

        {/* Compact Active Skill Strip */}
        {liveSkill !== 'none' && (
          <View style={[styles.skillStrip, { backgroundColor: colors.accentSoft }]}>
            <View style={styles.skillStripLeft}>
              <Icon name="sparkles" size={15} color={colors.accent} />
              <Text numberOfLines={1} style={[styles.skillStripText, { color: colors.accent }]}>
                {liveSkill === 'transit' && satnav.watchedBus
                  ? `Watching Bus ${satnav.watchedBus}`
                  : MOBILITY_SKILLS[liveSkill].label}
              </Text>
            </View>
            <View style={styles.skillStripActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Re-scan"
                onPress={() => void satnav.runSkill(liveSkill, satnav.watchedBus)}
                style={[styles.miniPill, { backgroundColor: colors.panel }]}
              >
                <Text style={[styles.miniPillText, { color: colors.text }]}>Scan</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close assistant"
                onPress={satnav.clearSkill}
                style={[styles.miniPill, { backgroundColor: colors.panel }]}
              >
                <Text style={[styles.miniPillText, { color: colors.muted }]}>Done</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Unified Eyes-Free Spatial Stage (Single Clean Surface, Zero Nested Wireframes) */}
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
            styles.stage,
            {
              backgroundColor: urgentAlert ? colors.stopSurface : colors.panel,
              borderColor: satnav.listening ? colors.accent : urgentAlert ? colors.stop : colors.divider,
              borderWidth: satnav.listening || urgentAlert ? 1.5 : StyleSheet.hairlineWidth,
            },
          ]}
        >
          <RadarHud
            corridor={liveSnapshot?.corridor}
            snapshot={liveSnapshot}
            fused={liveFused}
            headingDegrees={liveHeading}
            distanceUnit={settings.distanceUnit}
            active={isActive}
          />

          <View style={[styles.stageDivider, { backgroundColor: colors.divider }]} />

          <View style={styles.captionZone}>
            <Text style={[styles.captionText, { color: colors.text }]} numberOfLines={4}>
              {primaryCaption}
            </Text>

            <View style={styles.gestureHintRow}>
              <Icon
                name={satnav.listening ? 'mic' : satnav.thinking ? 'sparkles' : satnav.speaking ? 'volume-high' : 'radio-outline'}
                size={14}
                color={satnav.listening ? colors.accent : colors.muted}
              />
              <Text style={[styles.gestureHintText, { color: satnav.listening ? colors.accent : colors.muted }]}>
                {satnav.listening
                  ? 'Listening · tap to send'
                  : satnav.thinking
                    ? (satnav.usingTensorFoldEngine ? 'TensorFold analyzing…' : 'Analyzing view…')
                    : satnav.speaking
                      ? 'Speaking · tap to interrupt'
                      : liveFused.standby
                        ? 'Lowered · tap anywhere to talk'
                        : settings.talkGesture === 'hold'
                          ? 'Hold to talk · swipe for mode'
                          : 'Tap to talk · swipe up scan · down orient'}
              </Text>
            </View>

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

        {/* Inline Setup / Permission Pills (Only when needed) */}
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

        {/* Modern Floating Control Dock */}
        <View style={styles.dock}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Navigate and Street Assistants"
            onPress={() => setNavSheetOpen(true)}
            style={({ pressed }) => [
              styles.dockSide,
              { backgroundColor: colors.panel, borderColor: colors.border },
              pressed && styles.pressed,
            ]}
          >
            <Icon name="compass-outline" size={24} color={colors.text} />
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={satnav.listening ? 'Stop listening and send' : 'Talk to NearDar'}
            onPress={() => { if (settings.talkGesture === 'tap') void satnav.beginTalk() }}
            onPressIn={() => { if (settings.talkGesture === 'hold') void satnav.beginTalk() }}
            onPressOut={() => { if (settings.talkGesture === 'hold') void satnav.endTalk() }}
            style={({ pressed }) => [
              styles.dockTalk,
              { backgroundColor: satnav.listening ? colors.stop : colors.accent },
              pressed && styles.pressed,
            ]}
          >
            <Icon name={satnav.listening ? 'mic' : 'mic-outline'} size={24} color={satnav.listening ? '#FFFFFF' : colors.ink} />
            <Text style={[styles.dockTalkText, { color: satnav.listening ? '#FFFFFF' : colors.ink }]}>
              {satnav.listening ? 'Listening' : 'Talk'}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isActive ? 'Pause satnav and sensors' : 'Resume satnav and sensors'}
            onPress={() => void satnav.togglePause()}
            style={({ pressed }) => [
              styles.dockSide,
              {
                backgroundColor: isActive ? colors.panel : colors.accentSoft,
                borderColor: isActive ? colors.border : colors.accent,
              },
              pressed && styles.pressed,
            ]}
          >
            <Icon
              name={isActive ? 'pause' : 'play'}
              size={22}
              color={isActive ? colors.text : colors.accent}
            />
          </Pressable>
        </View>
      </View>

      {/* Accessible Navigation & Street Assistants Sheet */}
      <Modal
        visible={navSheetOpen}
        animationType={webDemo?.openSheet ? 'none' : 'slide'}
        presentationStyle="pageSheet"
        onRequestClose={() => setNavSheetOpen(false)}
      >
        <SafeAreaView style={[styles.modalSafe, { backgroundColor: colors.background }]}>
          <View style={styles.modalHeader}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Explore &amp; Navigate</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={() => setNavSheetOpen(false)}
              style={({ pressed }) => [
                styles.modalClose,
                { backgroundColor: colors.panel, borderColor: colors.border },
                pressed && styles.pressed,
              ]}
            >
              <Icon name="close" size={20} color={colors.text} />
            </Pressable>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={styles.modalBody}>
            {/* Go to a Place */}
            <View style={[styles.modalCard, { backgroundColor: colors.panel, borderColor: colors.divider }]}>
              <Text style={[styles.sectionEyebrow, { color: colors.muted }]}>WALKING ROUTE</Text>
              <TextInput
                accessibilityLabel="Destination address or place name"
                value={destinationInput}
                onChangeText={setDestinationInput}
                onSubmitEditing={handleSubmitDestination}
                returnKeyType="go"
                placeholder="Pharmacy, coffee shop, station…"
                placeholderTextColor={colors.muted}
                style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
              />
              <Button icon="navigate" label="Start Walking Route" disabled={!destinationInput.trim()} onPress={handleSubmitDestination} />
            </View>

            {/* Symmetrical 2-Column Street Assistants Grid */}
            <View style={[styles.modalCard, { backgroundColor: colors.panel, borderColor: colors.divider }]}>
              <Text style={[styles.sectionEyebrow, { color: colors.muted }]}>STREET ASSISTANTS</Text>
              <View style={styles.skillGrid}>
                <SkillTile
                  icon="enter-outline"
                  label="Find Door"
                  active={liveSkill === 'door-finder'}
                  onPress={() => {
                    setNavSheetOpen(false)
                    void satnav.runSkill('door-finder', route?.route.destinationName)
                  }}
                />
                <SkillTile
                  icon="walk-outline"
                  label="Crossing"
                  active={liveSkill === 'crossing'}
                  onPress={() => {
                    setNavSheetOpen(false)
                    void satnav.runSkill('crossing')
                  }}
                />
                <SkillTile
                  icon="bus-outline"
                  label="Transit"
                  active={liveSkill === 'transit'}
                  onPress={() => {
                    setNavSheetOpen(false)
                    void satnav.runSkill('transit')
                  }}
                />
                <SkillTile
                  icon="sparkles-outline"
                  label="Vivid View"
                  active={liveSkill === 'vivid'}
                  onPress={() => {
                    setNavSheetOpen(false)
                    void satnav.runSkill('vivid')
                  }}
                />
                <SkillTile
                  icon="flashlight-outline"
                  label={satnav.torchEnabled ? 'Torch On' : 'Torch'}
                  active={satnav.torchEnabled}
                  onPress={() => void satnav.toggleTorch()}
                />
                <SkillTile
                  icon="share-social-outline"
                  label="Share Pin"
                  onPress={() => {
                    setNavSheetOpen(false)
                    void satnav.shareLocationWithContact()
                  }}
                />
              </View>
            </View>

            {/* Orientation & Offline Return */}
            <View style={[styles.modalCard, { backgroundColor: colors.panel, borderColor: colors.divider }]}>
              <Text style={[styles.sectionEyebrow, { color: colors.muted }]}>ORIENTATION &amp; SAFETY</Text>
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
                label={satnav.breadcrumbCount >= 2 ? `Take me back (${satnav.breadcrumbCount} crumbs)` : 'Trace path back offline'}
                disabled={satnav.breadcrumbCount < 2}
                onPress={() => {
                  setNavSheetOpen(false)
                  void satnav.navigateBack()
                }}
              />
            </View>

            {/* Saved Places */}
            <View style={[styles.modalCard, { backgroundColor: colors.panel, borderColor: colors.divider }]}>
              <Label>Saved Places</Label>
              {satnav.savedPlaces.length === 0 ? (
                <Body muted>Bookmark where you stand for offline compass and walking guidance.</Body>
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
              <Button compact secondary icon="bookmark-outline" label="Save Spot" disabled={!placeNameInput.trim()} onPress={handleSavePlace} />
            </View>

            {satnav.active && satnav.cameraPreviewAvailable && (
              <Button
                compact
                secondary
                icon="eye-outline"
                label={showCameraPreview ? 'Hide camera preview' : 'Show camera preview'}
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
  shell: {
    flex: 1,
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 14,
    gap: 12,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    minHeight: 42,
  },
  topPills: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  modePill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  modePillText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: -0.1,
  },
  spatialBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 999,
  },
  spatialBadgeText: {
    fontSize: 12,
    fontWeight: '800',
  },
  settingsCircle: {
    width: 40,
    height: 40,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  routeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
  },
  routeIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  routeBody: { flex: 1, gap: 3 },
  routeTitleRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  routeDest: { fontSize: 16, fontWeight: '800', letterSpacing: -0.3, flex: 1 },
  routeDist: { fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] },
  routeStep: { fontSize: 14, lineHeight: 19, fontWeight: '500' },
  routeClose: {
    width: 30,
    height: 30,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skillStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 16,
  },
  skillStripLeft: { flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1 },
  skillStripText: { fontSize: 14, fontWeight: '800', letterSpacing: -0.1, flex: 1 },
  skillStripActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  miniPill: { paddingHorizontal: 11, paddingVertical: 5, borderRadius: 999 },
  miniPillText: { fontSize: 12, fontWeight: '700' },
  stage: {
    flex: 1,
    borderRadius: 28,
    padding: 20,
    justifyContent: 'space-between',
    gap: 16,
  },
  stageDivider: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
  },
  captionZone: {
    flex: 1,
    justifyContent: 'center',
    gap: 12,
  },
  captionText: {
    fontSize: 22,
    lineHeight: 30,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  gestureHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  gestureHintText: {
    fontSize: 13,
    fontWeight: '600',
  },
  noticeText: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  cameraPreview: { width: '100%', height: 132, borderRadius: 16, overflow: 'hidden', backgroundColor: '#000' },
  dock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 2,
  },
  dockSide: {
    width: 58,
    height: 58,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dockTalk: {
    flex: 1,
    height: 58,
    borderRadius: 999,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  dockTalkText: {
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  pressed: { opacity: 0.78, transform: [{ scale: 0.98 }] },
  modalSafe: { flex: 1 },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  modalTitle: { fontSize: 24, fontWeight: '800', letterSpacing: -0.6 },
  modalClose: {
    width: 38,
    height: 38,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBody: { paddingHorizontal: 18, paddingBottom: 36, gap: 14 },
  modalCard: { borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, padding: 18, gap: 12 },
  sectionEyebrow: { fontSize: 12, fontWeight: '700', letterSpacing: 1.1 },
  input: {
    minHeight: 50,
    fontSize: 16,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  skillGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  skillTile: {
    width: '48%',
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
  },
  skillTileIcon: {
    width: 36,
    height: 36,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skillTileLabel: {
    fontSize: 14,
    fontWeight: '700',
    flex: 1,
  },
  curtainRoot: { flex: 1, backgroundColor: '#000000' },
  curtainCanvas: { flex: 1, backgroundColor: '#000000', justifyContent: 'flex-start', alignItems: 'center', paddingTop: 24 },
  curtainLiftBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999, backgroundColor: '#121212' },
  curtainLiftText: { color: '#9CA3AF', fontSize: 13, fontWeight: '700' },
})
