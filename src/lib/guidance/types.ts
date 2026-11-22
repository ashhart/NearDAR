import type { Errand } from './errands'

export type SessionState = 'idle' | 'starting' | 'active' | 'degraded' | 'stopping' | 'paused' | 'error'
export type DepthState = 'unavailable' | 'starting' | 'ready' | 'stale' | 'limited' | 'lost'
export type Direction = 'ahead' | 'ahead-left' | 'ahead-right' | 'left' | 'right' | 'behind' | 'unknown'

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
  kind: 'obstacle' | 'step-up' | 'step-down' | 'drop-off' | 'sensor'
  severity: 'info' | 'caution' | 'urgent'
  message: string
  observedAt: number
  distanceMeters?: number
  direction?: Direction
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
}

export interface GuidanceReply {
  text: string
  question?: string
  source?: 'view' | 'location'
  detail?: string
  errand?: Errand
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
  shoppingList: string[]
  snapshot?: SceneSnapshot
  engine?: EngineCapabilities
  engineStatus: EngineStatus
  vision?: EngineCapabilities
  visionStatus: EngineStatus
  voice?: VoiceCapabilities
  installModel(): Promise<void>
  loadModel(): Promise<void>
  cancelModelInstall(): Promise<void>
  unloadModel(): Promise<void>
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
  stopSpeech(): Promise<void>
}
