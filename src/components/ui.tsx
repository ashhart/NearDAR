import { useCallback, useRef, useState, type ComponentProps, type ReactNode, type Ref } from 'react'
import Ionicons from '@expo/vector-icons/Ionicons'
import { useFocusEffect } from 'expo-router'
import { AccessibilityInfo, ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View, useColorScheme, useWindowDimensions } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

const light = {
  background: '#F6F3EC', panel: '#FFFEFA', raised: '#EAE9FB', border: '#817D93', divider: '#DBD6CA',
  text: '#201E37', muted: '#514D62', accent: '#34338D', ink: '#FFFFFF', focus: '#5143C7',
  stop: '#742736', stopSurface: '#F6E6E7', ready: '#23563F', warning: '#6E3B0D', warningSurface: '#FAEBD9',
}

const dark: typeof light = {
  background: '#171622', panel: '#222131', raised: '#2D2A46', border: '#9B95AF', divider: '#48445A',
  text: '#FAF7F1', muted: '#D1CADC', accent: '#C5BFFF', ink: '#211C49', focus: '#DFD6FF',
  stop: '#FFD8DC', stopSurface: '#40252E', ready: '#B4E2CC', warning: '#FFD8AE', warningSurface: '#443025',
}

export function useColors() {
  return useColorScheme() === 'dark' ? dark : light
}

export type IconName = ComponentProps<typeof Ionicons>['name']

export function Icon({ name, size = 22, color }: { name: IconName; size?: number; color?: string }) {
  const theme = useColors()
  return <Ionicons aria-hidden accessibilityElementsHidden importantForAccessibility="no" name={name} size={size} color={color ?? theme.text} allowFontScaling={false} />
}

export function Screen({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const colors = useColors()
  const { height } = useWindowDimensions()
  const fixedFooter = footer && height >= 420
  return <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.scroll}>
      <View style={styles.content}>{children}{!fixedFooter && footer}</View>
    </ScrollView>
    {fixedFooter && <View style={[styles.dock, { backgroundColor: colors.background, borderTopColor: colors.divider }]}>
      <View style={styles.dockContent}>{footer}</View>
    </View>}
  </SafeAreaView>
}

export function Heading({ children, small = false, editorial = false, focusOnEntry = false }: { children: ReactNode; small?: boolean; editorial?: boolean; focusOnEntry?: boolean }) {
  const colors = useColors()
  const target = useRef<View>(null)
  useFocusEffect(useCallback(() => {
    if (!focusOnEntry) return
    if (Platform.OS === 'web') {
      target.current?.focus()
      return
    }
    let focused = true
    const frame = requestAnimationFrame(() => {
      void AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
        if (enabled && focused && target.current) AccessibilityInfo.sendAccessibilityEvent(target.current, 'focus')
      }).catch(() => {})
    })
    return () => {
      focused = false
      cancelAnimationFrame(frame)
    }
  }, [focusOnEntry]))
  const heading = <Text accessibilityRole={focusOnEntry ? undefined : 'header'} style={[
    styles.heading, small && styles.headingSmall, editorial && styles.editorial, { color: colors.text },
  ]}>{children}</Text>
  return focusOnEntry ? <View ref={target} accessible accessibilityRole="header" tabIndex={Platform.OS === 'web' ? -1 : undefined} style={Platform.OS === 'web' ? styles.programmaticHeading : undefined}>{heading}</View> : heading
}

export function Label({ children }: { children: ReactNode }) {
  const colors = useColors()
  return <Text accessibilityRole="header" style={[styles.label, { color: colors.text }]}>{children}</Text>
}

export function Body({ children, muted = false, live = false }: { children: ReactNode; muted?: boolean; live?: boolean }) {
  const colors = useColors()
  return <Text aria-live={live ? 'polite' : undefined} style={[styles.body, { color: muted ? colors.muted : colors.text }]}>{children}</Text>
}

