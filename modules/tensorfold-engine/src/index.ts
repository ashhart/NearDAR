import { type EventSubscription, requireOptionalNativeModule } from 'expo-modules-core'
import { createDefaultManifest, defaultModelId, throwIfCancelled } from './manifest'
import type { EngineEvent, EngineStatus, InstallManifest, NativeTensorFoldEngine } from './types'

const unavailableMessage = 'TensorFold native inference is unavailable on this platform. Install the iOS or Android development build.'
const unavailable: NativeTensorFoldEngine = {
  getCapabilities: async () => ({
    available: false,
    platform: 'web',
    vision: false,
    reason: unavailableMessage,
  }),
  getStatus: async () => ({ state: 'not-installed', message: unavailableMessage }),
  installManifest: async () => { throw new Error(unavailableMessage) },
  loadModel: async () => { throw new Error(unavailableMessage) },
  unloadModel: async () => { throw new Error(unavailableMessage) },
  generate: async () => { throw new Error(unavailableMessage) },
  cancel: async () => { throw new Error(unavailableMessage) },
  cancelInstall: async () => false,
  addListener: () => {},
  removeListener: () => {},
}
const Native = requireOptionalNativeModule<NativeTensorFoldEngine>('TensorFoldEngine') ?? unavailable

const installations = new Map<string, AbortController>()

async function installModel(modelId: string = defaultModelId): Promise<EngineStatus> {
  if (modelId !== defaultModelId) {
    throw new Error(`Unknown on-device model ${modelId}. This build admits Qwen3.5-2B only.`)
  }
  if (installations.has(modelId)) throw new Error(`Model ${modelId} is already installing.`)
  const controller = new AbortController()
  installations.set(modelId, controller)
  try {
    const manifest: InstallManifest = await createDefaultManifest(controller.signal)
    throwIfCancelled(controller.signal)
    return await Native.installManifest(manifest)
  } catch (error) {
    throwIfCancelled(controller.signal)
    throw error
  } finally {
    installations.delete(modelId)
  }
}

async function cancelInstall(modelId: string = defaultModelId): Promise<boolean> {
  const controller = installations.get(modelId)
  controller?.abort()
  const nativeCancelled = await Native.cancelInstall(modelId)
  return controller !== undefined || nativeCancelled
}

const Engine = {
  getCapabilities: Native.getCapabilities,
  getStatus: Native.getStatus,
  installModel,
  cancelInstall,
  loadModel: Native.loadModel,
  unloadModel: Native.unloadModel,
  generate: Native.generate,
  cancel: Native.cancel,
  addListener: Native.addListener,
  removeListener: Native.removeListener,
}
export const getCapabilities = Native.getCapabilities
export const getStatus = Native.getStatus
export const loadModel = Native.loadModel
export const unloadModel = Native.unloadModel
export const generate = Native.generate
export const cancel = Native.cancel
export { installModel, cancelInstall }

export function addEngineListener(listener: (event: EngineEvent) => void): EventSubscription {
  Native.addListener('onEngineEvent', listener)
  return { remove: () => Native.removeListener('onEngineEvent', listener) }
}


export type { EngineCapabilities, EngineEvent, EngineGenerationRequest, EngineStatus } from './types'
export { createDefaultManifest } from './manifest'
export default Engine
