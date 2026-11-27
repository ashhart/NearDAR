import { useCallback, useRef, useState, type ComponentProps, type ReactNode, type Ref } from 'react'
import Ionicons from '@expo/vector-icons/Ionicons'
import { useFocusEffect } from 'expo-router'
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
  useWindowDimensions,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useOptionalAppSettings } from '../lib/SettingsContext'

/** Crisp daylight palette for outdoor low-vision legibility. */
const light = {
  background: '#F2F4F8',
  panel: '#FFFFFF',
  raised: '#E6ECF5',
  border: 'rgba(15, 23, 42, 0.12)',
  divider: 'rgba(15, 23, 42, 0.08)',
  text: '#0A0F1C',
  muted: '#526077',
  accent: '#007AFF',
  accentSoft: 'rgba(0, 122, 255, 0.12)',
  ink: '#FFFFFF',
  focus: '#0051D5',
  stop: '#D92D20',
  stopSurface: 'rgba(217, 45, 32, 0.10)',
  ready: '#128046',
  readySurface: 'rgba(18, 128, 70, 0.12)',
  warning: '#B54708',
  warningSurface: 'rgba(245, 158, 11, 0.14)',
}

/** Modern obsidian spatial instrument dark theme (Apple Maps / Watch Ultra inspired). */
const dark: typeof light = {
  background: '#080A0F',
  panel: '#121620',
  raised: '#1B2230',
  border: 'rgba(255, 255, 255, 0.10)',
  divider: 'rgba(255, 255, 255, 0.07)',
  text: '#F8FAFC',
  muted: '#8D9BB0',
  accent: '#38BDF8',
  accentSoft: 'rgba(56, 189, 248, 0.15)',
  ink: '#04121B',
  focus: '#7DD3FC',
  stop: '#FF453A',
  stopSurface: 'rgba(255, 69, 58, 0.14)',
  ready: '#30D158',
  readySurface: 'rgba(48, 209, 88, 0.14)',
  warning: '#FFB340',
  warningSurface: 'rgba(255, 179, 64, 0.14)',
}

/** Refined OLED True-Black high-contrast palette (21:1 text contrast, zero harsh neon wireframes). */
const oledHighContrast: typeof light = {
  background: '#000000',
  panel: '#0D0E12',
  raised: '#171920',
  border: 'rgba(255, 255, 255, 0.22)',
  divider: 'rgba(255, 255, 255, 0.14)',
  text: '#FFFFFF',
  muted: '#C7CDD8',
  accent: '#FFD60A',
  accentSoft: 'rgba(255, 214, 10, 0.16)',
  ink: '#000000',
  focus: '#FFD60A',
  stop: '#FF453A',
  stopSurface: 'rgba(255, 69, 58, 0.18)',
  ready: '#30D158',
  readySurface: 'rgba(48, 209, 88, 0.18)',
  warning: '#FFD60A',
  warningSurface: 'rgba(255, 214, 10, 0.16)',
}

export function useColors() {
  const scheme = useColorScheme()
  const store = useOptionalAppSettings()
  if (store?.settings.oledHighContrast) return oledHighContrast
  return scheme === 'dark' ? dark : light
}

export type IconName = ComponentProps<typeof Ionicons>['name']

export function Icon({ name, size = 21, color }: { name: IconName; size?: number; color?: string }) {
  const theme = useColors()
  return (
    <Ionicons
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no"
      name={name}
      size={size}
      color={color ?? theme.text}
      allowFontScaling={false}
    />
  )
}

export function Screen({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const colors = useColors()
  const { height } = useWindowDimensions()
  const fixedFooter = footer && height >= 420
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
      >
        <View style={styles.content}>
          {children}
          {!fixedFooter && footer}
        </View>
      </ScrollView>
      {fixedFooter && (
        <View style={[styles.dock, { backgroundColor: colors.background, borderTopColor: colors.divider }]}>
          <View style={styles.dockContent}>{footer}</View>
        </View>
      )}
    </SafeAreaView>
  )
}

