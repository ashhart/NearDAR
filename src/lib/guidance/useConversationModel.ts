import { useEffect, useRef, useState } from 'react'
import * as Engine from '../../../modules/tensorfold-engine/src'
import type { EngineCapabilities, EngineStatus } from './types'

function isInstallCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: string; name?: string }
  return candidate.code === 'E_INSTALL_CANCELLED' || candidate.name === 'AbortError'
}

export function useConversationModel(onError: (message: string) => void) {
  const [capabilities, setCapabilities] = useState<EngineCapabilities>()
  const [engineStatus, setEngineStatus] = useState<EngineStatus>({ state: 'not-installed' })
  const statusRef = useRef(engineStatus)

  function update(status: EngineStatus) {
    statusRef.current = status
    setEngineStatus(status)
  }

  useEffect(() => {
    let mounted = true
    let observed = false
    const subscription = Engine.addEngineListener((event) => {
      if (event.status) {
        observed = true
        update(event.status)
      }
      if (event.type === 'error' && event.message) onError(event.message)
    })
    void Engine.getCapabilities().then((value) => {
      if (mounted) setCapabilities(value)
    }).catch(() => {})
    void Engine.getStatus().then((value) => {
      if (mounted && !observed) update(value)
    }).catch(() => {})
    return () => {
      mounted = false
      subscription.remove()
    }
  }, [onError])

  async function installModel() {
    if (!['not-installed', 'error'].includes(statusRef.current.state)) return
    update({ state: 'downloading', progress: 0, message: 'Preparing the model download.' })
    try {
      const result = await Engine.installModel()
      update(result)
    } catch (error) {
      if (isInstallCancellation(error)) update({ state: 'not-installed', message: 'Download cancelled. No model was installed.' })
      else update({ state: 'error', message: error instanceof Error ? error.message : 'Model installation failed.' })
    }
  }

  async function cancelModelInstall() {
    try {
      if (await Engine.cancelInstall()) update({ state: 'not-installed', message: 'Download cancelled. No model was installed.' })
    } catch (error) {
      update({ state: 'error', message: error instanceof Error ? error.message : 'Could not cancel the model download.' })
    }
  }

  async function unloadModel(): Promise<boolean> {
    const previous = statusRef.current
    if (previous.state !== 'ready') return previous.state === 'installed'
    update({ ...previous, state: 'unloading', message: 'Unloading the conversation model.' })
    try {
      await Engine.unloadModel()
      update({ ...previous, state: 'installed', message: undefined })
      return true
    } catch (error) {
      update({ ...previous, message: error instanceof Error ? error.message : 'Could not unload the conversation model.' })
      return false
    }
  }

  async function loadModel(): Promise<boolean> {
    const previous = statusRef.current
    if (previous.state === 'ready') return true
    if (previous.state !== 'installed' && !(previous.state === 'error' && previous.installationId)) return false
    update({ ...previous, state: 'loading', message: 'Loading TensorFold into memory.' })
    try {
      const result = await Engine.loadModel(previous.installationId)
      update(result)
      return result.state === 'ready'
    } catch (error) {
      update({ ...previous, state: 'error', message: error instanceof Error ? error.message : 'Model loading failed.' })
      return false
    }
  }

  return { capabilities, status: engineStatus, statusRef, installModel, loadModel, cancelModelInstall, unloadModel }
}
