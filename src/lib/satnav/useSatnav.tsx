import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AccessibilityInfo, Linking, Platform, Share } from 'react-native'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import * as Perception from '../../../modules/tensorfold-perception/src'
import * as Voice from '../../../modules/tensorfold-voice/src'
import * as Engine from '../../../modules/tensorfold-engine/src'
import * as Vision from '../../../modules/tensorfold-vision/src'
import * as Haptics from '../../../modules/tensorfold-haptics/src'
import * as Nav from '../../../modules/tensorfold-navigation/src'
import { useAppSettings } from '../SettingsContext'
import { useVisionModel } from '../guidance/useVisionModel'
import { useTensorFoldEngine } from './useTensorFoldEngine'
import { WarningGate, warningIsCurrent } from '../guidance/alerts'
import { describeCurrentLocation } from '../guidance/location'
import { cameraRecoveryHint } from '../guidance/scene'
import { headphonesDisconnected, microphoneRetryNotice, voiceErrorCode } from '../guidance/voiceFeedback'
import { announce } from '../accessibility'
import { cardinalDirection, formatWalkingDistance, haversineMeters } from '../navigation/geo'
import {
  buildBreadcrumbReturnRoute,
  buildDirectBeaconRoute,
  cacheWalkingRoute,
  clearCachedRoutes,
  findOfflineCachedRoute,
  findSavedPlaceByName,
  loadCachedRoutes,
  loadSavedPlaces,
  removeSavedPlace,
  savePlace,
  type SavedPlace,
} from '../navigation/store'
import {
  computeIndoorGuidance,
  findIndoorAnchorByLabel,
  loadIndoorAnchors,
  saveIndoorAnchor,
  type IndoorAnchor,
} from '../navigation/indoor'
import { WalkingRouteTracker, type RouteProgress } from '../navigation/tracker'
import { fuseSatnavGuidance, type FusedSatnavGuidance } from '../navigation/fusion'
import { parseSatnavIntent } from './intents'
import {
  detectLivePresence,
  directionToBearing,
  formatHazardCallout,
  SpeechArbitrator,
  type SpeechRequest,
  type SpeechTier,
} from './arbitrator'
import { formatNarrationOutput, StreetNarrator, type NarrationTask } from './narrator'
import {
  applyProfilePatch,
  MOBILITY_PROFILES,
  shouldAnnounceHazardForProfile,
  shouldAnnouncePresenceForProfile,
} from './profiles'
import {
  buildEmergencyCallUrl,
  buildEmergencySmsUrl,
  buildLocationShareMessage,
} from './emergency'
import {
  buildMobilitySkillPrompt,
  formatBusMatchAnnouncement,
  formatDoorFinderSuggestion,
  formatDoorTelemetryFallback,
  formatMobilitySkillOutput,
  matchWatchedBusNumber,
  normalizeBusNumber,
  shouldAutoSuggestDoorFinder,
  type ActiveMobilitySkill,
} from './modes'
import {
  buildConversationalVisionPrompt,
  buildFastCorridorReply,
  buildSatnavSystemPrompt,
  buildSatnavUserPrompt,
  sanitizeSpokenVisionOutput,
  SentenceStreamSplitter,
  type ConversationTurn,
} from './prompts'
import type {
  DepthSource,
  EngineCapabilities,
  EngineStatus,
  LightingState,
  MobilityProfile,
  SatnavMode,
  SceneSnapshot,
  SceneWarning,
  SessionState,
  ThermalState,
  VoiceCapabilities,
} from '../guidance/types'

const SILENCE_CODES = new Set(['ERR_RECOGNITION_NO_MATCH', 'ERR_RECOGNITION_SPEECH_TIMEOUT', 'E_RECOGNITION_1110'])

export interface SatnavReply {
  text: string
  question?: string
  streaming?: boolean
  at: number
}

export interface SatnavController {
  state: SessionState
  active: boolean
  paused: boolean
  cameraReady: boolean
  cameraPreviewAvailable: boolean
  cameraPermissionBlocked: boolean
  statusMessage: string
  listening: boolean
  speaking: boolean
  thinking: boolean
  partialTranscript: string
  voiceNotice?: string
  voiceModelMissing: boolean
  speechDownloadPending: boolean
  snapshot?: SceneSnapshot
  location?: Nav.GeoPoint & { accuracyMeters?: number }
  headingDegrees?: number
  routeProgress?: RouteProgress
  fused: FusedSatnavGuidance
  lastReply?: SatnavReply
  savedPlaces: SavedPlace[]
  cachedRoutes: Nav.WalkingRoute[]
  breadcrumbCount: number
  vision?: EngineCapabilities
  visionStatus: EngineStatus
  /** True when native TensorFold Mobile (LFM3-VL-2B Metal) is the active local vision+text engine. */
  usingTensorFoldEngine: boolean
  voice?: VoiceCapabilities
  mode: SatnavMode
  activeSkill: ActiveMobilitySkill
  watchedBus?: string
  torchEnabled: boolean
  thermalState: ThermalState
  lightingState: LightingState
  depthSource: DepthSource
  pocketBackgroundActive: boolean
  indoorAnchors: IndoorAnchor[]

  start(): Promise<void>
  pause(silent?: boolean): Promise<void>
  togglePause(): Promise<void>
  beginTalk(): Promise<void>
  endTalk(): Promise<void>
  quickScanAhead(): Promise<void>
  orientMe(includeVision?: boolean): Promise<void>
  runSkill(skill: Exclude<ActiveMobilitySkill, 'none'>, target?: string): Promise<void>
  clearSkill(): void
  toggleTorch(enabled?: boolean): Promise<void>
  toggleScreenCurtain(enabled?: boolean): Promise<void>
  applyMobilityProfile(profile: MobilityProfile): Promise<void>
  shareLocationWithContact(): Promise<void>
  callEmergencyContact(): Promise<void>
  submitCommand(text: string): Promise<void>
  cancelSpeech(): Promise<void>
  cycleMode(direction?: 1 | -1): Promise<void>
  setMode(mode: SatnavMode): Promise<void>
  navigateToDestination(destination: string): Promise<void>
  navigateToSavedPlace(place: SavedPlace): Promise<void>
  navigateBack(): Promise<void>
  cancelRoute(): Promise<void>
  saveCurrentPlace(name: string): Promise<void>
  deleteSavedPlace(id: string): Promise<void>
  clearRouteCache(): Promise<void>
  prepareVisionModel(download?: boolean): Promise<boolean>
  cancelVisionInstall(): Promise<void>
  unloadVisionModel(): Promise<void>
  downloadOfflineSpeech(): Promise<void>
  previewFeedback(
    kind: 'compass-lock' | 'proximity' | 'fast-mover' | 'animal' | 'head-hazard' | 'drop-off' | 'turn-right' | 'arrived',
  ): Promise<void>
}

const SatnavContext = createContext<SatnavController | null>(null)

