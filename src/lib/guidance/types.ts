import type { Errand } from './errands'
import type { AimState, CorridorSummary, SpatialHazard } from '../../../modules/tensorfold-perception/src'

export type SessionState = 'idle' | 'starting' | 'active' | 'degraded' | 'stopping' | 'paused' | 'error'
export type DepthState = 'unavailable' | 'starting' | 'ready' | 'stale' | 'limited' | 'lost'
export type Direction = 'ahead' | 'ahead-left' | 'ahead-right' | 'left' | 'right' | 'behind' | 'unknown'
export type SatnavMode = 'satnav' | 'quiet' | 'explore'
export type TalkGesture = 'tap' | 'hold'
export type DirectionStyle = 'natural' | 'clock'
export type MobilityProfile = 'standard' | 'cane' | 'guide-dog' | 'low-vision'
export type DistanceUnit = 'metric' | 'imperial'
export type MountMode = 'handheld' | 'lanyard'
export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical'
export type LightingState = 'good' | 'dim' | 'dark'
export type DepthSource = 'lidar' | 'feature-points' | 'unavailable'

export interface SceneObject {
  id: string
  label: string
  confidence: number
  direction: Direction
  clockSector?: number
  distanceMeters?: number
  stepEstimate?: number
  occupied?: boolean
  evidence: string[]
}

export interface SeatCandidate extends SceneObject {
  free: boolean
  occupancyConfidence?: number
}

export interface SceneWarning {
  id: string
  label?: string
  kind: 'fast-mover' | 'obstacle' | 'head-height' | 'step-up' | 'step-down' | 'drop-off' | 'doorway' | 'sensor'
  severity: 'info' | 'caution' | 'urgent'
  message: string
  observedAt: number
  distanceMeters?: number
  direction?: Direction
  closingSpeedMps?: number
  externalSpeedMps?: number
  ttcSeconds?: number
}

export interface SceneSnapshot {
  observedAt: number
  sequence: number
  trackingReady: boolean
  depthState: DepthState
  validDepthFraction: number
  cameraOrientation: 'calibrated-forward' | 'camera-forward' | 'unknown'
  objects: SceneObject[]
  freeSeats: SeatCandidate[]
  recognizedText: string[]
  textObservations?: { text: string; direction: Direction }[]
  imageBase64?: string
  temporaryImagePath?: string
  corridor?: CorridorSummary
  hazards?: SpatialHazard[]
  headingDegrees?: number
  aimState?: AimState
  pitchDegrees?: number
  depthSource?: DepthSource
  thermalState?: ThermalState
  proactiveVlmAllowed?: boolean
  lightingState?: LightingState
  ambientLuma?: number
  notes: string[]
}

export interface EngineCapabilities {
  available: boolean
  platform: string
  backend?: 'metal' | 'vulkan'
  vision: boolean
  installSizeBytes?: number
  reason?: string
}

export interface EngineStatus {
  state: 'not-installed' | 'downloading' | 'installed' | 'loading' | 'ready' | 'unloading' | 'error'
  modelId?: string
  installationId?: string
  progress?: number
  downloadedBytes?: number
  totalBytes?: number
  message?: string
}

export interface VoiceCapabilities {
  installedVoices?: { id: string; name: string; language: string }[]
  available: boolean
  onDeviceRecognition: boolean
  offlineSpeech: boolean
  route: 'headphones' | 'speaker' | 'unknown'
  reason?: string | null
}

export interface GuidanceSettings {
  onboardingComplete: boolean
  companionName: string
  stepLengthMeters: number
  voiceIdentifier?: string
  speechRate: number
  urgentHaptics: boolean
  speakerFallback: boolean
  continuousListening: boolean
  guidanceMode: SatnavMode
  talkGesture: TalkGesture
  hapticSteering: boolean
  hapticProximity: boolean
  spatialBeacon: boolean
  ambientObstacleNaming: boolean
  proactiveNarration: boolean
  directionStyle: DirectionStyle
  oledHighContrast: boolean
  warningDistanceMeters: number
  mobilityProfile: MobilityProfile
  distanceUnit: DistanceUnit
  mountMode: MountMode
  screenCurtain: boolean
  backgroundSatnav: boolean
  autoTorch: boolean
  emergencyContactName: string
  emergencyContactPhone: string
}

export interface GuidanceReply {
  text: string
  question?: string
  source?: 'view' | 'location'
  detail?: string
  errand?: Errand
  seatTarget?: { id: string; observedAt: number }
}

export interface GuidanceController {
  state: SessionState
  startPending: boolean
  cameraPermissionBlocked: boolean
  statusMessage: string
  listening: boolean
  handsFree: boolean
  speaking: boolean
  questionPhase: 'loading-model' | 'capturing' | 'looking' | 'answering' | 'locating' | null
  voiceNotice?: string
  voiceModelMissing: boolean
  speechDownloadPending: boolean
  warning?: SceneWarning
  lastReply?: GuidanceReply
  alignment?: { active: boolean; message: string }
  shoppingList: string[]
  snapshot?: SceneSnapshot
  cameraReady: boolean
  cameraHint?: string
  cameraPreviewAvailable: boolean
  engine?: EngineCapabilities
  engineStatus: EngineStatus
  vision?: EngineCapabilities
  visionStatus: EngineStatus
  voice?: VoiceCapabilities
  installModel(): Promise<void>
  cancelModelInstall(): Promise<void>
  prepareVisionModel(): Promise<boolean>
  cancelVisionInstall(): Promise<void>
  unloadVisionModel(): Promise<void>
  start(handsFree?: boolean): Promise<void>
  stop(silent?: boolean): Promise<void>
  ask(question?: string): Promise<void>
  enableHandsFree(): void
  downloadOfflineSpeech(): Promise<void>
  stopListeningInput(): void
  setTextEntry(active: boolean): void
  repeat(): Promise<void>
  checkAgain(): Promise<void>
  checkLabel(): Promise<void>
  alignToSeat(): Promise<void>
  cancelAlignment(): Promise<void>
  stopSpeech(): Promise<void>
}
