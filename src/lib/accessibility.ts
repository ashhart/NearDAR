import { AccessibilityInfo, Platform, type View } from 'react-native'

export function announce(message: string) {
  if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true })
  else if (Platform.OS !== 'web') AccessibilityInfo.announceForAccessibility(message)
}

export function focusAccessible(view: View) {
  if (Platform.OS === 'web') view.focus()
  else AccessibilityInfo.sendAccessibilityEvent(view, 'focus')
}
