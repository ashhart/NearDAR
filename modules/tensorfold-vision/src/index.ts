import { type EventSubscription, requireOptionalNativeModule } from 'expo-modules-core'

export interface VisionCapabilities {
  /** Whether the native runtime is linked. loadModel confirms device accelerator support. */
  available: boolean
  platform: string
  backend?: 'metal' | 'vulkan'
  vision: boolean
  installSizeBytes: number
  reason?: string
  modelId: typeof VISION_MODEL.id
  revision: typeof VISION_MODEL.revision
  runtime: 'LiteRT-LM'
  runtimeVersion: '0.19.1'
  /** Vision accelerator. Android uses a separate CPU decoder; iOS also uses GPU decoding. */
  accelerator?: 'metal' | 'gpu'
  recommendedFreeMemoryBytes: number
  supportsCancellation: boolean
  loaded: boolean
}

export interface VisionStatus {
  state: 'not-installed' | 'downloading' | 'installed' | 'loading' | 'ready' | 'unloading' | 'error'
  modelId: string
  installationId?: string
  revision: string
  progress?: number
  downloadedBytes?: number
  totalBytes?: number
  message?: string
}

export interface DescribeSceneRequest {
  requestId: string
  prompt: string
  imageBase64?: string
  temporaryImagePath?: string
  maxTokens: number
}

export interface VisionEvent {
  type: 'status' | 'started' | 'token' | 'completed' | 'cancelled' | 'error'
  status?: VisionStatus
  requestId?: string
  message?: string
  delta?: string
  text?: string
}

export const VISION_MODEL = {
  id: 'SmolVLM2-500M',
  revision: '8dbba113efdeca80107357d76ab00fc0c71048fd',
  fileName: 'SmolVLM2-500M.litertlm',
  sizeBytes: 363_085_824,
  sha256: '7b432bbc0a5c54ba15ecb2f039a7711c1cfb1fe38badec01397a076b5043f74e',
} as const

export interface NativeTensorFoldVision {
  getCapabilities(): Promise<VisionCapabilities>
  getStatus(): Promise<VisionStatus>
  describeScene(request: DescribeSceneRequest): Promise<string>
  installModel(modelId?: string): Promise<VisionStatus>
  loadModel(installationId?: string): Promise<VisionStatus>
  unloadModel(): Promise<void>
  cancelInstall(): Promise<void>
  cancel(requestId: string): Promise<void>
  addListener(eventName: 'onVisionEvent', listener: (event: VisionEvent) => void): void
  removeListener(eventName: 'onVisionEvent', listener: (event: VisionEvent) => void): void
}

const unavailableMessage = 'TensorFold on-device vision is unavailable. Use the iOS or Android development build with TensorFoldVision linked.'
const unavailable: NativeTensorFoldVision = {
  getCapabilities: async () => ({
    available: false,
    platform: 'web',
    vision: false,
    installSizeBytes: VISION_MODEL.sizeBytes,
    reason: unavailableMessage,
    modelId: VISION_MODEL.id,
    revision: VISION_MODEL.revision,
    runtime: 'LiteRT-LM',
    runtimeVersion: '0.19.1',
    recommendedFreeMemoryBytes: 1_500_000_000,
    supportsCancellation: false,
    loaded: false,
  }),
  getStatus: async () => ({
    state: 'not-installed',
    modelId: VISION_MODEL.id,
    revision: VISION_MODEL.revision,
    message: unavailableMessage,
  }),
  installModel: async () => { throw new Error(unavailableMessage) },
  loadModel: async () => { throw new Error(unavailableMessage) },
  unloadModel: async () => { throw new Error(unavailableMessage) },
  describeScene: async () => { throw new Error(unavailableMessage) },
  cancel: async () => { throw new Error(unavailableMessage) },
  cancelInstall: async () => { throw new Error(unavailableMessage) },
  addListener: () => {},
  removeListener: () => {},
}
const Vision = requireOptionalNativeModule<NativeTensorFoldVision>('TensorFoldVision') ?? unavailable

export function getCapabilities(): Promise<VisionCapabilities> {
  return Vision.getCapabilities()
}

export function getStatus(): Promise<VisionStatus> {
  return Vision.getStatus()
}

export function installModel(modelId: string = VISION_MODEL.id): Promise<VisionStatus> {
  if (modelId !== VISION_MODEL.id) throw new Error(`Unsupported vision model: ${modelId}`)
  return Vision.installModel(modelId)
}

export function cancelInstall(): Promise<void> {
  return Vision.cancelInstall()
}


export function loadModel(installationId?: string): Promise<VisionStatus> {
  if (installationId !== undefined && installationId !== VISION_MODEL.revision) {
    throw new Error(`Unsupported vision installation: ${installationId}`)
  }
  return Vision.loadModel(installationId)
}

export function unloadModel(): Promise<void> {
  return Vision.unloadModel()
}

/** The native result is raw model text. Grounding and response-schema checks belong to the caller. */
export function describeScene(request: DescribeSceneRequest): Promise<string> {
  if (!request.requestId.trim()) throw new Error('requestId must not be empty')
  if (!request.prompt.trim()) throw new Error('prompt must not be empty')
  if (request.prompt.length > 8_192) throw new Error('prompt must not exceed 8192 characters')
  if (!Number.isInteger(request.maxTokens) || request.maxTokens < 1 || request.maxTokens > 256) {
    throw new Error('maxTokens must be an integer from 1 through 256')
  }
  if (Boolean(request.imageBase64) === Boolean(request.temporaryImagePath)) {
    throw new Error('Supply exactly one of imageBase64 or temporaryImagePath')
  }
  return Vision.describeScene(request)
}

export function cancel(requestId: string): Promise<void> {
  if (!requestId.trim()) return Promise.resolve()
  return Vision.cancel(requestId)
}

export function addVisionListener(listener: (event: VisionEvent) => void): EventSubscription {
  Vision.addListener('onVisionEvent', listener)
  return { remove: () => Vision.removeListener('onVisionEvent', listener) }
}

// Export the native module itself so EventEmitter(Vision) and Expo named imports both work.
export default Vision
