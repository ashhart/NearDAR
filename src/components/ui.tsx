import type { ReactNode } from 'react'
import { Pressable, ScrollView, Text, View, useColorScheme } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

export function palette(dark: boolean) {
  return dark ? {
    background: '#07111b', card: '#10202d', text: '#f5fafc', muted: '#9bb0bd', accent: '#58dfc5', accentText: '#061a16', border: '#34505f', danger: '#ff9b8f', success: '#79dfb2',
  } : {
    background: '#f2f7f8', card: '#ffffff', text: '#10232d', muted: '#526d79', accent: '#007f72', accentText: '#ffffff', border: '#b7cbd1', danger: '#a9362d', success: '#24784e',
  }
}

export function SonarMark({ active = false, size = 184 }: { active?: boolean; size?: number }) {
  const colors = palette(useColorScheme() === 'dark')
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    {[1, 0.76, 0.51].map((ratio, index) => <View key={ratio} style={{
      position: 'absolute', width: size * ratio, height: size * ratio, borderRadius: size * ratio / 2,
      borderWidth: index === 0 ? 1 : 1.5,
      borderColor: active && index > 0 ? colors.accent : colors.border,
      opacity: active ? 0.34 + index * 0.2 : 0.25 + index * 0.12,
    }} />)}
    <View style={{
      width: size * 0.22, height: size * 0.22, borderRadius: size * 0.11,
      backgroundColor: active ? colors.accent : colors.muted,
      shadowColor: colors.accent, shadowOpacity: active ? 0.35 : 0, shadowRadius: 22,
      shadowOffset: { width: 0, height: 0 }, elevation: active ? 8 : 0,
    }} />
  </View>
}

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const colors = palette(useColorScheme() === 'dark')
  const content = <View style={{ width: '100%', maxWidth: 700, alignSelf: 'center', padding: 24, gap: 22, zIndex: 1 }}>{children}</View>
  return <SafeAreaView style={{ flex: 1, backgroundColor: colors.background, overflow: 'hidden' }}>
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: 'absolute', top: -130, right: -135, opacity: 0.25 }}>
      <SonarMark size={330} />
    </View>
    {scroll ? <ScrollView contentContainerStyle={{ flexGrow: 1, paddingBottom: 34 }}>{content}</ScrollView> : content}
  </SafeAreaView>
}

export function Heading({ children, small = false, center = false }: { children: ReactNode; small?: boolean; center?: boolean }) {
  const colors = palette(useColorScheme() === 'dark')
  return <Text accessibilityRole="header" style={{ color: colors.text, fontSize: small ? 25 : 40, lineHeight: small ? 32 : 48, fontWeight: '700', letterSpacing: -0.7, textAlign: center ? 'center' : 'left' }}>{children}</Text>
}

export function Label({ children, center = false }: { children: ReactNode; center?: boolean }) {
  const colors = palette(useColorScheme() === 'dark')
  return <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18, fontWeight: '700', letterSpacing: 1.8, textTransform: 'uppercase', textAlign: center ? 'center' : 'left' }}>{children}</Text>
}

export function Body({ children, muted = false, center = false }: { children: ReactNode; muted?: boolean; center?: boolean }) {
  const colors = palette(useColorScheme() === 'dark')
  return <Text style={{ color: muted ? colors.muted : colors.text, fontSize: 17, lineHeight: 27, textAlign: center ? 'center' : 'left' }}>{children}</Text>
}

export function Button({ label, onPress, secondary = false, danger = false, disabled = false, busy = false, compact = false, hint }: {
  label: string; onPress(): void; secondary?: boolean; danger?: boolean; disabled?: boolean; busy?: boolean; compact?: boolean; hint?: string
}) {
  const colors = palette(useColorScheme() === 'dark')
  const foreground = danger ? colors.danger : secondary ? colors.text : colors.accentText
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityHint={hint}
    accessibilityState={{ disabled: disabled || busy, busy }}
    disabled={disabled || busy}
    onPress={onPress}
    style={({ pressed }) => ({
      minHeight: compact ? 44 : 64, borderRadius: compact ? 13 : 19,
      paddingHorizontal: compact ? 14 : 22, paddingVertical: compact ? 10 : 18,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: secondary || danger ? colors.card : colors.accent,
      borderWidth: secondary || danger ? 1 : 0,
      borderColor: danger ? colors.danger : secondary ? colors.border : colors.accent,
      shadowColor: '#000000', shadowOpacity: secondary || danger ? 0 : 0.16, shadowRadius: 12,
      shadowOffset: { width: 0, height: 6 }, elevation: secondary || danger ? 0 : 3,
      opacity: disabled || busy ? 0.48 : pressed ? 0.76 : 1,
    })}
  ><Text style={{ color: foreground, fontSize: compact ? 15 : 18, fontWeight: '700', textAlign: 'center' }}>{busy ? `${label}, working` : label}</Text></Pressable>
}

export function StatusCard({ title, children, error = false }: { title: string; children: ReactNode; error?: boolean }) {
  const colors = palette(useColorScheme() === 'dark')
  return <View style={{ padding: 22, borderRadius: 22, borderWidth: 1, borderColor: error ? colors.danger : colors.border, backgroundColor: colors.card, gap: 12 }}>
    <Label>{title}</Label>
    {children}
  </View>
}