export function Button({ label, onPress, icon, secondary = false, stop = false, disabled = false, busy = false, compact = false, row = false, hint, testID, selected, expanded, hostRef }: {
  label: string; onPress(): void; icon?: IconName; secondary?: boolean; stop?: boolean; disabled?: boolean; busy?: boolean; compact?: boolean; row?: boolean; hint?: string; testID?: string; selected?: boolean; expanded?: boolean; hostRef?: Ref<View>
}) {
  const colors = useColors()
  const [focused, setFocused] = useState(false)
  const textColor = disabled ? colors.muted : stop ? colors.stop : secondary ? colors.text : colors.ink
  const fill = disabled && !row ? colors.raised : stop ? colors.stopSurface : secondary ? colors.panel : colors.accent
  const border = disabled ? colors.border : stop ? colors.stop : secondary ? colors.border : colors.accent
  return <Pressable
    ref={hostRef}
    testID={testID}
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityHint={hint}
    accessibilityState={{ disabled: disabled || busy, busy, selected, expanded }}
    disabled={disabled || busy}
    onPress={onPress}
    onFocus={() => setFocused(true)}
    onBlur={() => setFocused(false)}
    style={({ pressed }) => [
      styles.button, compact && styles.compact, row && styles.row,
      { backgroundColor: fill, borderColor: border },
      focused && { outlineColor: colors.focus, outlineStyle: 'solid', outlineWidth: 3, outlineOffset: 3 },
      pressed && styles.pressed,
    ]}
  >
    {busy ? <ActivityIndicator aria-hidden color={textColor} /> : icon && <View style={row ? [styles.rowIcon, { backgroundColor: colors.raised }] : undefined}>
      <Icon name={icon} size={compact ? 20 : 24} color={row ? colors.accent : textColor} />
    </View>}
    <Text style={[styles.buttonText, { color: textColor }, compact && styles.compactText, row && styles.rowText]}>{label}</Text>
    {row && <Icon name="chevron-forward" size={20} color={colors.muted} />}
  </Pressable>
}

export function StatusCard({ title, children }: { title: string; children: ReactNode }) {
  const colors = useColors()
  return <View style={[styles.card, { borderColor: colors.divider, backgroundColor: colors.panel }]}><Label>{title}</Label>{children}</View>
}

export function TopBar({ back, settings, settingsDisabled = false }: { back?: () => void; settings?: () => void; settingsDisabled?: boolean }) {
  const colors = useColors()
  return <View style={styles.topBar}>
    {back ? <Button compact secondary icon="chevron-back" label="Back to NearDAR" onPress={back} /> : <View style={styles.brand}>
      <View style={[styles.logomark, { backgroundColor: colors.raised }]}><Icon name="radio-outline" size={24} color={colors.accent} /></View>
      <Text style={[styles.wordmark, { color: colors.text }]}>NearDAR</Text>
    </View>}
    {settings && <Button compact secondary icon="settings-outline" label="Settings" disabled={settingsDisabled} onPress={settings} />}
  </View>
}

export function Signal({ children, tone = 'quiet', live = false }: { children: ReactNode; tone?: 'quiet' | 'ready' | 'attention'; live?: boolean }) {
  const colors = useColors()
  const color = tone === 'ready' ? colors.ready : tone === 'attention' ? colors.warning : colors.muted
  return <View style={styles.signal}>
    <View aria-hidden style={[styles.dot, { backgroundColor: color }]} />
    <Text aria-live={live ? 'polite' : undefined} style={[styles.signalText, { color }]}>{children}</Text>
  </View>
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { flexGrow: 1, paddingBottom: 25 },
  content: { width: '100%', maxWidth: 550, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 14, gap: 20 },
  dock: { borderTopWidth: 1, paddingHorizontal: 20, paddingVertical: 10 },
  dockContent: { width: '100%', maxWidth: 510, alignSelf: 'center' },
  topBar: { minHeight: 52, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  logomark: { height: 40, width: 40, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  wordmark: { fontSize: 24, fontWeight: '700', letterSpacing: -0.8 },
  heading: { fontSize: 36, lineHeight: 41, fontWeight: '700', letterSpacing: -1.2 },
  headingSmall: { fontSize: 25, lineHeight: 31, letterSpacing: -0.4 },
  programmaticHeading: { outlineWidth: 0 },
  editorial: { fontFamily: Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia' }), fontWeight: '400', fontSize: 43, lineHeight: 47, letterSpacing: -1.6 },
  label: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  body: { fontSize: 17, lineHeight: 25 },
  button: { minHeight: 62, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 17, paddingVertical: 13, borderRadius: 16, borderWidth: 1.5 },
  compact: { minHeight: 52, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10 },
  row: { justifyContent: 'flex-start', borderWidth: 0, paddingHorizontal: 13 },
  rowIcon: { width: 41, height: 41, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  rowText: { textAlign: 'left', flex: 1 },
  buttonText: { fontSize: 19, fontWeight: '700', textAlign: 'center', flexShrink: 1 },
  compactText: { fontSize: 16 },
  pressed: { opacity: 0.82 },
  card: { padding: 17, borderRadius: 22, borderWidth: 1, gap: 13 },
  signal: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  signalText: { fontSize: 16, lineHeight: 22, fontWeight: '700', flexShrink: 1 },
})
