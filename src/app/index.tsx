import { ActivityIndicator } from 'react-native'
import { Redirect } from 'expo-router'
import { useAppSettings } from '../lib/SettingsContext'
import { Screen } from '../components/ui'

export default function Start() {
  const { ready, settings } = useAppSettings()
  if (!ready) return <Screen><ActivityIndicator accessibilityLabel="Loading your settings" /></Screen>
  return <Redirect href={settings.onboardingComplete ? '/guide' : '/setup'} />
}
