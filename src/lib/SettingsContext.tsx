import { createContext, useContext, type ReactNode } from 'react'
import { useSettings, type SettingsStore } from './settings'

const Context = createContext<SettingsStore | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const value = useSettings()
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useAppSettings() {
  const value = useContext(Context)
  if (!value) throw new Error('SettingsProvider is missing')
  return value
}
