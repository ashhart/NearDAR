import type { SatnavMode } from '../guidance/types'

export type IntentMobilityProfile = 'standard' | 'cane' | 'guide-dog' | 'low-vision'

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
  | { kind: 'find-door' }
  | { kind: 'crossing-assist' }
  | { kind: 'watch-bus'; busNumber?: string }
  | { kind: 'vivid-scene' }
  | { kind: 'find-object'; target: string }
  | { kind: 'emergency-share' }
  | { kind: 'emergency-call' }
  | { kind: 'toggle-torch'; enabled?: boolean }
  | { kind: 'toggle-curtain'; enabled?: boolean }
  | { kind: 'set-profile'; profile: IntentMobilityProfile }
  | { kind: 'indoor-save'; name: string }
  | { kind: 'indoor-guide'; name: string }
  | { kind: 'visual-question'; question: string }

function cleanTarget(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:the|my|a|an)\s+/i, (m) => (m.toLowerCase().startsWith('my') ? '' : m))
    .replace(/\s+(?:please|now|for me)$/i, '')
    .replace(/[?.!,]+$/g, '')
    .trim()
}

function cleanObjectTarget(raw: string): string {
  return raw
    .trim()
    .replace(/\s+(?:please|now|for me)$/i, '')
    .replace(/[?.!,]+$/g, '')
    .replace(/^(?:the|my|a|an|some)\s+/i, '')
    .trim()
}

function cleanIndoorName(raw: string): string {
  return raw
    .trim()
    .replace(/[?.!,]+$/g, '')
    .replace(/\s+(?:please|now|for me)$/i, '')
    .replace(/\s+(?:inside|indoors)$/i, '')
    .replace(/^(?:indoor\s+(?:spot|place|point|anchor|waypoint)\s+)?(?:the|my|a|an)\s+/i, '')
    .replace(/[?.!,]+$/g, '')
    .trim()
}

const KNOWN_INDOOR_TARGETS =
  /^(?:kitchen|bedroom|bathroom|toilet|restroom|washroom|living\s+room|lounge|dining\s+room|study|home\s+office|office|desk|sofa|couch|bed|fridge|refrigerator|kettle|coffee\s+machine|microwave|sink|dining\s+table|table|hallway|corridor|stairs|staircase|lift|elevator|front\s+door|back\s+door|balcony|garage|laundry(?:\s+room)?|utility\s+room|pantry|closet|wardrobe|lobby|reception|break\s+room|meeting\s+room|conference\s+room|classroom|ward|waiting\s+room|room\s+\w+)$/i

