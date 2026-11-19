export type SessionState = 'idle' | 'starting' | 'active' | 'degraded' | 'paused' | 'error'
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
  available: boolean
  onDeviceRecognition: boolean
  offlineSpeech: boolean
  route: 'headphones' | 'speaker' | 'unknown'
  reason?: string | null
}

export interface GuidanceSettings {
  onboardingComplete: boolean
  stepLengthMeters: number
  speechRate: number
  urgentHaptics: boolean
  speakerFallback: boolean
  continuousListening: boolean
}

export interface GuidanceController {
  state: SessionState
  statusMessage: string
  listening: boolean
  speaking: boolean
  processing: boolean
  lastAnswer: string
  lastTranscript: string
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
  installVisionModel(): Promise<void>
  loadVisionModel(): Promise<void>
  cancelVisionInstall(): Promise<void>
  unloadVisionModel(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  ask(question?: string): Promise<void>
  repeat(): Promise<void>
  stopSpeech(): Promise<void>
}
