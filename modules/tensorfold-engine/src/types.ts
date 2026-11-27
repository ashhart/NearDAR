import type { EngineGenerationRequest } from '../../../src/lib/guidance/native'
import type { EngineCapabilities, EngineStatus } from '../../../src/lib/guidance/types'

export type { EngineCapabilities, EngineGenerationRequest, EngineStatus }

export interface EngineEvent {
  type: 'status' | 'token' | 'completed' | 'cancelled' | 'error'
  status?: EngineStatus
  requestId?: string
  token?: string
  text?: string
  message?: string
}

export interface ModelFile {
  path: string
  url: string
  size: number
  sha256: string
}

export interface InstallManifest {
  modelId: string
  revision: string
  files: ModelFile[]
  maxTotalBytes?: number
  overwrite?: boolean
}

export interface NativeTensorFoldEngine {
  getCapabilities(): Promise<EngineCapabilities>
  getStatus(): Promise<EngineStatus>
  installManifest(manifest: InstallManifest): Promise<EngineStatus>
  cancelInstall(modelId: string): Promise<boolean>
  loadModel(installationId?: string): Promise<EngineStatus>
  unloadModel(): Promise<void>
  generate(request: EngineGenerationRequest): Promise<string>
  cancel(requestId: string): Promise<void>
  addListener(eventName: string, listener: (event: EngineEvent) => void): void
  removeListener(eventName: string, listener: (event: EngineEvent) => void): void
}
