import AsyncStorage from '@react-native-async-storage/async-storage'
import { useEffect, useState } from 'react'
import type { GuidanceSettings } from './guidance/types'
const key = 'guide.settings.v1'


export interface SettingsStore {
  settings: GuidanceSettings
  ready: boolean
  update(patch: Partial<GuidanceSettings>): Promise<void>
}

export const defaultSettings: GuidanceSettings = {
  onboardingComplete: false,
  stepLengthMeters: 0.65,
  speechRate: 1,
  urgentHaptics: true,
  speakerFallback: true,
  continuousListening: true,
}

function validSettings(value: unknown): GuidanceSettings {
  if (!value || typeof value !== 'object') return defaultSettings
  const stored = value as Partial<GuidanceSettings>
  return {
    onboardingComplete: stored.onboardingComplete === true,
    stepLengthMeters: typeof stored.stepLengthMeters === 'number' && stored.stepLengthMeters >= 0.4 && stored.stepLengthMeters <= 1 ? stored.stepLengthMeters : 0.65,
    speechRate: typeof stored.speechRate === 'number' && stored.speechRate >= 0.5 && stored.speechRate <= 1.5 ? stored.speechRate : 1,
    urgentHaptics: stored.urgentHaptics !== false,
    speakerFallback: stored.speakerFallback !== false,
    continuousListening: stored.continuousListening !== false,
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

  useEffect(() => {
    let mounted = true
    void readSettings().then((stored) => {
      if (!mounted) return
      setSettings(stored)
      setReady(true)
    })
    return () => { mounted = false }
  }, [])

  async function update(patch: Partial<GuidanceSettings>) {
    const next = validSettings({ ...settings, ...patch })
    setSettings(next)
    await storeSettings(next)
  }

  return { settings, ready, update }
}
