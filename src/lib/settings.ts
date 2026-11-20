import AsyncStorage from '@react-native-async-storage/async-storage'
import { useEffect, useRef, useState } from 'react'
import type { GuidanceSettings } from './guidance/types'
const key = 'guide.settings.v1'


export interface SettingsStore {
  settings: GuidanceSettings
  ready: boolean
  saveError?: string
  update(patch: Partial<GuidanceSettings>): Promise<void>
}

export const defaultSettings: GuidanceSettings = {
  onboardingComplete: false,
  companionName: '',
  stepLengthMeters: 0.65,
  speechRate: 1,
  urgentHaptics: true,
  speakerFallback: true,
  continuousListening: false,
}

export function normalizeCompanionName(value: string): string {
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, 40).join('')
}

function validSettings(value: unknown): GuidanceSettings {
  if (!value || typeof value !== 'object') return defaultSettings
  const stored = value as Partial<GuidanceSettings>
  return {
    onboardingComplete: stored.onboardingComplete === true,
    companionName: typeof stored.companionName === 'string' ? normalizeCompanionName(stored.companionName) : '',
    stepLengthMeters: typeof stored.stepLengthMeters === 'number' && stored.stepLengthMeters >= 0.4 && stored.stepLengthMeters <= 1 ? stored.stepLengthMeters : 0.65,
    speechRate: typeof stored.speechRate === 'number' && stored.speechRate >= 0.5 && stored.speechRate <= 1.5 ? stored.speechRate : 1,
    urgentHaptics: stored.urgentHaptics !== false,
    speakerFallback: stored.speakerFallback !== false,
    continuousListening: stored.continuousListening === true,
  }
}

export async function readSettings(): Promise<GuidanceSettings> {
  const raw = await AsyncStorage.getItem(key)
  if (!raw) return defaultSettings
  try {
    return validSettings(JSON.parse(raw))
  } catch {
    return defaultSettings
  }
}

export async function storeSettings(settings: GuidanceSettings): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(validSettings(settings)))
}

export function useSettings(): SettingsStore {
  const [settings, setSettings] = useState(defaultSettings)
  const [ready, setReady] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const latest = useRef(defaultSettings)
  const pendingWrite = useRef(Promise.resolve())

  useEffect(() => {
    let mounted = true
    void readSettings().catch(() => defaultSettings).then((stored) => {
      if (!mounted) return
      latest.current = stored
      setSettings(stored)
      setReady(true)
    })
    return () => { mounted = false }
  }, [])

  async function update(patch: Partial<GuidanceSettings>) {
    const next = validSettings({ ...latest.current, ...patch })
    latest.current = next
    setSettings(next)
    const write = pendingWrite.current.then(() => storeSettings(next))
    pendingWrite.current = write.then(() => setSaveError(undefined), () => setSaveError('NearDAR couldn’t save these settings. They apply until you close the app.'))
    await pendingWrite.current
  }

  return { settings, ready, saveError, update }
}
