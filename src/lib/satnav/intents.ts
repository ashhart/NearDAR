import type { SatnavMode } from '../guidance/types'

export type SatnavIntent =
  | { kind: 'navigate-to'; destination: string }
  | { kind: 'navigate-back' }
  | { kind: 'save-place'; name: string }
  | { kind: 'list-places' }
  | { kind: 'cancel-route' }
  | { kind: 'route-status' }
  | { kind: 'orient-me' }
  | { kind: 'location' }
  | { kind: 'heading' }
  | { kind: 'set-mode'; mode: SatnavMode }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'stop-speech' }
  | { kind: 'repeat' }
  | { kind: 'help' }
  | { kind: 'read-text' }
  | { kind: 'corridor-check' }
  | { kind: 'visual-question'; question: string }

function cleanTarget(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:the|my|a|an)\s+/i, (m) => (m.toLowerCase().startsWith('my') ? '' : m))
    .replace(/\s+(?:please|now|for me)$/i, '')
    .replace(/[?.!,]+$/g, '')
    .trim()
}

export function parseSatnavIntent(raw: string): SatnavIntent {
  const text = raw.trim()
  const lower = text.toLowerCase().replace(/[’']/g, "'")

  if (!text) return { kind: 'visual-question', question: 'Describe what is ahead of me.' }

  // 1. Speech & session control
  if (/^(?:stop talking|quiet|silence|mute|be quiet|shh|cancel speech)$/.test(lower)) {
    return { kind: 'stop-speech' }
  }
  if (/^(?:pause|pause guidance|pause navigation|stop camera|stop scanning)$/.test(lower)) {
    return { kind: 'pause' }
  }
  if (/^(?:resume|resume guidance|start guidance|continue|unpause|start camera)$/.test(lower)) {
    return { kind: 'resume' }
  }
  if (/^(?:repeat|say that again|what did you say|pardon|again)$/.test(lower)) {
    return { kind: 'repeat' }
  }
  // Calm disorientation recovery must beat generic "help" so "Help, I'm lost" or "Help me get my bearings" orients immediately.
  if (
    /\b(?:i'?m lost|i am lost|orient me|get my bearings|lost my bearings|where am i and what|disoriented|help me orient)\b/.test(lower)
  ) {
    return { kind: 'orient-me' }
  }
  if (/\b(?:what can i say|what can i ask|help me use|voice commands|help)\b/.test(lower) && lower.length < 40) {
    return { kind: 'help' }
  }

  // 2. Guidance mode switching
  if (/\b(?:quiet mode|silent mode|haptics only|beacon only)\b/.test(lower)) {
    return { kind: 'set-mode', mode: 'quiet' }
  }
  if (/\b(?:explore mode|free roam|free-roam|lidar only)\b/.test(lower)) {
    return { kind: 'set-mode', mode: 'explore' }
  }
  if (/\b(?:satnav mode|full satnav|full guidance|voice mode|normal mode)\b/.test(lower)) {
    return { kind: 'set-mode', mode: 'satnav' }
  }

  // 3. Cancel / stop active route
  if (/\b(?:cancel|stop|end|clear)\s+(?:the\s+)?(?:route|navigation|directions|trip|satnav)\b/.test(lower)) {
    return { kind: 'cancel-route' }
  }

  // 4. Return / breadcrumb route
  if (/\b(?:take|guide|lead|walk|bring)\s+me\s+back\b|\breturn\s+to\s+(?:start|where i started)\b|\bback\s+to\s+(?:the\s+)?start\b/.test(lower)) {
    return { kind: 'navigate-back' }
  }

  // 5. Save current place
  const saveMatch = /\b(?:save|mark|remember|bookmark)\s+(?:this\s+(?:spot|place|location|entrance|point)|here)\s+(?:as\s+)?(.+)/i.exec(text)
  if (saveMatch?.[1]) {
    const name = cleanTarget(saveMatch[1])
    if (name) return { kind: 'save-place', name }
  }

  // 6. List saved places
  if (/\b(?:saved places|my places|bookmarked places|what places)\b/.test(lower)) {
    return { kind: 'list-places' }
  }

  // 7. Navigate to destination
  const navMatch = /\b(?:take me to|navigate to|walk me to|walk to|guide me to|directions to|route to|head to|go to)\s+(.+)/i.exec(text)
  if (navMatch?.[1]) {
    const destination = cleanTarget(navMatch[1])
    if (destination) return { kind: 'navigate-to', destination }
  }

  // 8. Route progress / status
  if (/\b(?:how far|how much further|how long|next turn|what(?:'s| is) the next|where am i going|route status|remaining distance)\b/.test(lower)) {
    return { kind: 'route-status' }
  }

  // 9. Location & compass heading
  if (/\b(?:where am i|what street|my location|current address|current location)\b/.test(lower)) {
    return { kind: 'location' }
  }
  if (/\b(?:which way am i facing|what direction am i facing|my heading|compass)\b/.test(lower)) {
    return { kind: 'heading' }
  }

  // 10. Read visible text / signs
  if (/\b(?:read|what does (?:that|this|the) (?:sign|label|menu|notice|text) say|read (?:this|that|the sign|aloud))\b/.test(lower)) {
    return { kind: 'read-text' }
  }

  // 11. Quick LiDAR corridor clearance check
  if (/\b(?:which way is open|is (?:the )?path clear|is it clear ahead|corridor|how much space|clear ahead)\b/.test(lower)) {
    return { kind: 'corridor-check' }
  }

  // 12. Everything else -> grounded conversational on-device vision Q&A
  return { kind: 'visual-question', question: text }
}
