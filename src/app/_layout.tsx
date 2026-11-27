import { Stack } from 'expo-router'
import { StatusBar, useColorScheme } from 'react-native'
import { useColors } from '../components/ui'
import { SettingsProvider, useAppSettings } from '../lib/SettingsContext'
import { SatnavProvider } from '../lib/satnav/useSatnav'

function AppShell() {
  const colors = useColors()
  const { settings } = useAppSettings()
  const scheme = useColorScheme()
  const dark = settings.oledHighContrast || scheme === 'dark'
  return (
    <SatnavProvider>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
      <Stack screenOptions={{ headerShown: false, animation: 'none', contentStyle: { backgroundColor: colors.background } }} />
    </SatnavProvider>
  )
}

export default function RootLayout() {
  return (
    <SettingsProvider>
      <AppShell />
    </SettingsProvider>
  )
}
