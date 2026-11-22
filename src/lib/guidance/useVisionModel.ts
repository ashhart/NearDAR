import { useEffect, useRef, useState } from 'react'
import * as Vision from '../../../modules/tensorfold-vision/src'
import type { EngineCapabilities, EngineStatus } from './types'

function cancelled(error: unknown) {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'E_INSTALL_CANCELLED'
}

export function useVisionModel() {
  const [capabilities, setCapabilities] = useState<EngineCapabilities>()
  const [status, setStatus] = useState<EngineStatus>({ state: 'not-installed' })
  const statusRef = useRef(status)
  const operation = useRef<Promise<boolean> | null>(null)
  const paused = useRef(false)
  const cancelling = useRef(false)

  function update(next: EngineStatus) {
    statusRef.current = next
    setStatus(next)
  }

  useEffect(() => {
    let observed = false
    let mounted = true
    const subscription = Vision.addVisionListener((event) => {
      if (event.status) {
        observed = true
        update(event.status)
      }
    })
    void Vision.getCapabilities().then((value) => {
      if (mounted) setCapabilities(value)
    }).catch((error: unknown) => {
      if (mounted) setCapabilities({ available: false, platform: 'unknown', vision: false, reason: error instanceof Error ? error.message : 'The visual runtime is unavailable.' })
    })
    void Vision.getStatus().then((value) => {
      if (mounted && !observed && !operation.current) update(value)
    }).catch((error: unknown) => {
      if (mounted && !observed && !operation.current) update({ state: 'error', message: error instanceof Error ? error.message : 'Could not check the visual model.' })
    })
    return () => {
      mounted = false
      subscription.remove()
    }
  }, [])

  function prepare(download = true): Promise<boolean> {
    if (operation.current) return operation.current
    const current = statusRef.current
    if (current.state === 'ready') return Promise.resolve(true)
    if (!download && (paused.current || current.state !== 'installed')) return Promise.resolve(false)
    paused.current = false
    cancelling.current = false
    const next = Promise.resolve().then(async () => {
      try {
        let installed = current
        if (installed.state !== 'installed') {
          update({ state: 'downloading', progress: 0, totalBytes: Vision.VISION_MODEL.sizeBytes })
          installed = await Vision.installModel()
        }
        if (cancelling.current) {
          update(installed)
          return false
        }
        if (installed.state === 'ready') {
          update(installed)
          return true
        }
        update({ ...installed, state: 'loading', progress: undefined })
        const loaded = await Vision.loadModel(installed.installationId)
        update(loaded)
        return loaded.state === 'ready'
      } catch (error) {
        if (cancelled(error)) {
          update({ state: 'not-installed', message: 'Download cancelled.' })
        } else {
          update({ ...statusRef.current, state: 'error', message: error instanceof Error ? error.message : 'Could not prepare the visual model.' })
        }
        return false
      } finally {
        operation.current = null
        cancelling.current = false
      }
    })
    operation.current = next
    return next
  }

  async function cancelInstall() {
    if (statusRef.current.state !== 'downloading' || cancelling.current) return
    cancelling.current = true
    try {
      await Vision.cancelInstall()
    } catch (error) {
      cancelling.current = false
      update({ ...statusRef.current, message: error instanceof Error ? error.message : 'Could not cancel the download.' })
    }
  }

  async function unload(pause = true): Promise<boolean> {
    if (operation.current) await operation.current
    const previous = statusRef.current
    if (previous.state !== 'ready') return previous.state !== 'unloading'
    if (pause) paused.current = true
    update({ ...previous, state: 'unloading' })
    try {
      await Vision.unloadModel()
      update({ ...previous, state: 'installed', message: undefined })
      return true
    } catch (error) {
      update({ ...previous, message: error instanceof Error ? error.message : 'Could not unload the visual model.' })
      return false
    }
  }

  return { capabilities, status, statusRef, prepare, cancelInstall, unload }
}
