import { useEffect, useState } from 'react'
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

  useEffect(() => {
    let mounted = true
    let observed = false
    const subscription = Engine.addEngineListener((event) => {
      if (event.status) {
        observed = true
        setEngineStatus(event.status)
      }
      if (event.type === 'error' && event.message) onError(event.message)
    })
    void Engine.getCapabilities().then((value) => {
      if (mounted) setCapabilities(value)
    }).catch(() => {})
    void Engine.getStatus().then((value) => {
      if (mounted && !observed) setEngineStatus(value)
    }).catch(() => {})
    return () => {
      mounted = false
      subscription.remove()
    }
  }, [onError])

  async function installModel() {
    setEngineStatus({ state: 'downloading', progress: 0, message: 'Preparing the model download.' })
    try {
      const result = await Engine.installModel()
      setEngineStatus(result)
    } catch (error) {
      if (isInstallCancellation(error)) setEngineStatus({ state: 'not-installed', message: 'Download cancelled. No model was installed.' })
      else setEngineStatus({ state: 'error', message: error instanceof Error ? error.message : 'Model installation failed.' })
    }
  }

  async function cancelModelInstall() {
    try {
      if (await Engine.cancelInstall()) setEngineStatus({ state: 'not-installed', message: 'Download cancelled. No model was installed.' })
    } catch (error) {
      setEngineStatus({ state: 'error', message: error instanceof Error ? error.message : 'Could not cancel the model download.' })
    }
  }

  async function unloadModel() {
    setEngineStatus({ ...engineStatus, state: 'unloading', message: 'Unloading the conversation model.' })
    try {
      await Engine.unloadModel()
      setEngineStatus({ ...engineStatus, state: 'installed', message: 'Conversation model unloaded. Sensor guidance remains available.' })
    } catch (error) {
      setEngineStatus({ ...engineStatus, state: 'error', message: error instanceof Error ? error.message : 'Could not unload the conversation model.' })
    }
  }

  async function loadModel() {
    setEngineStatus({ state: 'loading', installationId: engineStatus.installationId, message: 'Loading TensorFold into memory.' })
    try {
      const result = await Engine.loadModel(engineStatus.installationId)
      setEngineStatus(result)
    } catch (error) {
      setEngineStatus({ state: 'error', installationId: engineStatus.installationId, message: error instanceof Error ? error.message : 'Model loading failed.' })
    }
  }

  return { capabilities, status: engineStatus, installModel, loadModel, cancelModelInstall, unloadModel }
}
