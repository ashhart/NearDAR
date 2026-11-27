import { useCallback, useEffect, useRef, useState } from 'react'
import * as Engine from '../../../modules/tensorfold-engine/src'
import type { EngineCapabilities, EngineStatus } from '../guidance/types'

export interface TensorFoldEngineStore {
  capabilities?: EngineCapabilities
  status: EngineStatus
  statusRef: { current: EngineStatus }
  prepare(download?: boolean): Promise<boolean>
  cancelInstall(): Promise<void>
  unload(announceUnload?: boolean): Promise<boolean>
}

export function useTensorFoldEngine(): TensorFoldEngineStore {
  const [capabilities, setCapabilities] = useState<EngineCapabilities>()
  const [status, setStatus] = useState<EngineStatus>({ state: 'not-installed', modelId: Engine.defaultModelId })
  const statusRef = useRef<EngineStatus>(status)
  statusRef.current = status
  const workRef = useRef<Promise<boolean> | undefined>(undefined)
  const mountedRef = useRef(true)

  const syncStatus = useCallback((next: EngineStatus) => {
    statusRef.current = next
    if (mountedRef.current) setStatus(next)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void Engine.getCapabilities()
      .then((caps) => { if (mountedRef.current) setCapabilities(caps) })
      .catch(() => {})
    void Engine.getStatus()
      .then((st) => { if (mountedRef.current) syncStatus(st) })
      .catch(() => {})
    const sub = Engine.addEngineListener((event) => {
      if (event.type === 'status' && event.status) syncStatus(event.status)
    })
    return () => {
      mountedRef.current = false
      sub.remove()
    }
  }, [syncStatus])

  const prepare = useCallback((download = true): Promise<boolean> => {
    if (statusRef.current.state === 'ready') return Promise.resolve(true)
    if (workRef.current) return workRef.current
    const job = (async () => {
      try {
        const caps = await Engine.getCapabilities()
        if (mountedRef.current) setCapabilities(caps)
        if (!caps.available) return false

        let current = await Engine.getStatus()
        syncStatus(current)
        if (current.state === 'ready') return true

        if (current.state === 'not-installed' || (current.state === 'error' && !current.installationId)) {
          if (!download) return false
          current = await Engine.installModel(Engine.defaultModelId)
          syncStatus(current)
        }

        if (current.state === 'installed' || current.state === 'loading' || (current.state === 'error' && current.installationId)) {
          const loaded = await Engine.loadModel(current.installationId)
          syncStatus(loaded)
          return loaded.state === 'ready'
        }
        return statusRef.current.state === 'ready'
      } catch (error) {
        const message = error instanceof Error ? error.message : 'TensorFold Mobile could not start.'
        syncStatus({ ...statusRef.current, state: 'error', message })
        return false
      } finally {
        workRef.current = undefined
      }
    })()
    workRef.current = job
    return job
  }, [syncStatus])

  const cancelInstall = useCallback(async () => {
    await Engine.cancelInstall(Engine.defaultModelId).catch(() => false)
    const next = await Engine.getStatus().catch(() => ({ state: 'not-installed' as const, modelId: Engine.defaultModelId }))
    syncStatus(next)
  }, [syncStatus])

  const unload = useCallback(async (announceUnload = true): Promise<boolean> => {
    try {
      await Engine.unloadModel()
      const next = await Engine.getStatus().catch(() => ({ state: 'installed' as const, modelId: Engine.defaultModelId }))
      syncStatus(announceUnload ? { ...next, message: 'TensorFold unloaded from GPU memory.' } : next)
      return true
    } catch {
      return false
    }
  }, [syncStatus])

  return { capabilities, status, statusRef, prepare, cancelInstall, unload }
}
