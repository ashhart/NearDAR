import { Stack } from 'expo-router'
import { StatusBar, useColorScheme } from 'react-native'
import { useColors } from '../components/ui'
import { SettingsProvider } from '../lib/SettingsContext'
import { GuidanceProvider } from '../lib/guidance/useGuidance'

export default function RootLayout() {
  const colors = useColors()
  const dark = useColorScheme() === 'dark'
  return <SettingsProvider>
    <GuidanceProvider>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
      <Stack screenOptions={{ headerShown: false, animation: 'none', contentStyle: { backgroundColor: colors.background } }} />
    </GuidanceProvider>
  </SettingsProvider>
}
