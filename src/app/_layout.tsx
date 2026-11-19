import { Stack } from 'expo-router'
import { SettingsProvider } from '../lib/SettingsContext'
import { GuidanceProvider } from '../lib/guidance/useGuidance'

export default function RootLayout() {
  return <SettingsProvider><GuidanceProvider><Stack screenOptions={{ headerShown: false, animation: 'fade' }} /></GuidanceProvider></SettingsProvider>
}