export function Heading({
  children,
  small = false,
  editorial = false,
  focusOnEntry = false,
}: {
  children: ReactNode
  small?: boolean
  editorial?: boolean
  focusOnEntry?: boolean
}) {
  const colors = useColors()
  const target = useRef<View>(null)
  useFocusEffect(
    useCallback(() => {
      if (!focusOnEntry) return
      if (Platform.OS === 'web') {
        target.current?.focus()
        return
      }
      let focused = true
      const frame = requestAnimationFrame(() => {
        void AccessibilityInfo.isScreenReaderEnabled()
          .then((enabled) => {
            if (enabled && focused && target.current) AccessibilityInfo.sendAccessibilityEvent(target.current, 'focus')
          })
          .catch(() => {})
      })
      return () => {
        focused = false
        cancelAnimationFrame(frame)
      }
    }, [focusOnEntry]),
  )
  const heading = (
    <Text
      accessibilityRole={focusOnEntry ? undefined : 'header'}
      style={[
        styles.heading,
        small && styles.headingSmall,
        editorial && styles.heroTitle,
        { color: colors.text },
      ]}
    >
      {children}
    </Text>
  )
  return focusOnEntry ? (
    <View
      ref={target}
      accessible
      accessibilityRole="header"
      tabIndex={Platform.OS === 'web' ? -1 : undefined}
      style={Platform.OS === 'web' ? styles.programmaticHeading : undefined}
    >
      {heading}
    </View>
  ) : (
    heading
  )
}

export function Label({ children }: { children: ReactNode }) {
  const colors = useColors()
  return (
    <Text accessibilityRole="header" style={[styles.label, { color: colors.text }]}>
      {children}
    </Text>
  )
}

export function Body({ children, muted = false, live = false }: { children: ReactNode; muted?: boolean; live?: boolean }) {
  const colors = useColors()
  return (
    <Text aria-live={live ? 'polite' : undefined} style={[styles.body, { color: muted ? colors.muted : colors.text }]}>
      {children}
    </Text>
  )
}

export function Button({
  label,
  onPress,
  icon,
  secondary = false,
  stop = false,
  disabled = false,
  busy = false,
  compact = false,
  row = false,
  hint,
  testID,
  selected,
  expanded,
  hostRef,
}: {
  label: string
  onPress(): void
  icon?: IconName
  secondary?: boolean
  stop?: boolean
  disabled?: boolean
  busy?: boolean
  compact?: boolean
  row?: boolean
  hint?: string
  testID?: string
  selected?: boolean
  expanded?: boolean
  hostRef?: Ref<View>
}) {
  const colors = useColors()
  const [focused, setFocused] = useState(false)
  const isPrimary = !secondary && !stop
  const textColor = disabled
    ? colors.muted
    : stop
      ? colors.stop
      : selected
        ? colors.ink
        : secondary
          ? colors.text
          : colors.ink
  const fill = disabled && !row
    ? colors.raised
    : stop
      ? colors.stopSurface
      : selected
        ? colors.accent
        : secondary
          ? colors.raised
          : colors.accent
  const borderColor = disabled
    ? 'transparent'
    : stop
      ? 'rgba(255, 69, 58, 0.25)'
      : selected || isPrimary
        ? 'transparent'
        : colors.border

  return (
    <Pressable
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
        styles.button,
        compact && styles.compact,
        row && styles.row,
        { backgroundColor: fill, borderColor },
        focused && { outlineColor: colors.focus, outlineStyle: 'solid', outlineWidth: 2, outlineOffset: 2 },
        pressed && styles.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator aria-hidden color={textColor} />
      ) : (
        icon && (
          <View style={row ? [styles.rowIcon, { backgroundColor: colors.accentSoft }] : undefined}>
            <Icon name={icon} size={compact ? 18 : 21} color={row ? colors.accent : textColor} />
          </View>
        )
      )}
      <Text style={[styles.buttonText, { color: textColor }, compact && styles.compactText, row && styles.rowText]}>
        {label}
      </Text>
      {row && <Icon name="chevron-forward" size={18} color={colors.muted} />}
    </Pressable>
  )
}

export function StatusCard({ title, children }: { title: string; children: ReactNode }) {
  const colors = useColors()
  return (
    <View style={[styles.card, { borderColor: colors.divider, backgroundColor: colors.panel }]}>
      <Text accessibilityRole="header" style={[styles.cardEyebrow, { color: colors.muted }]}>
        {title.toUpperCase()}
      </Text>
      {children}
    </View>
  )
}