function extractBusNumber(lower: string): string | undefined {
  const patterns = [
    /\b(?:watch|look|wait|check|spot|find)\s+(?:out\s+)?for\s+(?:the\s+)?(?:bus|route|number|no\.?)\s+([a-z]{0,2}\d{1,4}[a-z]?)\b/i,
    /\b(?:watch|look|wait|check|spot|find)\s+(?:out\s+)?for\s+(?:the\s+)?([a-z]{0,2}\d{1,4}[a-z]?)\s+bus\b/i,
    /\b(?:watch|look)\s+(?:out\s+)?for\s+([a-z]{0,2}\d{1,4}[a-z]?)\b/i,
    /\bis\s+(?:the\s+)?(?:bus\s+)?([a-z]{0,2}\d{1,4}[a-z]?)(?:\s+bus)?\s+(?:coming|here|approaching)\b/i,
    /\b(?:bus|route)\s+([a-z]{0,2}\d{1,4}[a-z]?)\s+(?:watcher|watch|mode|coming|approaching)\b/i,
  ]
  for (const re of patterns) {
    const match = re.exec(lower)
    if (match?.[1]) return match[1].toUpperCase()
  }
  return undefined
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

  // 2. Calm disorientation recovery (must beat generic "help")
  if (
    /\b(?:i'?m lost|i am lost|orient me|get my bearings|lost my bearings|where am i and what|disoriented|help me orient)\b/.test(lower)
  ) {
    return { kind: 'orient-me' }
  }

  // 3. Emergency companion handoff (must beat generic "help" and "location")
  if (/\b(?:call|dial|phone|ring)\s+(?:my\s+)?(?:emergency\s+contact|trusted\s+contact|for\s+help)\b|\b(?:emergency\s+call|sos)\b/.test(lower)) {
    return { kind: 'emergency-call' }
  }
  if (
    /\b(?:share|send|text|message|sms)\s+(?:my\s+)?(?:current\s+|live\s+)?location(?:\s+to\s+(?:my\s+)?(?:emergency\s+contact|trusted\s+contact|companion|contact|family|friend))?\b|\bemergency\s+share\b/.test(lower)
  ) {
    return { kind: 'emergency-share' }
  }

  // 4. Torch & Screen Curtain hardware controls
  if (
    /\b(?:turn|switch|put)\s+on\s+(?:the\s+)?(?:torch|flashlight|light)\b|\b(?:turn|switch)\s+(?:the\s+)?(?:torch|flashlight|light)\s+on\b|\b(?:enable)\s+(?:the\s+)?(?:torch|flashlight)\b|\b(?:torch|flashlight|light)\s+on\b/.test(lower)
  ) {
    return { kind: 'toggle-torch', enabled: true }
  }
  if (
    /\b(?:turn|switch|put)\s+off\s+(?:the\s+)?(?:torch|flashlight|light)\b|\b(?:turn|switch)\s+(?:the\s+)?(?:torch|flashlight|light)\s+off\b|\b(?:disable)\s+(?:the\s+)?(?:torch|flashlight)\b|\b(?:torch|flashlight|light)\s+off\b/.test(lower)
  ) {
    return { kind: 'toggle-torch', enabled: false }
  }
  if (/\b(?:toggle)\s+(?:the\s+)?(?:torch|flashlight|light)\b|^(?:torch|flashlight)$/.test(lower)) {
    return { kind: 'toggle-torch' }
  }

  if (
    /\b(?:screen\s+curtain\s+on|(?:turn|switch|put)\s+(?:the\s+)?screen\s+curtain\s+on|(?:turn|switch|put)\s+on\s+(?:the\s+)?screen\s+curtain|enable\s+screen\s+curtain|blackout\s+(?:the\s+)?screen|black\s+out\s+(?:the\s+)?screen|screen\s+blackout|blackout\s+mode|privacy\s+screen\s+on|hide\s+(?:the\s+)?screen)\b/.test(lower)
  ) {
    return { kind: 'toggle-curtain', enabled: true }
  }
  if (
    /\b(?:screen\s+curtain\s+off|(?:turn|switch|put)\s+(?:the\s+)?screen\s+curtain\s+off|(?:turn|switch|put)\s+off\s+(?:the\s+)?screen\s+curtain|disable\s+screen\s+curtain|(?:turn|switch|put)\s+(?:the\s+)?screen\s+back\s+on|(?:turn|switch)\s+on\s+(?:the\s+)?screen|screen\s+back\s+on|privacy\s+screen\s+off|show\s+(?:the\s+)?screen)\b/.test(lower)
  ) {
    return { kind: 'toggle-curtain', enabled: false }
  }
  if (/\b(?:toggle\s+(?:the\s+)?screen\s+curtain|screen\s+curtain)\b/.test(lower)) {
    return { kind: 'toggle-curtain' }
  }

  // 5. Mobility profile switching (must precede generic mode switching)
  if (/\b(?:white\s+cane|long\s+cane|cane)\s+(?:profile|mode)\b|\b(?:use|switch\s+to|set)\s+(?:a\s+)?(?:white\s+cane|cane)\s+(?:profile|mode)\b/.test(lower)) {
    return { kind: 'set-profile', profile: 'cane' }
  }
  if (/\bguide[\s-]?dog\s+(?:profile|mode)\b|\b(?:use|switch\s+to|set)\s+(?:a\s+)?guide[\s-]?dog(?:\s+(?:profile|mode))?\b/.test(lower)) {
    return { kind: 'set-profile', profile: 'guide-dog' }
  }
  if (/\blow[\s-]?vision\s+(?:profile|mode)\b|\b(?:use|switch\s+to|set)\s+low[\s-]?vision(?:\s+(?:profile|mode))?\b/.test(lower)) {
    return { kind: 'set-profile', profile: 'low-vision' }
  }
  if (/\b(?:standard|balanced|default)\s+(?:mobility\s+)?profile\b|\b(?:use|switch\s+to|set)\s+(?:the\s+)?(?:standard|balanced|default)\s+profile\b/.test(lower)) {
    return { kind: 'set-profile', profile: 'standard' }
  }

  // 6. Guidance mode switching
  if (/\b(?:quiet mode|silent mode|haptics only|beacon only)\b/.test(lower)) {
    return { kind: 'set-mode', mode: 'quiet' }
  }
  if (/\b(?:explore mode|free roam|free-roam|lidar only)\b/.test(lower)) {
    return { kind: 'set-mode', mode: 'explore' }
  }
  if (/\b(?:satnav mode|full satnav|full guidance|voice mode|normal mode)\b/.test(lower)) {
    return { kind: 'set-mode', mode: 'satnav' }
  }

  // 7. Specialized mobility assistants (Door Finder, Crossing Assistant, Transit/Bus Watcher, Vivid Scene)
  if (
    /\b(?:door\s+finder|entrance\s+finder|find\s+(?:the\s+|an?\s+)?(?:door|entrance|way\s+in)|locate\s+(?:the\s+)?(?:door|entrance)|where(?:'s|\s+is)\s+(?:the\s+)?(?:door|entrance|way\s+in))\b/.test(lower)
  ) {
    return { kind: 'find-door' }
  }

  if (
    /\b(?:help\s+me\s+cross|crossing\s+(?:mode|assistant|assist)|pedestrian\s+crossing|find\s+(?:the\s+)?(?:crossing|pedestrian|push)\s+button|where(?:'s|\s+is)\s+(?:the\s+)?(?:crossing|pedestrian|push)\s+button)\b/.test(lower)
  ) {
    return { kind: 'crossing-assist' }
  }

  const watchedBus = extractBusNumber(lower)
  if (watchedBus) {
    return { kind: 'watch-bus', busNumber: watchedBus }
  }
  if (
    /\b(?:transit\s+(?:mode|assistant|assist)|bus\s+(?:mode|watcher|watch)|read\s+(?:the\s+)?bus(?:\s+number)?|watch\s+for\s+(?:the\s+|my\s+)?bus|what\s+bus\s+is\s+(?:that|this|coming|approaching)|which\s+bus\s+is\s+(?:that|this|coming))\b/.test(lower)
  ) {
    return { kind: 'watch-bus' }
  }

  if (
    /\b(?:vivid\s+(?:mode|scene|description)|describe\s+(?:the\s+)?(?:view|scenery|landscape)|paint\s+(?:me\s+)?(?:the\s+|a\s+)?(?:scene|view|picture)|what\s+does\s+the\s+(?:view|scenery)\s+look\s+like)\b/.test(lower)
  ) {
    return { kind: 'vivid-scene' }
  }

  // 8. Cancel / stop active route
  if (/\b(?:cancel|stop|end|clear)\s+(?:the\s+)?(?:route|navigation|directions|trip|satnav)\b/.test(lower)) {
    return { kind: 'cancel-route' }
  }

  // 9. Return / breadcrumb route
  if (/\b(?:take|guide|lead|walk|bring)\s+me\s+back\b|\breturn\s+to\s+(?:start|where i started)\b|\bback\s+to\s+(?:the\s+)?start\b/.test(lower)) {
    return { kind: 'navigate-back' }
  }

  // 10. Save offline indoor spatial waypoint (must precede outdoor GPS save-place)
  const indoorSaveMatch =
    /\b(?:save|mark|remember|bookmark)\s+(?:(?:this\s+)?(?:room|indoor(?:\s+(?:spot|place|point|anchor|waypoint|location))?)|(?:this\s+(?:spot|place|point|location)\s+(?:inside|indoors)))\s+(?:as\s+)?(.+)/i.exec(text)
  if (indoorSaveMatch?.[1]) {
    const name = cleanIndoorName(indoorSaveMatch[1])
    if (name) return { kind: 'indoor-save', name }
  }

  // 11. Save current GPS place
  const saveMatch = /\b(?:save|mark|remember|bookmark)\s+(?:this\s+(?:spot|place|location|entrance|point)|here)\s+(?:as\s+)?(.+)/i.exec(text)
  if (saveMatch?.[1]) {
    const name = cleanTarget(saveMatch[1])
    if (name) return { kind: 'save-place', name }
  }

  // 12. List saved places
  if (/\b(?:saved places|my places|bookmarked places|what places)\b/.test(lower)) {
    return { kind: 'list-places' }
  }

  // 13. Indoor waypoint guidance (explicit indoor phrasing OR recognized indoor room/spot target)
  const explicitIndoorGuideMatch =
    /\b(?:indoor\s+(?:guide|route|navigate)\s+(?:me\s+)?to|(?:take|guide|walk|lead)\s+me\s+(?:inside|indoors)\s+to)\s+(.+)/i.exec(text)
  if (explicitIndoorGuideMatch?.[1]) {
    const name = cleanIndoorName(explicitIndoorGuideMatch[1])
    if (name) return { kind: 'indoor-guide', name }
  }

  // 14. Navigate to destination (or indoor waypoint when indoor cue / room target is detected)
  const navMatch = /\b(?:take me to|navigate to|walk me to|walk to|guide me to|directions to|route to|head to|go to)\s+(.+)/i.exec(text)
  if (navMatch?.[1]) {
    const rawDest = navMatch[1]
    const indoorName = cleanIndoorName(rawDest)
    const hasIndoorCue = /\b(?:inside|indoors|indoor)\b/i.test(rawDest) || KNOWN_INDOOR_TARGETS.test(indoorName)
    if (hasIndoorCue && indoorName) {
      return { kind: 'indoor-guide', name: indoorName }
    }
    const destination = cleanTarget(rawDest)
    if (destination) return { kind: 'navigate-to', destination }
  }

  // 15. Guided Find / Expiry / Banknote check (must precede generic "help" and "read-text")
  const expiryMatch =
    /\b(?:check|read|find|what(?:'s|\s+is))\s+(?:the\s+)?(expir(?:y|ation)\s+date|use[\s-]?by\s+date|best[\s-]?before\s+date|sell[\s-]?by\s+date)\b/i.exec(lower)
  if (expiryMatch?.[1]) {
    return { kind: 'find-object', target: expiryMatch[1].replace(/\s+/g, ' ').trim() }
  }
  if (/\b(?:is\s+(?:this|it)\s+expired|when\s+does\s+(?:this|it)\s+expire)\b/.test(lower)) {
    return { kind: 'find-object', target: 'expiry date' }
  }

  if (
    /\b(?:(?:what|which)\s+(?:kind\s+of\s+)?(?:bank\s?note|paper\s+money|currency|denomination|bill|pound\s+note|dollar\s+bill|euro\s+note|note)\s+is\s+(?:this|that)|(?:identify|check)\s+(?:this|the)\s+(?:bank\s?note|currency|denomination|bill|note|money))\b/.test(lower)
  ) {
    return { kind: 'find-object', target: 'banknote' }
  }

  const findObjectMatch = /\b(?:help\s+me\s+find|find\s+me|find|locate)\s+(.+)/i.exec(text)
  if (findObjectMatch?.[1]) {
    const target = cleanObjectTarget(findObjectMatch[1])
    if (target) return { kind: 'find-object', target }
  }

  // 16. Voice commands / general help
  if (/\b(?:what can i say|what can i ask|help me use|voice commands|help)\b/.test(lower) && lower.length < 40) {
    return { kind: 'help' }
  }

  // 17. Route progress / status
  if (/\b(?:how far|how much further|how long|next turn|what(?:'s| is) the next|where am i going|route status|remaining distance)\b/.test(lower)) {
    return { kind: 'route-status' }
  }

  // 18. Location & compass heading
  if (/\b(?:where am i|what street|my location|current address|current location)\b/.test(lower)) {
    return { kind: 'location' }
  }
  if (/\b(?:which way am i facing|what direction am i facing|my heading|compass)\b/.test(lower)) {
    return { kind: 'heading' }
  }

  // 19. Read visible text / signs
  if (/\b(?:read|what does (?:that|this|the) (?:sign|label|menu|notice|text) say|read (?:this|that|the sign|aloud))\b/.test(lower)) {
    return { kind: 'read-text' }
  }

  // 20. Quick LiDAR corridor clearance check
  if (/\b(?:which way is open|is (?:the )?path clear|is it clear ahead|corridor|how much space|clear ahead)\b/.test(lower)) {
    return { kind: 'corridor-check' }
  }

  // 21. Everything else -> grounded conversational on-device vision Q&A
  return { kind: 'visual-question', question: text }
}