export function SatnavProvider({ children }: { children: ReactNode }) {
  const { settings, update } = useAppSettings()
  const tensorfold = useTensorFoldEngine()
  const fallbackVision = useVisionModel()
  // Prefer native TensorFold Mobile (LFM3-VL-2B Metal) whenever available with vision; fall back to LiteRT-LM on Android.
  const usingTensorFoldEngine = Boolean(tensorfold.capabilities?.available && tensorfold.capabilities?.vision)
  const usingTensorFoldRef = useRef(usingTensorFoldEngine)
  usingTensorFoldRef.current = usingTensorFoldEngine
  const activeEngineCaps = usingTensorFoldEngine ? tensorfold.capabilities : fallbackVision.capabilities
  const activeEngineStatus = usingTensorFoldEngine ? tensorfold.status : fallbackVision.status
  const activeEngineStatusRef = useRef(activeEngineStatus)
  activeEngineStatusRef.current = activeEngineStatus

  const [state, setState] = useState<SessionState>('idle')
  const [cameraPermissionBlocked, setCameraPermissionBlocked] = useState(false)
  const [cameraPreviewAvailable, setCameraPreviewAvailable] = useState(false)
  const [statusMessage, setStatusMessage] = useState('Starting NearDar satnav.')
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [partialTranscript, setPartialTranscript] = useState('')
  const [voiceNotice, setVoiceNotice] = useState<string>()
  const [voiceModelMissing, setVoiceModelMissing] = useState(false)
  const [speechDownloadPending, setSpeechDownloadPending] = useState(false)
  const [snapshot, setSnapshot] = useState<SceneSnapshot>()
  const [location, setLocation] = useState<(Nav.GeoPoint & { accuracyMeters?: number }) | undefined>()
  const [headingDegrees, setHeadingDegrees] = useState<number | undefined>()
  const [routeProgress, setRouteProgress] = useState<RouteProgress | undefined>()
  const [lastReply, setLastReply] = useState<SatnavReply>()
  const [savedPlaces, setSavedPlaces] = useState<SavedPlace[]>([])
  const [cachedRoutes, setCachedRoutes] = useState<Nav.WalkingRoute[]>([])
  const [indoorAnchors, setIndoorAnchors] = useState<IndoorAnchor[]>([])
  const [breadcrumbCount, setBreadcrumbCount] = useState(0)
  const [voice, setVoice] = useState<VoiceCapabilities>()
  const [activeSkill, setActiveSkill] = useState<ActiveMobilitySkill>('none')
  const [watchedBus, setWatchedBus] = useState<string | undefined>()
  const [torchEnabled, setTorchEnabled] = useState(false)
  const [thermalState, setThermalState] = useState<ThermalState>('nominal')
  const [lightingState, setLightingState] = useState<LightingState>('good')
  const [depthSource, setDepthSource] = useState<DepthSource>('unavailable')
  const [pocketBackgroundActive, setPocketBackgroundActive] = useState(false)

  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const stateRef = useRef<SessionState>('idle')
  stateRef.current = state
  const snapshotRef = useRef<SceneSnapshot | undefined>(undefined)
  snapshotRef.current = snapshot
  const locationRef = useRef<(Nav.GeoPoint & { accuracyMeters?: number }) | undefined>(undefined)
  locationRef.current = location
  const headingRef = useRef<number | undefined>(undefined)
  headingRef.current = headingDegrees
  const savedPlacesRef = useRef<SavedPlace[]>([])
  savedPlacesRef.current = savedPlaces
  const cachedRoutesRef = useRef<Nav.WalkingRoute[]>([])
  cachedRoutesRef.current = cachedRoutes
  const routeProgressRef = useRef<RouteProgress | undefined>(undefined)
  routeProgressRef.current = routeProgress

  const trackerRef = useRef<WalkingRouteTracker | null>(null)
  const breadcrumbsRef = useRef<Nav.GeoPoint[]>([])
  const historyRef = useRef<ConversationTurn[]>([])
  const warningGateRef = useRef(new WarningGate())
  const arbitratorRef = useRef(new SpeechArbitrator())
  const narratorRef = useRef(new StreetNarrator())
  const mountedRef = useRef(true)
  const epochRef = useRef(0)
  const speechCounterRef = useRef(0)
  const listeningRef = useRef(false)
  const thinkingRef = useRef(false)
  const activeVisionReqRef = useRef<string | undefined>(undefined)
  const ambientReqRef = useRef<string | undefined>(undefined)
  const streamSplitterRef = useRef<SentenceStreamSplitter | null>(null)
  const streamedAnyRef = useRef(false)
  const ambientBusyRef = useRef(false)
  const lastCriticalAtRef = useRef(0)
  const lastPresenceCueAtRef = useRef(0)
  const standbyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const standbyAnnouncedRef = useRef(false)
  const lastAimCoachAtRef = useRef(0)
  const lastUrgentCueAtRef = useRef(0)
  const previousRouteKindRef = useRef<VoiceCapabilities['route']>('unknown')
  const thinkingTickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const partialRef = useRef('')
  const handleTranscriptRef = useRef<(text: string) => Promise<void>>(async () => {})
  const beginTalkRef = useRef<() => Promise<void>>(async () => {})
  const quickScanRef = useRef<() => Promise<void>>(async () => {})
  const orientMeRef = useRef<(includeVision?: boolean) => Promise<void>>(async () => {})
  const watchedBusRef = useRef<string | undefined>(undefined)
  watchedBusRef.current = watchedBus
  const lastBusSpotAtRef = useRef(0)
  const lastDarkNoticeAtRef = useRef(0)
  const doorSuggestedRouteIdRef = useRef<string | undefined>(undefined)
  const pocketBgRef = useRef(false)
  const torchEnabledRef = useRef(false)
  torchEnabledRef.current = torchEnabled
  const indoorAnchorsRef = useRef<IndoorAnchor[]>([])
  indoorAnchorsRef.current = indoorAnchors

  const active = state === 'active' || state === 'degraded'
  const paused = state === 'paused' || state === 'idle'
  const cameraReady = active && Boolean(snapshot?.trackingReady && Date.now() - snapshot.observedAt <= 3_000)

  const fused = fuseSatnavGuidance(
    routeProgress,
    snapshot?.corridor,
    snapshot?.hazards,
    {
      hapticSteering: settings.hapticSteering && settings.urgentHaptics,
      hapticProximity: settings.hapticProximity && settings.urgentHaptics,
      spatialBeacon: settings.spatialBeacon,
      beaconHeadphonesOnly: true,
      muted: !active || listening,
    },
  )

  const stopThinkingTicks = useCallback(() => {
    if (thinkingTickTimerRef.current) {
      clearInterval(thinkingTickTimerRef.current)
      thinkingTickTimerRef.current = null
    }
  }, [])

  const startThinkingTicks = useCallback(() => {
    stopThinkingTicks()
    if (!settingsRef.current.urgentHaptics) return
    thinkingTickTimerRef.current = setInterval(() => {
      if (!thinkingRef.current) return
      void Haptics.playCue('thinking-tick').catch(() => {})
    }, 950)
  }, [stopThinkingTicks])

  const cancelAmbientNarration = useCallback(() => {
    if (ambientReqRef.current) {
      const reqId = ambientReqRef.current
      ambientReqRef.current = undefined
      if (usingTensorFoldRef.current) {
        void Engine.cancel(reqId).catch(() => {})
      } else {
        void Vision.cancel(reqId).catch(() => {})
      }
    }
    ambientBusyRef.current = false
  }, [])

  const playSpeechItem = useCallback(async (item: SpeechRequest, interruptNative: boolean) => {
    const utteranceId = `satnav-${item.tier}-${++speechCounterRef.current}`
    if (mountedRef.current) setSpeaking(true)
    const voicePriority: Voice.VoicePriority =
      item.tier === 'critical' ? 'urgent' : item.tier === 'ambient' ? 'ambient' : 'answer'
    try {
      await Voice.speak(item.text, {
        utteranceId,
        voiceIdentifier: settingsRef.current.voiceIdentifier,
        rate: settingsRef.current.speechRate,
        priority: voicePriority,
        interrupt: interruptNative,
        speakerFallback: settingsRef.current.speakerFallback,
      })
    } catch (error) {
      const code = voiceErrorCode(error)
      if (Platform.OS === 'ios' && code !== 'E_AUDIO_ROUTE') {
        announce(item.text, item.tier !== 'critical')
      }
      const next = arbitratorRef.current.onFinished()
      if (next) {
        void playSpeechItem(next, false)
      } else if (mountedRef.current) {
        setSpeaking(false)
      }
    }
  }, [])

  const speak = useCallback(async (
    text: string,
    options: {
      tier?: SpeechTier
      interrupt?: boolean
      urgent?: boolean
      category?: string
      cooldownMs?: number
      record?: boolean
    } = {},
  ) => {
    const cleaned = text.trim()
    if (!cleaned) return
    const tier: SpeechTier = options.urgent ? 'critical' : (options.tier ?? 'interactive')
    const decision = arbitratorRef.current.submit({
      text: cleaned,
      tier,
      interrupt: options.interrupt || options.urgent,
      category: options.category,
      cooldownMs: options.cooldownMs,
      record: options.record,
    })
    if (decision.action === 'dropped' || !decision.item) return
    if (options.record) {
      setLastReply({ text: cleaned, at: Date.now() })
    }
    if (tier === 'critical') {
      lastCriticalAtRef.current = Date.now()
      cancelAmbientNarration()
    }
    if (decision.action === 'speak-now') {
      if (decision.preemptCurrent) {
        await Voice.stopSpeaking().catch(() => {})
      }
      await playSpeechItem(decision.item, decision.preemptCurrent || tier === 'critical')
    }
  }, [cancelAmbientNarration, playSpeechItem])

  const cancelSpeech = useCallback(async () => {
    arbitratorRef.current.cancelAll()
    cancelAmbientNarration()
    stopThinkingTicks()
    if (activeVisionReqRef.current) {
      const reqId = activeVisionReqRef.current
      activeVisionReqRef.current = undefined
      if (usingTensorFoldRef.current) {
        void Engine.cancel(reqId).catch(() => {})
      } else {
        void Vision.cancel(reqId).catch(() => {})
      }
    }
    thinkingRef.current = false
    if (mountedRef.current) setThinking(false)
    await Voice.stopSpeaking().catch(() => {})
    if (mountedRef.current) setSpeaking(false)
  }, [cancelAmbientNarration, stopThinkingTicks])

  // Sync continuous native CoreHaptics + 3D Spatial Audio beacon whenever fused guidance changes
  const hapticActive = fused.hapticState.active
  const hapticSteering = fused.hapticState.steeringEnabled
  const hapticProximity = fused.hapticState.proximityEnabled
  const hapticHeadingOffset = fused.hapticState.headingOffsetDeg
  const hapticClearance = fused.hapticState.forwardClearanceMeters
  const hapticMuted = fused.hapticState.muted
  const beaconActive = fused.spatialBeacon.active
  const beaconAzimuth = fused.spatialBeacon.azimuthDeg
  const beaconDistance = fused.spatialBeacon.distanceMeters
  const beaconHeadphonesOnly = fused.spatialBeacon.headphonesOnly

  useEffect(() => {
    if (!active) {
      void Haptics.stopGuidance().catch(() => {})
      void Voice.stopSpatialAudio().catch(() => {})
      return
    }
    void Haptics.updateGuidance({
      active: hapticActive,
      steeringEnabled: hapticSteering,
      proximityEnabled: hapticProximity,
      headingOffsetDeg: hapticHeadingOffset,
      forwardClearanceMeters: hapticClearance,
      muted: hapticMuted,
    }).catch(() => {})
    void Voice.updateSpatialBeacon({
      active: beaconActive,
      azimuthDeg: beaconAzimuth,
      distanceMeters: beaconDistance,
      headphonesOnly: beaconHeadphonesOnly,
    }).catch(() => {})
  }, [
    active,
    hapticActive,
    hapticSteering,
    hapticProximity,
    hapticHeadingOffset,
    hapticClearance,
    hapticMuted,
    beaconActive,
    beaconAzimuth,
    beaconDistance,
    beaconHeadphonesOnly,
  ])

  // Fire distinct urgent vertical hazard haptic + 3D audio cues with cooldown
  useEffect(() => {
    if (!active || listening) return
    const now = Date.now()
    if (now - lastUrgentCueAtRef.current < 2_200) return
    if (fused.urgentHapticCue && settingsRef.current.urgentHaptics) {
      lastUrgentCueAtRef.current = now
      void Haptics.playCue(fused.urgentHapticCue).catch(() => {})
    }
    if (fused.urgentSpatialCue && settingsRef.current.spatialBeacon) {
      lastUrgentCueAtRef.current = now
      void Voice.playSpatialCue(fused.urgentSpatialCue).catch(() => {})
    }
  }, [active, listening, fused.urgentHapticCue, fused.urgentSpatialCue])

  // Smooth camera-lowered / lens-covered standby: mute LiDAR alerts after 2.5s while keeping route & compass active
  useEffect(() => {
    if (!active) {
      if (standbyTimerRef.current) {
        clearTimeout(standbyTimerRef.current)
        standbyTimerRef.current = null
      }
      standbyAnnouncedRef.current = false
      return
    }
    if (fused.standby) {
      if (!standbyAnnouncedRef.current && !standbyTimerRef.current) {
        const covered = fused.aimState === 'covered'
        standbyTimerRef.current = setTimeout(() => {
          standbyTimerRef.current = null
          standbyAnnouncedRef.current = true
          if (settingsRef.current.urgentHaptics) void Haptics.playCue('standby').catch(() => {})
          void Voice.playSpatialCue({ kind: 'standby' }).catch(() => {})
          if (settingsRef.current.guidanceMode !== 'quiet') {
            void speak(
              covered
                ? 'Camera covered — route and compass stay active.'
                : 'Camera lowered — route and compass stay active.',
              { tier: 'ambient', category: 'standby', cooldownMs: 12_000 },
            )
          }
        }, 2_500)
      }
    } else {
      if (standbyTimerRef.current) {
        clearTimeout(standbyTimerRef.current)
        standbyTimerRef.current = null
      }
      if (standbyAnnouncedRef.current) {
        standbyAnnouncedRef.current = false
        if (settingsRef.current.urgentHaptics) void Haptics.playCue('resumed').catch(() => {})
      }
    }
  }, [active, fused.standby, fused.aimState, speak])

  // Gentle camera aim coaching when tilted too low or too high (silent in lowered/covered standby)
  useEffect(() => {
    if (!active || listening || thinking || fused.standby || settingsRef.current.guidanceMode === 'quiet') return
    if (fused.aimState === 'level') return
    const now = Date.now()
    if (now - lastAimCoachAtRef.current < 14_000) return
    lastAimCoachAtRef.current = now
    const msg = fused.aimState === 'too-low'
      ? 'Tilt your phone slightly up toward eye level.'
      : 'Tilt your phone slightly down toward the path ahead.'
    void speak(msg, { tier: 'ambient', category: 'aim-coach', cooldownMs: 14_000 })
  }, [active, listening, thinking, fused.standby, fused.aimState, speak])

  const applyRouteUpdate = useCallback((pos: Nav.GeoPoint, heading?: number) => {
    const tracker = trackerRef.current
    if (!tracker) return
    const progress = tracker.update(pos, heading)
    routeProgressRef.current = progress
    setRouteProgress(progress)

    // Update Lock Screen / Now Playing status for pocket satnav
    const distUnit = settingsRef.current.distanceUnit
    const remText = formatWalkingDistance(progress.remainingDistanceMeters, settingsRef.current.stepLengthMeters, distUnit)
    void Voice.updateNowPlaying(
      `NearDar · ${progress.route.destinationName}`,
      `${remText} left · ${progress.currentStep.instruction}`,
    ).catch(() => {})

    // Auto-suggest Door Finder in the last 25 metres once per route
    if (
      doorSuggestedRouteIdRef.current !== progress.route.id &&
      shouldAutoSuggestDoorFinder(progress, snapshotRef.current) &&
      settingsRef.current.guidanceMode !== 'quiet'
    ) {
      doorSuggestedRouteIdRef.current = progress.route.id
      const suggestion = formatDoorFinderSuggestion(
        progress.route.destinationName,
        progress.remainingDistanceMeters,
        settingsRef.current.stepLengthMeters,
      )
      void speak(suggestion, { tier: 'navigation', category: 'door-suggest', cooldownMs: 30_000, record: true })
    }

    const ann = progress.announcement
    if (ann) {
      const hapticMap: Partial<Record<typeof ann.kind, Haptics.HapticCue>> = {
        'turn-prepare': 'turn-approaching',
        'turn-left': 'turn-left',
        'turn-right': 'turn-right',
        'turn-now': 'turn-approaching',
        'off-route': 'off-route',
        arrived: 'arrived',
      }
      const spatialMap: Partial<Record<typeof ann.kind, Voice.SpatialCueKind>> = {
        'turn-left': 'turn-left',
        'turn-right': 'turn-right',
        arrived: 'arrived',
      }
      const hc = hapticMap[ann.kind]
      if (hc && settingsRef.current.urgentHaptics) void Haptics.playCue(hc).catch(() => {})
      const sc = spatialMap[ann.kind]
      if (sc) void Voice.playSpatialCue({ kind: sc }).catch(() => {})

      const quietMode = settingsRef.current.guidanceMode === 'quiet'
      if (!quietMode || ann.kind === 'turn-left' || ann.kind === 'turn-right' || ann.kind === 'turn-now' || ann.kind === 'arrived' || ann.kind === 'off-route') {
        setLastReply({ text: ann.message, at: Date.now() })
        void speak(ann.message, {
          tier: 'navigation',
          interrupt: ann.kind === 'turn-left' || ann.kind === 'turn-right' || ann.kind === 'arrived',
        })
      }
      if (progress.arrived) {
        trackerRef.current = null
      }
    }
  }, [speak])

  const startRoute = useCallback(async (route: Nav.WalkingRoute, announceCached = false) => {
    const tracker = new WalkingRouteTracker(route, settingsRef.current.stepLengthMeters)
    trackerRef.current = tracker
    const pos = locationRef.current ?? route.origin
    const progress = tracker.update(pos, headingRef.current)
    routeProgressRef.current = progress
    setRouteProgress(progress)
    const prefix = announceCached ? 'Using offline route. ' : ''
    const msg = `${prefix}${progress.announcement?.message ?? `Navigating to ${route.destinationName}.`}`
    setLastReply({ text: msg, at: Date.now() })
    await speak(msg, { interrupt: true })
  }, [speak])

  const navigateToSavedPlace = useCallback(async (place: SavedPlace) => {
    const origin = locationRef.current
    if (!origin) {
      await speak(`Waiting for GPS before guiding you to ${place.name}.`, { interrupt: true, record: true })
      return
    }
    // 1. Try offline cached route first if close enough
    const cached = findOfflineCachedRoute(cachedRoutesRef.current, place.name, origin)
    // 2. Try fresh online MapKit walking route, caching it for future offline trips
    try {
      const fresh = await Nav.calculateWalkingRoute(origin, { latitude: place.latitude, longitude: place.longitude }, place.name)
      const nextCache = await cacheWalkingRoute(fresh).catch(() => cachedRoutesRef.current)
      setCachedRoutes(nextCache)
      await startRoute(fresh)
      return
    } catch {
      if (cached) {
        await startRoute(cached, true)
        return
      }
      // 3. Fallback: direct offline compass & haptic beacon route
      const beacon = buildDirectBeaconRoute(origin, { latitude: place.latitude, longitude: place.longitude }, place.name)
      await startRoute(beacon, true)
    }
  }, [speak, startRoute])

  const navigateToDestination = useCallback(async (destination: string) => {
    const query = destination.trim()
    if (!query) {
      await speak('Tell me where you want to go, for example, take me to the nearest cafe.', { interrupt: true, record: true })
      return
    }
    const origin = locationRef.current

    // Check saved places first (works 100% offline)
    const saved = findSavedPlaceByName(savedPlacesRef.current, query)
    if (saved) {
      await navigateToSavedPlace(saved)
      return
    }

    // Check offline route cache next if offline or MapKit unavailable
    const cached = origin ? findOfflineCachedRoute(cachedRoutesRef.current, query, origin) : undefined

    try {
      const matches = await Nav.searchPlaces(query, origin)
      const best = matches[0]
      if (!best) {
        if (cached) {
          await startRoute(cached, true)
          return
        }
        await speak(`I could not find ${query} nearby.`, { interrupt: true, record: true })
        return
      }
      if (!origin) {
        await speak(`Found ${best.name}, waiting for your GPS location to start directions.`, { interrupt: true, record: true })
        return
      }
      const route = await Nav.calculateWalkingRoute(origin, { latitude: best.latitude, longitude: best.longitude }, best.name)
      const nextCache = await cacheWalkingRoute(route).catch(() => cachedRoutesRef.current)
      setCachedRoutes(nextCache)
      await startRoute(route)
    } catch {
      if (cached) {
        await startRoute(cached, true)
        return
      }
      await speak(`I couldn’t look up ${query} while offline. Try a saved place or say take me back.`, { interrupt: true, record: true })
    }
  }, [navigateToSavedPlace, speak, startRoute])

  const navigateBack = useCallback(async () => {
    const route = buildBreadcrumbReturnRoute(breadcrumbsRef.current, 'where you started')
    if (!route) {
      await speak('I do not have enough walking breadcrumbs yet to trace a return path.', { interrupt: true, record: true })
      return
    }
    await startRoute(route, true)
  }, [speak, startRoute])

  const cancelRoute = useCallback(async () => {
    trackerRef.current = null
    routeProgressRef.current = undefined
    setRouteProgress(undefined)
    await speak('Route cancelled. Free-roam obstacle guidance stays active.', { interrupt: true, record: true })
  }, [speak])

  const saveCurrentPlace = useCallback(async (name: string) => {
    const pos = locationRef.current
    if (!pos) {
      await speak('I need a GPS fix before saving this spot. Try again in a moment.', { interrupt: true, record: true })
      return
    }
    const next = await savePlace({ name, latitude: pos.latitude, longitude: pos.longitude })
    setSavedPlaces(next)
    await speak(`Saved this spot as ${name}.`, { interrupt: true, record: true })
  }, [speak])

  const deleteSavedPlace = useCallback(async (id: string) => {
    const next = await removeSavedPlace(id)
    setSavedPlaces(next)
  }, [])

  const clearRouteCache = useCallback(async () => {
    await clearCachedRoutes()
    setCachedRoutes([])
  }, [])

  // Background TensorFold Mobile narrator (roadworks, pushbikes, crossings, passing landmarks)
  const runNarrationTask = useCallback(async (task: NarrationTask) => {
    if (ambientBusyRef.current || thinkingRef.current || listeningRef.current) return
    if (activeEngineStatusRef.current.state !== 'ready') return
    ambientBusyRef.current = true
    const reqId = `narrator-${task.kind}-${Date.now()}`
    ambientReqRef.current = reqId

    try {
      const captured = await Perception.captureScene({
        includeImage: true,
        maxImageLongEdge: 384,
        recognizeText: task.kind !== 'hazard-classify',
        detectPeople: false,
      })
      if (ambientReqRef.current !== reqId || listeningRef.current || thinkingRef.current) {
        if (captured.temporaryImagePath) void Perception.releaseCapture(captured.temporaryImagePath).catch(() => {})
        return
      }
      if (!captured.temporaryImagePath && !captured.imageBase64) return
      try {
        const raw = usingTensorFoldRef.current
          ? await Engine.generate({
              requestId: reqId,
              question: task.prompt,
              system: task.system,
              prompt: task.prompt,
              imageBase64: captured.imageBase64,
              temporaryImagePath: captured.temporaryImagePath,
              maxImageTokens: task.maxImageTokens,
              maxTokens: task.maxTokens,
              temperature: task.temperature,
            })
          : await Vision.describeScene({
              requestId: reqId,
              prompt: `${task.system}\n${task.prompt}`,
              imageBase64: captured.imageBase64,
              temporaryImagePath: captured.temporaryImagePath,
              maxTokens: task.maxTokens,
            })

        if (ambientReqRef.current !== reqId || listeningRef.current || thinkingRef.current) return
        const corridor = snapshotRef.current?.corridor
        const msg = formatNarrationOutput(task, raw, {
          directionStyle: settingsRef.current.directionStyle,
          stepLengthMeters: settingsRef.current.stepLengthMeters,
          recommendedHeadingOffsetDeg: corridor?.recommendedHeadingOffsetDeg,
          corridorState: corridor?.corridorState,
        })
        if (msg && settingsRef.current.guidanceMode !== 'quiet') {
          await speak(msg, {
            tier: task.kind === 'crossing-lookahead' ? 'navigation' : 'ambient',
            category: task.category,
            cooldownMs: task.cooldownMs,
            record: true,
          })
        }
      } finally {
        if (captured.temporaryImagePath) {
          void Perception.releaseCapture(captured.temporaryImagePath).catch(() => {})
        }
      }
    } catch {
      // Background street narration is best-effort and completely silent on error
    } finally {
      if (ambientReqRef.current === reqId) ambientReqRef.current = undefined
      ambientBusyRef.current = false
    }
  }, [speak])

  const handleWarning = useCallback(async (warning: SceneWarning) => {
    if (stateRef.current !== 'active' && stateRef.current !== 'degraded') return
    const aim = snapshotRef.current?.aimState
    if (aim === 'lowered' || aim === 'covered') return
    if (!warningIsCurrent(warning)) return
    if (!shouldAnnounceHazardForProfile(warning.kind, warning.severity, warning.distanceMeters, settingsRef.current.mobilityProfile)) {
      return
    }
    if (!warningGateRef.current.accept(warning)) return

    const bearing = directionToBearing(warning.direction ?? 'ahead')
    const style = settingsRef.current.directionStyle
    const stepLen = settingsRef.current.stepLengthMeters
    const unit = settingsRef.current.distanceUnit
    const corridor = snapshotRef.current?.corridor
    const formatted =
      warning.kind === 'sensor'
        ? warning.message
        : formatHazardCallout(
            {
              id: warning.id,
              kind: warning.kind,
              severity: warning.severity,
              direction: warning.direction ?? 'ahead',
              bearingDegrees: bearing,
              distanceMeters: warning.distanceMeters ?? 1.5,
              confidence: 0.85,
              message: warning.message,
              observedAt: warning.observedAt,
              closingSpeedMps: warning.closingSpeedMps,
              externalSpeedMps: warning.externalSpeedMps,
              ttcSeconds: warning.ttcSeconds,
            },
            style,
            stepLen,
            corridor?.corridorState === 'narrow' ? corridor.recommendedHeadingOffsetDeg : undefined,
            unit,
          )

    if (warning.kind === 'fast-mover') {
      cancelAmbientNarration()
      if (settingsRef.current.urgentHaptics) void Haptics.playCue('fast-mover').catch(() => {})
      void Voice.playSpatialCue({
        kind: 'fast-mover',
        azimuthDeg: bearing,
        distanceMeters: warning.distanceMeters ?? 2.0,
      }).catch(() => {})
      await speak(formatted, { tier: 'critical', urgent: true, record: true })
      return
    }

    if (warning.kind === 'head-height' || warning.kind === 'drop-off' || warning.kind === 'step-down') {
      cancelAmbientNarration()
      if (settingsRef.current.urgentHaptics) {
        void Haptics.playCue(warning.kind === 'head-height' ? 'head-hazard' : 'drop-off').catch(() => {})
      }
      void Voice.playSpatialCue({
        kind: warning.kind,
        azimuthDeg: bearing,
        distanceMeters: warning.distanceMeters ?? 1.2,
      }).catch(() => {})
      await speak(formatted, { tier: 'critical', urgent: true, record: true })
      return
    }

    // Standard torso obstacle (speak with named mesh label when available)
    const obstacleText = warning.label ? warning.message : formatted
    if (warning.severity === 'urgent') {
      await speak(obstacleText, { tier: 'critical', urgent: true, record: true })
    } else if (settingsRef.current.guidanceMode !== 'quiet' && !thinkingRef.current) {
      await speak(obstacleText, { tier: 'ambient', category: `obstacle:${warning.direction ?? 'ahead'}`, cooldownMs: 4_500, record: true })
    }

    // Opportunistically ask warm TensorFold Mobile to identify unnamed blocking obstacles (roadworks, bikes, bins, etc.)
    const hazardTask = narratorRef.current.planHazardClassification(warning, {
      ambientObstacleNaming: settingsRef.current.ambientObstacleNaming,
      engineReady: activeEngineStatusRef.current.state === 'ready',
      busy: ambientBusyRef.current || thinkingRef.current,
      listening: listeningRef.current,
      standby: false,
      lightingState: snapshotRef.current?.lightingState,
      proactiveVlmAllowed: snapshotRef.current?.proactiveVlmAllowed,
      mobilityProfile: settingsRef.current.mobilityProfile,
      corridorState: corridor?.corridorState,
      now: Date.now(),
    })
    if (hazardTask) {
      void runNarrationTask(hazardTask)
    }
  }, [cancelAmbientNarration, runNarrationTask, speak])

  const askVisualCompanion = useCallback(async (question: string, readOnlyText = false) => {
    cancelAmbientNarration()
    const reqId = `satnav-tf-${Date.now()}`
    thinkingRef.current = true
    setThinking(true)
    startThinkingTicks()
    setLastReply({ question, text: readOnlyText ? 'Reading visible text…' : 'Looking ahead…', streaming: true, at: Date.now() })

    try {
      const useTensorFold = usingTensorFoldRef.current
      // Ensure TensorFold Mobile (or fallback vision model) is warm if installed
      if (!readOnlyText && (activeEngineStatusRef.current.state === 'installed' || activeEngineStatusRef.current.state === 'loading')) {
        await (useTensorFold ? tensorfold.prepare(false) : fallbackVision.prepare(false))
      }
      const useVlm = !readOnlyText && activeEngineStatusRef.current.state === 'ready'
      const captured = await Perception.captureScene({
        includeImage: useVlm,
        maxImageLongEdge: 512,
        recognizeText: true,
        detectPeople: true,
      })

      if (readOnlyText) {
        const text = captured.recognizedText.join(' ').trim()
        const reply = text
          ? `I can read: ${text.slice(0, 400)}`
          : 'I cannot read clear text here. Hold the camera steadier or move a bit closer.'
        if (captured.temporaryImagePath) void Perception.releaseCapture(captured.temporaryImagePath).catch(() => {})
        setLastReply({ question, text: reply, at: Date.now() })
        await speak(reply, { tier: 'interactive', interrupt: true })
        return
      }

      if (!useVlm || (!captured.temporaryImagePath && !captured.imageBase64)) {
        // Fallback to instant LiDAR + OCR + mesh summary if model is not yet downloaded
        const fallback = buildFastCorridorReply(
          captured,
          routeProgressRef.current,
          settingsRef.current.stepLengthMeters,
          settingsRef.current.directionStyle,
        )
        const ocrHint = captured.recognizedText.length > 0 ? ` Visible text: ${captured.recognizedText.slice(0, 3).join(', ')}.` : ''
        const modelHint = activeEngineStatusRef.current.state === 'not-installed'
          ? ' Download TensorFold Mobile in Settings for full visual answers.'
          : ''
        const reply = `${fallback}${ocrHint}${modelHint}`
        if (captured.temporaryImagePath) void Perception.releaseCapture(captured.temporaryImagePath).catch(() => {})
        setLastReply({ question, text: reply, at: Date.now() })
        await speak(reply, { tier: 'interactive', interrupt: true })
        return
      }

      // Stream TensorFold Mobile (LFM3-VL-2B Metal) response directly into sentence-level TTS!
      activeVisionReqRef.current = reqId
      streamSplitterRef.current = new SentenceStreamSplitter()
      streamedAnyRef.current = false

      const promptContext = {
        snapshot: captured,
        route: routeProgressRef.current,
        headingDeg: headingRef.current,
        stepLengthMeters: settingsRef.current.stepLengthMeters,
        directionStyle: settingsRef.current.directionStyle,
        lightingState: captured.lightingState,
        proactiveVlmAllowed: captured.proactiveVlmAllowed,
        mobilityProfile: settingsRef.current.mobilityProfile,
        history: historyRef.current,
      }

      try {
        const raw = useTensorFold
          ? await Engine.generate({
              requestId: reqId,
              question,
              system: buildSatnavSystemPrompt(settingsRef.current.directionStyle),
              prompt: buildSatnavUserPrompt(question, promptContext),
              imageBase64: captured.imageBase64,
              temporaryImagePath: captured.temporaryImagePath,
              maxImageTokens: 192,
              maxTokens: 120,
              temperature: 0.2,
            })
          : await Vision.describeScene({
              requestId: reqId,
              prompt: buildConversationalVisionPrompt(question, promptContext),
              imageBase64: captured.imageBase64,
              temporaryImagePath: captured.temporaryImagePath,
              maxTokens: 110,
            })
        if (activeVisionReqRef.current !== reqId) return
        const finalClean =
          sanitizeSpokenVisionOutput(raw) ||
          buildFastCorridorReply(
            captured,
            routeProgressRef.current,
            settingsRef.current.stepLengthMeters,
            settingsRef.current.directionStyle,
          )
        const tail = streamSplitterRef.current?.flush(raw)
        setLastReply({ question, text: finalClean, streaming: false, at: Date.now() })

        historyRef.current = [
          ...historyRef.current.slice(-4),
          { role: 'user', text: question, at: Date.now() },
          { role: 'assistant', text: finalClean, at: Date.now() },
        ]

        if (tail) {
          await speak(tail, { tier: 'interactive', interrupt: !streamedAnyRef.current })
        } else if (!streamedAnyRef.current) {
          await speak(finalClean, { tier: 'interactive', interrupt: true })
        }
      } finally {
        if (activeVisionReqRef.current === reqId) activeVisionReqRef.current = undefined
        streamSplitterRef.current = null
        if (captured.temporaryImagePath) {
          void Perception.releaseCapture(captured.temporaryImagePath).catch(() => {})
        }
      }
    } catch {
      const fallback = buildFastCorridorReply(
        snapshotRef.current,
        routeProgressRef.current,
        settingsRef.current.stepLengthMeters,
        settingsRef.current.directionStyle,
      )
      setLastReply({ question, text: fallback, at: Date.now() })
      await speak(fallback, { tier: 'interactive', interrupt: true })
    } finally {
      thinkingRef.current = false
      stopThinkingTicks()
      if (mountedRef.current) setThinking(false)
    }
  }, [cancelAmbientNarration, fallbackVision, speak, startThinkingTicks, stopThinkingTicks, tensorfold])

  const setMode = useCallback(async (mode: SatnavMode) => {
    await update({ guidanceMode: mode })
    const label = mode === 'satnav'
      ? 'Full satnav mode: voice, haptics, and spatial beacon on.'
      : mode === 'quiet'
        ? 'Quiet mode: haptic steering, spatial beacon, and urgent alerts only.'
        : 'Explore mode: continuous LiDAR corridor guidance and open conversation.'
    setLastReply({ text: label, at: Date.now() })
    await speak(label, { tier: 'interactive', interrupt: true })
  }, [speak, update])

  const cycleMode = useCallback(async (direction: 1 | -1 = 1) => {
    const order: SatnavMode[] = ['satnav', 'quiet', 'explore']
    const idx = order.indexOf(settingsRef.current.guidanceMode)
    const next = order[(idx + direction + order.length) % order.length]!
    await setMode(next)
  }, [setMode])

  const start = useCallback(async () => {
    if (stateRef.current === 'active' || stateRef.current === 'degraded' || stateRef.current === 'starting') return
    const epoch = ++epochRef.current
    setCameraPermissionBlocked(false)
    setState('starting')
    setStatusMessage('Starting LiDAR and satnav sensors…')
    warningGateRef.current.reset()
    narratorRef.current.reset()
    standbyAnnouncedRef.current = false

    try {
      const caps = await Perception.getCapabilities()
      if (epoch !== epochRef.current) return
      if (!caps.available) {
        setCameraPermissionBlocked(caps.cameraPermission === 'denied' || caps.cameraPermission === 'restricted')
        throw new Error(caps.reason || 'Camera perception is unavailable on this device.')
      }

      await Perception.startSession({
        stepLengthMeters: settingsRef.current.stepLengthMeters,
        warningDistanceMeters: settingsRef.current.warningDistanceMeters,
        criticalDistanceMeters: 0.85,
        proximityIntervalMs: 120,
        mountMode: settingsRef.current.mountMode,
      })
      if (epoch !== epochRef.current) {
        await Perception.stopSession().catch(() => {})
        return
      }

      // Start native CoreLocation + true heading tracking & pocket background support (non-fatal if denied)
      await Nav.startTracking().catch(() => {})
      await Nav.setBackgroundEnabled(settingsRef.current.backgroundSatnav).catch(() => {})
      await Voice.setRemoteControlsEnabled(true).catch(() => {})
      await Voice.updateNowPlaying(
        'NearDar Walking Satnav',
        routeProgressRef.current?.active
          ? `Guiding to ${routeProgressRef.current.route.destinationName}`
          : 'LiDAR, compass & haptics active',
      ).catch(() => {})
      await activateKeepAwakeAsync('neardar-satnav').catch(() => {})
      pocketBgRef.current = false
      setPocketBackgroundActive(false)

      const startedCaps = await Perception.getCapabilities().catch(() => caps)
      if (epoch !== epochRef.current) return
      setCameraPreviewAvailable(startedCaps.cameraPreview === true)
      const nextState: SessionState = startedCaps.depth ? 'active' : 'degraded'
      setState(nextState)
      setStatusMessage(startedCaps.depth ? 'Satnav live — LiDAR and compass active.' : 'Camera live — using camera depth fallback.')

      // Warm TensorFold Mobile (or fallback vision model) in background if already downloaded
      if (activeEngineStatusRef.current.state === 'installed') {
        void (usingTensorFoldRef.current ? tensorfold.prepare(false) : fallbackVision.prepare(false))
      }
      if (settingsRef.current.urgentHaptics) void Haptics.playCue('resumed').catch(() => {})
      void Voice.playSpatialCue({ kind: 'resumed' }).catch(() => {})
    } catch (error) {
      await Promise.allSettled([Perception.stopSession(), Nav.stopTracking(), deactivateKeepAwake('neardar-satnav')])
      if (epoch !== epochRef.current) return
      const msg = error instanceof Error ? error.message : 'Satnav could not start.'
      setState('error')
      setStatusMessage(msg)
      await speak(`NearDar could not start. ${msg}`, { tier: 'interactive', interrupt: true })
    }
  }, [fallbackVision, speak, tensorfold])

  const quickScanAhead = useCallback(async () => {
    await cancelSpeech()
    if (settingsRef.current.urgentHaptics) void Haptics.playCue('mic-open').catch(() => {})
    if (stateRef.current !== 'active' && stateRef.current !== 'degraded') {
      await start()
    }
    await askVisualCompanion(
      'Describe what is right ahead of me, including people, dogs or animals, bicycles, roadworks, kerbs, doorways, and where the path is clear.',
      false,
    )
  }, [askVisualCompanion, cancelSpeech, start])

  const orientMe = useCallback(async (includeVision = true) => {
    await cancelSpeech()
    if (settingsRef.current.urgentHaptics) void Haptics.playCue('resumed').catch(() => {})

    // Part 1: Immediate street location + compass heading + active route status
    const controller = new AbortController()
    const street = await describeCurrentLocation(controller.signal, () => {}).catch(() => undefined)
    const h = headingRef.current
    const headingText = h !== undefined ? `You are facing ${cardinalDirection(h)}.` : 'Compass is calibrating.'
    const prog = routeProgressRef.current
    const routeText = prog?.active
      ? ` Guiding to ${prog.route.destinationName}, ${formatWalkingDistance(prog.remainingDistanceMeters, settingsRef.current.stepLengthMeters)} left. ${prog.currentStep.instruction}.`
      : ''

    const hasHome = savedPlacesRef.current.some((p) => p.name.toLowerCase() === 'home')
    const hasCrumbs = breadcrumbsRef.current.length >= 2
    const recoveryOffer = hasHome && hasCrumbs
      ? 'Say take me back, take me home, or tap to ask more.'
      : hasCrumbs
        ? 'Say take me back or tap to ask more.'
        : hasHome
          ? 'Say take me home or tap to ask more.'
          : 'Tap anywhere to ask where you want to go.'

    const part1 = `${street ?? 'Location is still locking on.'} ${headingText}${routeText}`.trim()
    setLastReply({ question: 'Orient me', text: part1, at: Date.now() })
    await speak(part1, { tier: 'interactive', interrupt: true })

    // Part 2: Immediate surroundings (LiDAR corridor + TensorFold visual summary if camera active)
    if (includeVision && (stateRef.current === 'active' || stateRef.current === 'degraded')) {
      const aim = snapshotRef.current?.aimState
      if (aim === 'lowered' || aim === 'covered') {
        await speak(`Raise your phone slightly if you want me to look around. ${recoveryOffer}`, { tier: 'interactive' })
        return
      }
      if (activeEngineStatusRef.current.state === 'ready') {
        await askVisualCompanion(
          'Calmly orient me in two short sentences: what kind of place or pavement am I on, what is ahead and beside me, and where is open space?',
          false,
        )
      } else {
        const corridorReply = buildFastCorridorReply(
          snapshotRef.current,
          routeProgressRef.current,
          settingsRef.current.stepLengthMeters,
          settingsRef.current.directionStyle,
        )
        await speak(corridorReply, { tier: 'interactive' })
      }
    }

    // Part 3: Reassuring recovery prompt
    await speak(recoveryOffer, { tier: 'interactive' })
  }, [askVisualCompanion, cancelSpeech, speak])

  const toggleTorch = useCallback(async (enabled?: boolean) => {
    const next = enabled ?? !torchEnabledRef.current
    const result = await Perception.setTorch(next, 0.45).catch(() => ({ active: false }))
    torchEnabledRef.current = result.active
    setTorchEnabled(result.active)
    const msg = result.active ? 'Torch on.' : next ? 'Torch is unavailable on this device.' : 'Torch off.'
    await speak(msg, { tier: 'interactive', interrupt: true, record: true })
  }, [speak])

  const toggleScreenCurtain = useCallback(async (enabled?: boolean) => {
    const next = enabled ?? !settingsRef.current.screenCurtain
    await update({ screenCurtain: next })
    const msg = next
      ? 'Screen curtain on. Screen is blacked out while all touch gestures stay active. Say turn screen back on anytime.'
      : 'Screen curtain off.'
    await speak(msg, { tier: 'interactive', interrupt: true, record: true })
  }, [speak, update])

  const applyMobilityProfile = useCallback(async (profile: MobilityProfile) => {
    const patch = applyProfilePatch(profile)
    await update(patch)
    const meta = MOBILITY_PROFILES[profile]
    const msg = `${meta.label} profile active. ${meta.shortDescription}`
    await speak(msg, { tier: 'interactive', interrupt: true, record: true })
  }, [speak, update])

  const shareLocationWithContact = useCallback(async () => {
    await cancelSpeech()
    const controller = new AbortController()
    const street = await describeCurrentLocation(controller.signal, () => {}).catch(() => undefined)
    const message = buildLocationShareMessage({
      location: locationRef.current,
      streetAddress: street,
      headingDegrees: headingRef.current,
      destinationName: routeProgressRef.current?.active ? routeProgressRef.current.route.destinationName : undefined,
      senderName: settingsRef.current.companionName || undefined,
    })
    const phone = settingsRef.current.emergencyContactPhone
    const name = settingsRef.current.emergencyContactName || 'your emergency contact'
    const smsPlatform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web'
    const smsUrl = phone ? buildEmergencySmsUrl(phone, message, smsPlatform) : undefined
    if (smsUrl) {
      await speak(`Opening message with your location for ${name}.`, { tier: 'interactive', interrupt: true, record: true })
      await Linking.openURL(smsUrl).catch(async () => {
        await Share.share({ message }).catch(() => {})
      })
      return
    }
    await speak('Opening share sheet with your location and map link.', { tier: 'interactive', interrupt: true, record: true })
    await Share.share({ message }).catch(() => {})
  }, [cancelSpeech, speak])

  const callEmergencyContact = useCallback(async () => {
    await cancelSpeech()
    const phone = settingsRef.current.emergencyContactPhone
    const name = settingsRef.current.emergencyContactName || 'your emergency contact'
    const url = buildEmergencyCallUrl(phone)
    if (!url) {
      await speak('No emergency contact phone number is saved yet. Add one in Settings under Trusted Contact.', {
        tier: 'interactive',
        interrupt: true,
        record: true,
      })
      return
    }
    await speak(`Calling ${name}.`, { tier: 'interactive', interrupt: true, record: true })
    await Linking.openURL(url).catch(async () => {
      await speak(`Could not place a call to ${name} on this device.`, { tier: 'interactive', interrupt: true })
    })
  }, [cancelSpeech, speak])

  const clearSkill = useCallback(() => {
    setActiveSkill('none')
    setWatchedBus(undefined)
  }, [])

  const runSkill = useCallback(async (skill: Exclude<ActiveMobilitySkill, 'none'>, target?: string) => {
    cancelAmbientNarration()
    setActiveSkill(skill)
    if (skill === 'transit' && target) {
      const normalized = normalizeBusNumber(target)
      if (normalized) setWatchedBus(normalized)
    } else if (skill !== 'transit') {
      setWatchedBus(undefined)
    }

    if (stateRef.current !== 'active' && stateRef.current !== 'degraded') {
      await start()
    }

    const reqId = `satnav-skill-${skill}-${Date.now()}`
    thinkingRef.current = true
    setThinking(true)
    startThinkingTicks()
    const labelMap: Record<Exclude<ActiveMobilitySkill, 'none'>, string> = {
      'door-finder': 'Looking for the entrance…',
      crossing: 'Checking the crossing layout…',
      transit: target ? `Watching for bus ${normalizeBusNumber(target) || target}…` : 'Checking transit and bus signs…',
      vivid: 'Taking in the view…',
      'find-object': `Looking for ${target || 'that item'}…`,
    }
    setLastReply({ question: labelMap[skill], text: labelMap[skill], streaming: true, at: Date.now() })

    try {
      const useTensorFold = usingTensorFoldRef.current
      if (activeEngineStatusRef.current.state === 'installed' || activeEngineStatusRef.current.state === 'loading') {
        await (useTensorFold ? tensorfold.prepare(false) : fallbackVision.prepare(false))
      }
      const useVlm = activeEngineStatusRef.current.state === 'ready'
      const captured = await Perception.captureScene({
        includeImage: useVlm,
        maxImageLongEdge: skill === 'vivid' || skill === 'find-object' ? 640 : 512,
        recognizeText: true,
        detectPeople: true,
      })

      // Instant zero-VLM bus OCR hit if watching for a specific route number!
      if (skill === 'transit' && target) {
        const hit = matchWatchedBusNumber(captured.recognizedText, target)
        if (hit) {
          const msg = formatBusMatchAnnouncement(target, hit, undefined, settingsRef.current.directionStyle)
          if (captured.temporaryImagePath) void Perception.releaseCapture(captured.temporaryImagePath).catch(() => {})
          if (settingsRef.current.urgentHaptics) void Haptics.playCue('arrived').catch(() => {})
          setLastReply({ question: labelMap[skill], text: msg, at: Date.now() })
          await speak(msg, { tier: 'navigation', interrupt: true })
          return
        }
      }

      if (!useVlm || (!captured.temporaryImagePath && !captured.imageBase64)) {
        const fallback =
          skill === 'door-finder'
            ? formatDoorTelemetryFallback(
                target ?? routeProgressRef.current?.route.destinationName,
                captured,
                settingsRef.current.directionStyle,
                settingsRef.current.stepLengthMeters,
              )
            : buildFastCorridorReply(
                captured,
                routeProgressRef.current,
                settingsRef.current.stepLengthMeters,
                settingsRef.current.directionStyle,
              )
        const ocrHint = captured.recognizedText.length > 0 ? ` Visible text: ${captured.recognizedText.slice(0, 4).join(', ')}.` : ''
        const reply = `${fallback}${ocrHint}`
        if (captured.temporaryImagePath) void Perception.releaseCapture(captured.temporaryImagePath).catch(() => {})
        setLastReply({ question: labelMap[skill], text: reply, at: Date.now() })
        await speak(reply, { tier: 'interactive', interrupt: true })
        return
      }

      const skillPrompt = buildMobilitySkillPrompt(
        skill,
        {
          snapshot: captured,
          route: routeProgressRef.current,
          headingDeg: headingRef.current,
          stepLengthMeters: settingsRef.current.stepLengthMeters,
          directionStyle: settingsRef.current.directionStyle,
          lightingState: captured.lightingState,
          mobilityProfile: settingsRef.current.mobilityProfile,
          history: historyRef.current,
        },
        target,
      )

      activeVisionReqRef.current = reqId
      streamSplitterRef.current = new SentenceStreamSplitter()
      streamedAnyRef.current = false

      try {
        const raw = useTensorFold
          ? await Engine.generate({
              requestId: reqId,
              question: skillPrompt.prompt,
              system: skillPrompt.system,
              prompt: skillPrompt.prompt,
              imageBase64: captured.imageBase64,
              temporaryImagePath: captured.temporaryImagePath,
              maxImageTokens: skillPrompt.maxImageTokens,
              maxTokens: skillPrompt.maxTokens,
              temperature: skillPrompt.temperature,
            })
          : await Vision.describeScene({
              requestId: reqId,
              prompt: skillPrompt.combined,
              imageBase64: captured.imageBase64,
              temporaryImagePath: captured.temporaryImagePath,
              maxTokens: skillPrompt.maxTokens,
            })

        if (activeVisionReqRef.current !== reqId) return
        const finalClean = formatMobilitySkillOutput(skill, raw) || buildFastCorridorReply(
          captured,
          routeProgressRef.current,
          settingsRef.current.stepLengthMeters,
          settingsRef.current.directionStyle,
        )
        const tail = streamSplitterRef.current?.flush(finalClean)
        setLastReply({ question: labelMap[skill], text: finalClean, streaming: false, at: Date.now() })

        if (tail) {
          await speak(tail, { tier: 'interactive', interrupt: !streamedAnyRef.current })
        } else if (!streamedAnyRef.current) {
          await speak(finalClean, { tier: 'interactive', interrupt: true })
        }
      } finally {
        if (activeVisionReqRef.current === reqId) activeVisionReqRef.current = undefined
        streamSplitterRef.current = null
        if (captured.temporaryImagePath) {
          void Perception.releaseCapture(captured.temporaryImagePath).catch(() => {})
        }
      }
    } catch {
      const fallback = buildFastCorridorReply(
        snapshotRef.current,
        routeProgressRef.current,
        settingsRef.current.stepLengthMeters,
        settingsRef.current.directionStyle,
      )
      setLastReply({ question: labelMap[skill], text: fallback, at: Date.now() })
      await speak(fallback, { tier: 'interactive', interrupt: true })
    } finally {
      thinkingRef.current = false
      stopThinkingTicks()
      if (mountedRef.current) setThinking(false)
    }
  }, [cancelAmbientNarration, fallbackVision, speak, start, startThinkingTicks, stopThinkingTicks, tensorfold])

  const pause = useCallback(async (silent = false) => {
    epochRef.current += 1
    await cancelSpeech()
    await Promise.allSettled([
      Perception.setTorch(false, 0),
      Perception.stopSession(),
      Nav.setBackgroundEnabled(false),
      Nav.stopTracking(),
      Voice.setRemoteControlsEnabled(false),
      Voice.stopListening(),
      Voice.stopSpatialAudio(),
      Haptics.stop(),
      deactivateKeepAwake('neardar-satnav'),
    ])
    torchEnabledRef.current = false
    setTorchEnabled(false)
    pocketBgRef.current = false
    setPocketBackgroundActive(false)
    listeningRef.current = false
    arbitratorRef.current.setListening(false)
    setListening(false)
    setPartialTranscript('')
    warningGateRef.current.reset()
    narratorRef.current.reset()
    standbyAnnouncedRef.current = false
    setSnapshot(undefined)
    setState('paused')
    setStatusMessage('Satnav paused. Double-tap to resume.')
    if (!silent) {
      if (settingsRef.current.urgentHaptics) void Haptics.playCue('paused').catch(() => {})
      void Voice.playSpatialCue({ kind: 'paused' }).catch(() => {})
      await speak('Satnav paused.', { tier: 'interactive', interrupt: true })
    }
  }, [cancelSpeech, speak])

  const togglePause = useCallback(async () => {
    if (stateRef.current === 'active' || stateRef.current === 'degraded' || stateRef.current === 'starting') {
      await pause(false)
    } else {
      await start()
    }
  }, [pause, start])

  const submitCommand = useCallback(async (rawText: string) => {
    const trimmed = rawText.trim()
    if (!trimmed) return
    const intent = parseSatnavIntent(trimmed)

    switch (intent.kind) {
      case 'stop-speech':
        await cancelSpeech()
        return
      case 'pause':
        await pause(false)
        return
      case 'resume':
        await start()
        return
      case 'repeat':
        await speak(lastReply?.text ?? 'There is nothing to repeat yet.', { interrupt: true })
        return
      case 'help':
        await speak(
          'Tap anywhere to talk, swipe up to scan ahead, swipe down to get your bearings, or double tap to pause. Say take me to a place, take me back, I am lost, save this spot as home, or read that sign.',
          { tier: 'interactive', interrupt: true, record: true },
        )
        return
      case 'orient-me':
        await orientMe(true)
        return
      case 'set-mode':
        await setMode(intent.mode)
        return
      case 'cancel-route':
        await cancelRoute()
        return
      case 'navigate-back':
        await navigateBack()
        return
      case 'save-place':
        await saveCurrentPlace(intent.name)
        return
      case 'list-places': {
        const names = savedPlacesRef.current.map((p) => p.name)
        const reply = names.length > 0
          ? `Your saved places are ${names.join(', ')}. Say take me to any of them.`
          : 'You have no saved places yet. Say save this spot as home to bookmark where you are.'
        await speak(reply, { interrupt: true, record: true })
        return
      }
      case 'navigate-to':
        await navigateToDestination(intent.destination)
        return
      case 'route-status': {
        const prog = routeProgressRef.current
        if (!prog || !prog.active) {
          await speak('No route is active. Say take me to a destination, or ask what is ahead.', { interrupt: true, record: true })
          return
        }
        const unit = settingsRef.current.distanceUnit
        const rem = formatWalkingDistance(prog.remainingDistanceMeters, settingsRef.current.stepLengthMeters, unit)
        const turnDist = formatWalkingDistance(prog.distanceToNextTurnMeters, settingsRef.current.stepLengthMeters, unit)
        const nextLine = prog.nextStep ? ` Next: ${prog.nextStep.instruction} in ${turnDist}.` : ''
        await speak(`${rem} left to ${prog.route.destinationName}. ${prog.currentStep.instruction}.${nextLine}`, { interrupt: true, record: true })
        return
      }
      case 'find-door':
        await runSkill('door-finder', routeProgressRef.current?.route.destinationName)
        return
      case 'crossing-assist':
        await runSkill('crossing')
        return
      case 'watch-bus':
        await runSkill('transit', intent.busNumber)
        return
      case 'vivid-scene':
        await runSkill('vivid')
        return
      case 'find-object':
        await runSkill('find-object', intent.target)
        return
      case 'emergency-share':
        await shareLocationWithContact()
        return
      case 'emergency-call':
        await callEmergencyContact()
        return
      case 'toggle-torch':
        await toggleTorch(intent.enabled)
        return
      case 'toggle-curtain':
        await toggleScreenCurtain(intent.enabled)
        return
      case 'set-profile':
        await applyMobilityProfile(intent.profile)
        return
      case 'indoor-save': {
        const heading = headingRef.current ?? 0
        const next = await saveIndoorAnchor({
          spaceName: 'Indoor Space',
          label: intent.name,
          x: 0,
          y: snapshotRef.current?.corridor?.floorHeightMeters ?? 0,
          z: 0,
          headingDeg: heading,
        })
        setIndoorAnchors(next)
        await speak(`Saved indoor waypoint ${intent.name} facing ${cardinalDirection(heading)}.`, {
          tier: 'interactive',
          interrupt: true,
          record: true,
        })
        return
      }
      case 'indoor-guide': {
        const target = findIndoorAnchorByLabel(indoorAnchorsRef.current, intent.name)
        if (!target) {
          await speak(`I don’t have a saved indoor spot called ${intent.name}. Say remember this room as ${intent.name} when you are there.`, {
            tier: 'interactive',
            interrupt: true,
            record: true,
          })
          return
        }
        const guidance = computeIndoorGuidance(
          { x: 0, y: snapshotRef.current?.corridor?.floorHeightMeters ?? 0, z: 0, headingDeg: headingRef.current ?? 0 },
          target,
          settingsRef.current.stepLengthMeters,
        )
        await speak(guidance.spokenGuidance, { tier: 'interactive', interrupt: true, record: true })
        return
      }
      case 'location': {
        const controller = new AbortController()
        const answer = await describeCurrentLocation(controller.signal, () => {}).catch(() => undefined)
        const headingText = headingRef.current !== undefined ? ` You are facing ${cardinalDirection(headingRef.current)}.` : ''
        await speak(`${answer ?? 'I could not look up your street address right now.'}${headingText}`, { interrupt: true, record: true })
        return
      }
      case 'heading': {
        const h = headingRef.current
        const reply = h !== undefined
          ? `You are facing ${cardinalDirection(h)}, ${Math.round(h)} degrees.`
          : 'Compass heading is still calibrating. Move your phone slowly in a figure eight.'
        await speak(reply, { interrupt: true, record: true })
        return
      }
      case 'corridor-check': {
        const reply = buildFastCorridorReply(
          snapshotRef.current,
          routeProgressRef.current,
          settingsRef.current.stepLengthMeters,
          settingsRef.current.directionStyle,
        )
        await speak(reply, { tier: 'interactive', interrupt: true, record: true })
        return
      }
      case 'read-text':
        if (stateRef.current !== 'active' && stateRef.current !== 'degraded') await start()
        await askVisualCompanion(trimmed, true)
        return
      case 'visual-question':
        if (stateRef.current !== 'active' && stateRef.current !== 'degraded') await start()
        await askVisualCompanion(intent.question, false)
        return
    }
  }, [
    applyMobilityProfile,
    askVisualCompanion,
    callEmergencyContact,
    cancelRoute,
    cancelSpeech,
    lastReply?.text,
    navigateBack,
    navigateToDestination,
    orientMe,
    pause,
    runSkill,
    saveCurrentPlace,
    setMode,
    shareLocationWithContact,
    speak,
    start,
    toggleScreenCurtain,
    toggleTorch,
  ])

  handleTranscriptRef.current = submitCommand
  quickScanRef.current = quickScanAhead
  orientMeRef.current = orientMe

  const beginTalk = useCallback(async () => {
    if (listeningRef.current) {
      // Tap while listening stops listening and submits whatever partial transcript we already captured
      await Voice.stopListening().catch(() => {})
      listeningRef.current = false
      arbitratorRef.current.setListening(false)
      setListening(false)
      const captured = partialRef.current.trim()
      partialRef.current = ''
      setPartialTranscript('')
      if (captured) await submitCommand(captured)
      return
    }

    // Immediate barge-in: silence speech & cancel in-flight vision generation
    await cancelSpeech()
    setVoiceNotice(undefined)
    partialRef.current = ''
    setPartialTranscript('')
    if (settingsRef.current.urgentHaptics) void Haptics.playCue('mic-open').catch(() => {})
    void Voice.playSpatialCue({ kind: 'mic-open' }).catch(() => {})

    try {
      await Voice.startListening({ silenceTimeoutMs: 2_000, preferBluetoothMicrophone: true })
      listeningRef.current = true
      arbitratorRef.current.setListening(true)
      setListening(true)
    } catch (error) {
      listeningRef.current = false
      arbitratorRef.current.setListening(false)
      setListening(false)
      const code = voiceErrorCode(error)
      if (code === 'ERR_RECOGNITION_MODEL_MISSING') setVoiceModelMissing(true)
      const notice = microphoneRetryNotice(code) ?? (error instanceof Error ? error.message : 'On-device voice input could not start.')
      setVoiceNotice(notice)
      if (Platform.OS === 'ios') announce(notice)
    }
  }, [cancelSpeech, submitCommand])

  beginTalkRef.current = beginTalk

  const endTalk = useCallback(async () => {
    if (!listeningRef.current) return
    await Voice.stopListening().catch(() => {})
    listeningRef.current = false
    arbitratorRef.current.setListening(false)
    setListening(false)
    if (settingsRef.current.urgentHaptics) void Haptics.playCue('mic-close').catch(() => {})
    void Voice.playSpatialCue({ kind: 'mic-close' }).catch(() => {})
    const captured = partialRef.current.trim()
    partialRef.current = ''
    setPartialTranscript('')
    if (captured) {
      await submitCommand(captured)
    }
  }, [submitCommand])

  const downloadOfflineSpeech = useCallback(async () => {
    if (speechDownloadPending) return
    setSpeechDownloadPending(true)
    try {
      const result = await Voice.downloadOfflineRecognition()
      setVoiceModelMissing(result !== 'ready')
      setVoiceNotice(result === 'ready' ? 'Offline speech is ready.' : 'Offline speech download requested.')
    } catch (error) {
      setVoiceNotice(error instanceof Error ? error.message : 'Offline speech download failed.')
    } finally {
      setSpeechDownloadPending(false)
    }
  }, [speechDownloadPending])

  const previewFeedback = useCallback(async (
    kind: 'compass-lock' | 'proximity' | 'fast-mover' | 'animal' | 'head-hazard' | 'drop-off' | 'turn-right' | 'arrived',
  ) => {
    if (kind === 'compass-lock') {
      await Haptics.playCue('resumed').catch(() => {})
      await Voice.playSpatialCue({ kind: 'resumed', azimuthDeg: 0 }).catch(() => {})
      await speak('On-course lock pulse.', { tier: 'interactive', interrupt: true })
    } else if (kind === 'proximity') {
      await Haptics.play({ direction: 'ahead', severity: 'caution', distanceMeters: 1.1 }).catch(() => {})
      await Voice.playSpatialCue({ kind: 'obstacle', azimuthDeg: 0, distanceMeters: 1.1 }).catch(() => {})
      await speak('Close obstacle radar.', { tier: 'interactive', interrupt: true })
    } else if (kind === 'fast-mover') {
      await Haptics.playCue('fast-mover').catch(() => {})
      await Voice.playSpatialCue({ kind: 'fast-mover', azimuthDeg: -25, distanceMeters: 2.5 }).catch(() => {})
      await speak('Fast movement ahead left — hold still.', { tier: 'interactive', interrupt: true })
    } else if (kind === 'animal') {
      await Haptics.playCue('animal').catch(() => {})
      await Voice.playSpatialCue({ kind: 'presence', azimuthDeg: -30, distanceMeters: 2.0 }).catch(() => {})
      await speak('Dog, ahead left, two metres.', { tier: 'interactive', interrupt: true })
    } else if (kind === 'head-hazard') {
      await Haptics.playCue('head-hazard').catch(() => {})
      await Voice.playSpatialCue({ kind: 'head-height', azimuthDeg: 0, distanceMeters: 1.2, elevationMeters: 0.9 }).catch(() => {})
      await speak('Head-height hazard.', { tier: 'interactive', interrupt: true })
    } else if (kind === 'drop-off') {
      await Haptics.playCue('drop-off').catch(() => {})
      await Voice.playSpatialCue({ kind: 'drop-off', azimuthDeg: 0, distanceMeters: 1.3, elevationMeters: -0.9 }).catch(() => {})
      await speak('Step down or drop-off.', { tier: 'interactive', interrupt: true })
    } else if (kind === 'turn-right') {
      await Haptics.playCue('turn-right').catch(() => {})
      await Voice.playSpatialCue({ kind: 'turn-right', azimuthDeg: 65, distanceMeters: 1.5 }).catch(() => {})
      await speak('Turn right cue.', { tier: 'interactive', interrupt: true })
    } else if (kind === 'arrived') {
      await Haptics.playCue('arrived').catch(() => {})
      await Voice.playSpatialCue({ kind: 'arrived', azimuthDeg: 0 }).catch(() => {})
      await speak('Destination arrived.', { tier: 'interactive', interrupt: true })
    }
  }, [speak])

  // Initial load of persisted places, cached routes, indoor anchors, and voice capabilities
  useEffect(() => {
    mountedRef.current = true
    void loadSavedPlaces().then((places) => { if (mountedRef.current) setSavedPlaces(places) })
    void loadCachedRoutes().then((routes) => { if (mountedRef.current) setCachedRoutes(routes) })
    void loadIndoorAnchors().then((anchors) => { if (mountedRef.current) setIndoorAnchors(anchors) })
    void Voice.getCapabilities().then((caps) => {
      if (!mountedRef.current) return
      setVoice(caps)
      previousRouteKindRef.current = caps.route
    }).catch(() => {})
    return () => { mountedRef.current = false }
  }, [])

  // Subscribe to Perception, Navigation, Voice, and streaming Vision events
  useEffect(() => {
    const perceptionSub = Perception.addPerceptionListener((event) => {
      if (event.snapshot && (stateRef.current === 'starting' || stateRef.current === 'active' || stateRef.current === 'degraded')) {
        setSnapshot(event.snapshot)
        if (event.snapshot.thermalState) setThermalState(event.snapshot.thermalState)
        if (event.snapshot.lightingState) setLightingState(event.snapshot.lightingState)
        if (event.snapshot.depthSource) setDepthSource(event.snapshot.depthSource)

        if (event.snapshot.headingDegrees !== undefined && Number.isFinite(event.snapshot.headingDegrees)) {
          // ARKit gravityAndHeading gives ultra-smooth drift-free true north heading!
          setHeadingDegrees(event.snapshot.headingDegrees)
          headingRef.current = event.snapshot.headingDegrees
          if (locationRef.current) {
            applyRouteUpdate(locationRef.current, event.snapshot.headingDegrees)
          }
        }
        const healthy = event.snapshot.trackingReady && (event.snapshot.depthState === 'ready' || event.snapshot.depthSource === 'feature-points')
        if (!healthy && stateRef.current === 'active') {
          setState('degraded')
          setStatusMessage(cameraRecoveryHint(event.snapshot))
        } else if (healthy && stateRef.current === 'degraded') {
          setState('active')
          setStatusMessage(
            event.snapshot.depthSource === 'feature-points'
              ? 'Satnav live — camera depth fallback and compass active.'
              : 'Satnav live — LiDAR and compass active.',
          )
        }

        const now = Date.now()
        const inStandby = event.snapshot.aimState === 'lowered' || event.snapshot.aimState === 'covered'

        // Low-light awareness & optional adaptive torch assist
        if (!inStandby && event.snapshot.lightingState === 'dark' && now - lastDarkNoticeAtRef.current >= 60_000) {
          lastDarkNoticeAtRef.current = now
          if (settingsRef.current.autoTorch && !torchEnabledRef.current) {
            void Perception.setTorch(true, 0.35).then((res) => {
              if (mountedRef.current) {
                torchEnabledRef.current = res.active
                setTorchEnabled(res.active)
              }
            }).catch(() => {})
          } else if (settingsRef.current.guidanceMode !== 'quiet') {
            void speak(
              event.snapshot.depthSource === 'lidar'
                ? 'It is dark ahead. LiDAR obstacle protection stays active, though visual reading is limited.'
                : 'It is very dark ahead. Say turn on the torch if you need light for signs.',
              { tier: 'ambient', category: 'low-light', cooldownMs: 60_000 },
            )
          }
        }

        // Instant zero-VLM OCR bus watcher when actively watching for a bus number
        if (!inStandby && watchedBusRef.current && event.snapshot.recognizedText.length > 0 && now - lastBusSpotAtRef.current >= 8_000) {
          const hit = matchWatchedBusNumber(event.snapshot.recognizedText, watchedBusRef.current)
          if (hit) {
            lastBusSpotAtRef.current = now
            const msg = formatBusMatchAnnouncement(watchedBusRef.current, hit, undefined, settingsRef.current.directionStyle)
            if (settingsRef.current.urgentHaptics) void Haptics.playCue('arrived').catch(() => {})
            void Voice.playSpatialCue({ kind: 'arrived' }).catch(() => {})
            void speak(msg, { tier: 'navigation', interrupt: true, record: true })
          }
        }

        // Real-time Apple Vision presence (dogs, cats, people, crowds) & doorway openings
        if (!inStandby && !listeningRef.current && !thinkingRef.current) {
          const presence = detectLivePresence(
            event.snapshot,
            settingsRef.current.directionStyle,
            settingsRef.current.stepLengthMeters,
            settingsRef.current.distanceUnit,
          )
          if (presence && shouldAnnouncePresenceForProfile(presence.kind, settingsRef.current.mobilityProfile)) {
            const cooldownMs =
              presence.kind === 'animal' ? 9_000 : presence.kind === 'opening' ? 14_000 : 12_000
            if (now - lastPresenceCueAtRef.current >= 4_000) {
              if (presence.kind === 'animal') {
                lastPresenceCueAtRef.current = now
                if (settingsRef.current.urgentHaptics) void Haptics.playCue('animal').catch(() => {})
                if (settingsRef.current.spatialBeacon) {
                  void Voice.playSpatialCue({
                    kind: 'presence',
                    azimuthDeg: presence.bearingDegrees,
                    distanceMeters: presence.distanceMeters,
                  }).catch(() => {})
                }
              } else if (presence.kind === 'opening' && settingsRef.current.guidanceMode !== 'quiet') {
                lastPresenceCueAtRef.current = now
                if (settingsRef.current.urgentHaptics) void Haptics.playCue('opening').catch(() => {})
                if (settingsRef.current.spatialBeacon) {
                  void Voice.playSpatialCue({
                    kind: 'opening',
                    azimuthDeg: presence.bearingDegrees,
                    distanceMeters: presence.distanceMeters,
                  }).catch(() => {})
                }
              } else if (settingsRef.current.spatialBeacon) {
                lastPresenceCueAtRef.current = now
                void Voice.playSpatialCue({
                  kind: 'presence',
                  azimuthDeg: presence.bearingDegrees,
                  distanceMeters: presence.distanceMeters,
                }).catch(() => {})
              }
            }
            if (settingsRef.current.guidanceMode !== 'quiet') {
              void speak(presence.message, {
                tier: 'ambient',
                category: presence.category,
                cooldownMs,
                record: presence.kind === 'animal' || presence.kind === 'crowd',
              })
            }
          }

          // Proactive TensorFold Mobile crossing lookahead & passing street landmark narrator
          const proactiveTask = narratorRef.current.planProactive({
            mode: settingsRef.current.guidanceMode,
            proactiveNarration: settingsRef.current.proactiveNarration,
            ambientObstacleNaming: settingsRef.current.ambientObstacleNaming,
            engineReady: activeEngineStatusRef.current.state === 'ready',
            busy: ambientBusyRef.current || thinkingRef.current,
            listening: listeningRef.current,
            standby: inStandby,
            snapshot: event.snapshot,
            route: routeProgressRef.current,
            location: locationRef.current,
            headingDeg: headingRef.current,
            directionStyle: settingsRef.current.directionStyle,
            stepLengthMeters: settingsRef.current.stepLengthMeters,
            lightingState: event.snapshot.lightingState,
            proactiveVlmAllowed: event.snapshot.proactiveVlmAllowed,
            mobilityProfile: settingsRef.current.mobilityProfile,
            lastCriticalAt: lastCriticalAtRef.current,
            now,
          })
          if (proactiveTask) {
            void runNarrationTask(proactiveTask)
          }
        }
      }
      if (event.warning) {
        void handleWarning(event.warning)
      }
      if (event.type === 'lifecycle') {
        if (event.foreground === false && (stateRef.current === 'active' || stateRef.current === 'degraded')) {
          if (settingsRef.current.backgroundSatnav && routeProgressRef.current?.active) {
            // Keep GPS walking satnav, 3D spatial audio beacon, and Lock Screen earbud triggers alive in pocket!
            pocketBgRef.current = true
            setPocketBackgroundActive(true)
            setStatusMessage('Pocket mode — GPS turns & 3D audio beacon active.')
            void Perception.setTorch(false, 0).catch(() => {})
            void Perception.stopSession().catch(() => {})
          } else {
            void pause(true)
          }
        } else if (event.foreground === true && pocketBgRef.current) {
          pocketBgRef.current = false
          setPocketBackgroundActive(false)
          setStatusMessage('Resuming LiDAR and camera sensors…')
          void Perception.startSession({
            stepLengthMeters: settingsRef.current.stepLengthMeters,
            warningDistanceMeters: settingsRef.current.warningDistanceMeters,
            criticalDistanceMeters: 0.85,
            proximityIntervalMs: 120,
            mountMode: settingsRef.current.mountMode,
          }).catch(() => {})
        }
      }
    })

    const navSub = Nav.addNavigationListener((event) => {
      if (event.type === 'location' && event.latitude !== undefined && event.longitude !== undefined) {
        const point = { latitude: event.latitude, longitude: event.longitude, accuracyMeters: event.accuracyMeters }
        setLocation(point)
        locationRef.current = point

        // Record session breadcrumbs every >= 8m for offline "take me back"
        const crumbs = breadcrumbsRef.current
        const last = crumbs[crumbs.length - 1]
        if (!last || haversineMeters(last, point) >= 8) {
          crumbs.push({ latitude: point.latitude, longitude: point.longitude })
          if (crumbs.length > 500) crumbs.shift()
          setBreadcrumbCount(crumbs.length)
        }

        applyRouteUpdate(point, headingRef.current ?? event.courseDegrees)
      } else if (event.type === 'heading') {
        const deg = event.trueHeadingDegrees ?? event.magneticHeadingDegrees
        // Use CoreLocation heading whenever ARKit heading isn't active
        if (deg !== undefined && Number.isFinite(deg) && snapshotRef.current?.headingDegrees === undefined) {
          setHeadingDegrees(deg)
          headingRef.current = deg
          if (locationRef.current) {
            applyRouteUpdate(locationRef.current, deg)
          }
        }
      }
    })

    const voiceSub = Voice.addVoiceListener((event) => {
      if (event.type === 'remoteTrigger') {
        if (event.action === 'talk') void beginTalkRef.current()
        else if (event.action === 'scan') void quickScanRef.current()
        else if (event.action === 'orient') void orientMeRef.current(true)
        return
      }
      if (event.type === 'partial' && event.text) {
        partialRef.current = event.text
        setPartialTranscript(event.text)
      }
      if (event.type === 'final' && event.text) {
        const finalText = event.text.trim()
        partialRef.current = ''
        setPartialTranscript('')
        listeningRef.current = false
        arbitratorRef.current.setListening(false)
        setListening(false)
        if (finalText) void handleTranscriptRef.current(finalText)
      }
      if (event.type === 'listeningStopped') {
        listeningRef.current = false
        arbitratorRef.current.setListening(false)
        setListening(false)
      }
      if (event.type === 'speechFinished' || event.type === 'speechStopped') {
        const next = arbitratorRef.current.onFinished()
        if (next) {
          void playSpeechItem(next, false)
        } else if (mountedRef.current) {
          setSpeaking(false)
        }
      }
      if (event.type === 'routeChanged' && event.route) {
        setVoice((prev) => prev ? { ...prev, route: event.route! } : prev)
        if (headphonesDisconnected(Platform.OS, previousRouteKindRef.current, event.route, event.audioRoute)) {
          if (settingsRef.current.speakerFallback && event.route === 'speaker') {
            void speak('Headphones disconnected. Switching to phone speaker.', { tier: 'navigation' })
          }
        }
        previousRouteKindRef.current = event.route
      }
      if (event.type === 'error' && event.message && !SILENCE_CODES.has(event.code ?? '')) {
        if (event.operation === 'recognition' || event.operation === 'startListening') {
          listeningRef.current = false
          arbitratorRef.current.setListening(false)
          setListening(false)
          if (event.code === 'ERR_RECOGNITION_MODEL_MISSING') setVoiceModelMissing(true)
          const notice = microphoneRetryNotice(event.code) ?? event.message
          setVoiceNotice(notice)
        }
      }
    })

    const handleStreamedText = (requestId: string | undefined, accumulated: string | undefined) => {
      if (!requestId || requestId !== activeVisionReqRef.current || !accumulated) return
      const preview = sanitizeSpokenVisionOutput(accumulated)
      if (preview) {
        setLastReply((prev) => ({ question: prev?.question, text: preview, streaming: true, at: Date.now() }))
      }
      const sentences = streamSplitterRef.current?.push(accumulated) ?? []
      for (const sentence of sentences) {
        const isFirst = !streamedAnyRef.current
        streamedAnyRef.current = true
        void speak(sentence, { interrupt: isFirst })
      }
    }

    const engineSub = Engine.addEngineListener((event) => {
      if (event.type === 'token') handleStreamedText(event.requestId, event.text)
    })

    const visionSub = Vision.addVisionListener((event) => {
      if (event.type === 'token') handleStreamedText(event.requestId, event.text)
    })

    // Keep VoiceOver awareness non-intrusive
    void AccessibilityInfo.isScreenReaderEnabled().catch(() => false)

    return () => {
      stopThinkingTicks()
      if (standbyTimerRef.current) {
        clearTimeout(standbyTimerRef.current)
        standbyTimerRef.current = null
      }
      perceptionSub.remove()
      navSub.remove()
      voiceSub.remove()
      engineSub.remove()
      visionSub.remove()
      void Promise.allSettled([
        Perception.setTorch(false, 0),
        Perception.stopSession(),
        Nav.setBackgroundEnabled(false),
        Nav.stopTracking(),
        Voice.setRemoteControlsEnabled(false),
        Voice.stopListening(),
        Voice.stopSpeaking(),
        Voice.stopSpatialAudio(),
        Haptics.stop(),
      ])
    }
    // Subscriptions read live values through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <SatnavContext.Provider
      value={{
        state,
        active,
        paused,
        cameraReady,
        cameraPreviewAvailable,
        cameraPermissionBlocked,
        statusMessage,
        listening,
        speaking,
        thinking,
        partialTranscript,
        voiceNotice,
        voiceModelMissing,
        speechDownloadPending,
        snapshot,
        location,
        headingDegrees,
        routeProgress,
        fused,
        lastReply,
        savedPlaces,
        cachedRoutes,
        breadcrumbCount,
        vision: activeEngineCaps,
        visionStatus: activeEngineStatus,
        usingTensorFoldEngine,
        voice,
        mode: settings.guidanceMode,
        activeSkill,
        watchedBus,
        torchEnabled,
        thermalState,
        lightingState,
        depthSource,
        pocketBackgroundActive,
        indoorAnchors,
        start,
        pause,
        togglePause,
        beginTalk,
        endTalk,
        quickScanAhead,
        orientMe,
        runSkill,
        clearSkill,
        toggleTorch,
        toggleScreenCurtain,
        applyMobilityProfile,
        shareLocationWithContact,
        callEmergencyContact,
        submitCommand,
        cancelSpeech,
        cycleMode,
        setMode,
        navigateToDestination,
        navigateToSavedPlace,
        navigateBack,
        cancelRoute,
        saveCurrentPlace,
        deleteSavedPlace,
        clearRouteCache,
        prepareVisionModel: (download = true) =>
          usingTensorFoldRef.current ? tensorfold.prepare(download) : fallbackVision.prepare(download),
        cancelVisionInstall: () =>
          usingTensorFoldRef.current ? tensorfold.cancelInstall() : fallbackVision.cancelInstall(),
        unloadVisionModel: () =>
          (usingTensorFoldRef.current ? tensorfold.unload(true) : fallbackVision.unload(true)).then(() => undefined),
        downloadOfflineSpeech,
        previewFeedback,
      }}
    >
      {children}
    </SatnavContext.Provider>
  )
}

export function useSatnav(): SatnavController {
  const ctx = useContext(SatnavContext)
  if (!ctx) throw new Error('useSatnav must be used inside SatnavProvider.')
  return ctx
}