export function TopBar({
  back,
  settings,
  settingsDisabled = false,
}: {
  back?: () => void
  settings?: () => void
  settingsDisabled?: boolean
}) {
  const colors = useColors()
  return (
    <View style={styles.topBar}>
      {back ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to NearDar"
          onPress={back}
          style={({ pressed }) => [
            styles.backPill,
            { backgroundColor: colors.panel, borderColor: colors.border },
            pressed && styles.pressed,
          ]}
        >
          <Icon name="chevron-back" size={19} color={colors.accent} />
          <Text style={[styles.backLabel, { color: colors.text }]}>NearDar</Text>
        </Pressable>
      ) : (
        <View style={styles.brand}>
          <View style={[styles.logomark, { backgroundColor: colors.accentSoft }]}>
            <Icon name="radio-outline" size={20} color={colors.accent} />
          </View>
          <Text style={[styles.wordmark, { color: colors.text }]}>NearDar</Text>
        </View>
      )}
      {settings && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Settings"
          disabled={settingsDisabled}
          onPress={settings}
          style={({ pressed }) => [
            styles.iconCircle,
            { backgroundColor: colors.panel, borderColor: colors.border },
            pressed && styles.pressed,
          ]}
        >
          <Icon name="settings-outline" size={20} color={colors.text} />
        </Pressable>
      )}
    </View>
  )
}

export function Signal({
  children,
  tone = 'quiet',
  live = false,
}: {
  children: ReactNode
  tone?: 'quiet' | 'ready' | 'attention'
  live?: boolean
}) {
  const colors = useColors()
  const color = tone === 'ready' ? colors.ready : tone === 'attention' ? colors.warning : colors.muted
  const bg = tone === 'ready' ? colors.readySurface : tone === 'attention' ? colors.warningSurface : colors.raised
  return (
    <View style={[styles.signal, { backgroundColor: bg }]}>
      <View aria-hidden style={[styles.dot, { backgroundColor: color }]} />
      <Text aria-live={live ? 'polite' : undefined} style={[styles.signalText, { color }]}>
        {children}
      </Text>
    </View>
  )
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly [T, string][]
  value: T
  onChange(value: T): void
}) {
  const colors = useColors()
  return (
    <View style={[styles.segmentTrack, { backgroundColor: colors.raised }]}>
      {options.map(([optionValue, label]) => {
        const active = optionValue === value
        return (
          <Pressable
            key={optionValue}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected: active }}
            onPress={() => onChange(optionValue)}
            style={({ pressed }) => [
              styles.segmentItem,
              active && { backgroundColor: colors.accent },
              pressed && !active && styles.pressed,
            ]}
          >
            <Text
              numberOfLines={1}
              style={[
                styles.segmentLabel,
                { color: active ? colors.ink : colors.muted },
              ]}
            >
              {label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { flexGrow: 1, paddingBottom: 32 },
  content: { width: '100%', maxWidth: 520, alignSelf: 'center', paddingHorizontal: 18, paddingTop: 12, gap: 16 },
  dock: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 18, paddingVertical: 12 },
  dockContent: { width: '100%', maxWidth: 520, alignSelf: 'center' },
  topBar: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logomark: { height: 36, width: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  wordmark: { fontSize: 22, fontWeight: '800', letterSpacing: -0.6 },
  backPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingLeft: 10,
    paddingRight: 14,
    height: 40,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  backLabel: { fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heading: { fontSize: 30, lineHeight: 36, fontWeight: '800', letterSpacing: -0.8 },
  heroTitle: { fontSize: 34, lineHeight: 39, fontWeight: '800', letterSpacing: -1.0 },
  headingSmall: { fontSize: 22, lineHeight: 28, letterSpacing: -0.4 },
  programmaticHeading: { outlineWidth: 0 },
  label: { fontSize: 17, lineHeight: 22, fontWeight: '700', letterSpacing: -0.2 },
  cardEyebrow: { fontSize: 12, lineHeight: 16, fontWeight: '700', letterSpacing: 1.1 },
  body: { fontSize: 15, lineHeight: 22 },
  button: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  compact: { minHeight: 42, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  row: { justifyContent: 'flex-start', borderWidth: 0, paddingHorizontal: 12, borderRadius: 14 },
  rowIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  rowText: { textAlign: 'left', flex: 1 },
  buttonText: { fontSize: 16, fontWeight: '700', textAlign: 'center', flexShrink: 1, letterSpacing: -0.2 },
  compactText: { fontSize: 14, fontWeight: '700' },
  pressed: { opacity: 0.78, transform: [{ scale: 0.985 }] },
  card: { padding: 18, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, gap: 12 },
  signal: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    flexShrink: 1,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  signalText: { fontSize: 13, lineHeight: 16, fontWeight: '700', letterSpacing: -0.1, flexShrink: 1 },
  segmentTrack: {
    flexDirection: 'row',
    padding: 4,
    borderRadius: 14,
    gap: 4,
  },
  segmentItem: {
    flex: 1,
    minHeight: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  segmentLabel: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: -0.1,
  },
})
