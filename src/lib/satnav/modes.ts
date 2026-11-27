import type { Direction, DirectionStyle, SceneSnapshot } from '../guidance/types'
import { formatWalkingDistance } from '../navigation/geo'
import type { RouteProgress } from '../navigation/tracker'
import { formatDirectionLabel } from './arbitrator'
import {
  buildTelemetryContextLines,
  DARK_LIGHTING_TELEMETRY_NOTE,
  resolveLightingState,
  sanitizeSpokenVisionOutput,
  type ConversationTurn,
  type LightingState,
  type MobilityProfile,
  type VisionPromptContext,
} from './prompts'

export type ActiveMobilitySkill = 'none' | 'door-finder' | 'crossing' | 'transit' | 'vivid' | 'find-object'

export type FindObjectCategory = 'expiry' | 'banknote' | 'reading' | 'item'

export interface SkillPromptContext extends Omit<VisionPromptContext, 'history'> {
  history?: ConversationTurn[]
  lightingState?: LightingState
  mobilityProfile?: MobilityProfile
}

export interface MobilitySkillPrompt {
  skill: Exclude<ActiveMobilitySkill, 'none'>
  system: string
  prompt: string
  /** Combined single-string prompt for backends without a separate system message channel. */
  combined: string
  maxImageTokens: number
  maxTokens: number
  temperature: number
}

export interface MobilitySkillMeta {
  id: Exclude<ActiveMobilitySkill, 'none'>
  label: string
  shortLabel: string
  description: string
}

export const MOBILITY_SKILLS: Record<Exclude<ActiveMobilitySkill, 'none'>, MobilitySkillMeta> = {
  'door-finder': {
    id: 'door-finder',
    label: 'Door Finder',
    shortLabel: 'Door',
    description: 'Locate the entrance door, handle side, door type, and entrance steps in the last 25 metres.',
  },
  crossing: {
    id: 'crossing',
    label: 'Crossing Assistant',
    shortLabel: 'Crossing',
    description: 'Describe tactile paving, dropped kerbs, push-button poles, crossing layout, and visible traffic.',
  },
  transit: {
    id: 'transit',
    label: 'Transit & Bus Watcher',
    shortLabel: 'Transit',
    description: 'Spot approaching bus numbers, boarding doors, platform edges, departure boards, and open seats.',
  },
  vivid: {
    id: 'vivid',
    label: 'Vivid Scene',
    shortLabel: 'Vivid',
    description: 'Paint the scene in 3 to 4 warm, evocative sentences for parks, travel, and cafes.',
  },
  'find-object': {
    id: 'find-object',
    label: 'Guided Find',
    shortLabel: 'Find',
    description: 'Locate an item on a shelf, read an expiry date, identify a banknote, or read a menu or letter.',
  },
}

function directionHint(style: DirectionStyle = 'natural'): string {
  return style === 'clock'
    ? 'Use clock-face directions (12 o\'clock straight ahead, 11 o\'clock ahead-left, 1 o\'clock ahead-right, 9 o\'clock left, 3 o\'clock right).'
    : 'Use clear natural directions (ahead, ahead left, ahead right, to your left, to your right).'
}

function toFullContext(ctx: SkillPromptContext): VisionPromptContext {
  return {
    ...ctx,
    history: ctx.history ?? [],
  }
}

function buildCombined(system: string, prompt: string): string {
  return `${system}\n\n${prompt}\nSpoken reply:`
}

// ---------------------------------------------------------------------------
// 1. Door Finder (Last 20 Metres Entrance Finder)
// ---------------------------------------------------------------------------

/** Suggests activating Door Finder when walking within the last 2..25 metres of an active destination. */
export function shouldAutoSuggestDoorFinder(
  route?: RouteProgress,
  snapshot?: SceneSnapshot,
): boolean {
  if (!route?.active || route.arrived) return false
  if (!Number.isFinite(route.remainingDistanceMeters)) return false
  if (route.remainingDistanceMeters > 25 || route.remainingDistanceMeters < 2) return false
  if (snapshot?.aimState === 'lowered' || snapshot?.aimState === 'covered') return false
  return true
}

export function formatDoorFinderSuggestion(
  destinationName: string,
  remainingDistanceMeters: number,
  stepLengthMeters?: number,
): string {
  const name = destinationName.trim() || 'your destination'
  const dist = formatWalkingDistance(remainingDistanceMeters, stepLengthMeters)
  return `Approaching ${name} in ${dist}. Say find the door when you want entrance details.`
}

export interface DoorTelemetrySummary {
  opening?: {
    direction: string
    distanceMeters: number
    widthDegrees: number
  }
  doorMesh?: {
    label: string
    direction: string
    distanceMeters: number
  }
  shopfrontText: string[]
}

export function extractDoorTelemetry(
  snapshot?: SceneSnapshot,
  directionStyle: DirectionStyle = 'natural',
): DoorTelemetrySummary {
  const openings = (snapshot?.corridor?.openings ?? [])
    .filter((op) => Number.isFinite(op.distanceMeters) && op.distanceMeters <= 10)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
  const bestOpening = openings[0]

  const doorObjects = (snapshot?.objects ?? [])
    .filter((o) => /\bdoor(?:way)?\b/i.test(o.label) && o.distanceMeters !== undefined && Number.isFinite(o.distanceMeters))
    .sort((a, b) => (a.distanceMeters ?? 99) - (b.distanceMeters ?? 99))
  const bestDoor = doorObjects[0]

  const shopfrontText = (snapshot?.recognizedText ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8)

  return {
    opening: bestOpening
      ? {
          direction: formatDirectionLabel(bestOpening.direction, directionStyle, bestOpening.bearingDegrees),
          distanceMeters: bestOpening.distanceMeters,
          widthDegrees: bestOpening.widthDegrees,
        }
      : undefined,
    doorMesh: bestDoor
      ? {
          label: bestDoor.label,
          direction: formatDirectionLabel(bestDoor.direction, directionStyle, undefined, bestDoor.clockSector),
          distanceMeters: bestDoor.distanceMeters!,
        }
      : undefined,
    shopfrontText,
  }
}

/** Deterministic fallback when VLM is unavailable during Door Finder mode. */
export function formatDoorTelemetryFallback(
  destinationName?: string,
  snapshot?: SceneSnapshot,
  directionStyle: DirectionStyle = 'natural',
  stepLengthMeters?: number,
): string {
  const info = extractDoorTelemetry(snapshot, directionStyle)
  const parts: string[] = []
  if (info.doorMesh) {
    parts.push(
      `Door detected ${info.doorMesh.direction}, ${formatWalkingDistance(info.doorMesh.distanceMeters, stepLengthMeters)}.`,
    )
  } else if (info.opening) {
    parts.push(
      `Entrance opening ${info.opening.direction}, ${formatWalkingDistance(info.opening.distanceMeters, stepLengthMeters)}.`,
    )
  } else {
    const dest = destinationName?.trim()
    parts.push(
      dest
        ? `No clear doorway measured for ${dest} yet. Slowly pan toward the shopfront.`
        : 'No clear doorway measured yet. Slowly pan along the wall or shopfront.',
    )
  }
  if (info.shopfrontText.length > 0) {
    parts.push(`Visible sign text: ${info.shopfrontText.slice(0, 4).join(', ')}.`)
  }
  return parts.join(' ')
}

export function buildDoorFinderPrompt(
  destinationName?: string,
  ctx: SkillPromptContext = {},
): MobilitySkillPrompt {
  const style = ctx.directionStyle ?? 'natural'
  const fullCtx = toFullContext(ctx)
  const telemetry = buildTelemetryContextLines(fullCtx)
  const doorInfo = extractDoorTelemetry(ctx.snapshot, style)

  const doorFusions: string[] = []
  if (doorInfo.opening) {
    doorFusions.push(
      `LiDAR opening ${doorInfo.opening.direction} at ${doorInfo.opening.distanceMeters.toFixed(1)}m (width ~${Math.round(doorInfo.opening.widthDegrees)} deg).`,
    )
  }
  if (doorInfo.doorMesh) {
    doorFusions.push(
      `ARKit door mesh ${doorInfo.doorMesh.direction} at ${doorInfo.doorMesh.distanceMeters.toFixed(1)}m.`,
    )
  }
  if (doorInfo.shopfrontText.length > 0) {
    doorFusions.push(`Shopfront OCR text: "${doorInfo.shopfrontText.join(' | ').slice(0, 200)}".`)
  }

  const target = destinationName?.trim() || ctx.route?.route.destinationName?.trim()
  const targetPhrase = target ? `the entrance to ${target}` : 'the nearest building or shop entrance'

  const system =
    'You are NearDar Door Finder, helping a blind or visually impaired pedestrian locate an exact entrance in the last 20 metres. ' +
    'Answer in 1 to 2 crisp, practical spoken sentences. ' +
    `${directionHint(style)} ` +
    'State only details clearly grounded in the camera view, LiDAR openings, ARKit door mesh, and visible signage. ' +
    'Be honest if the door or handle is not yet visible.'

  const sensorLines = [...telemetry, ...doorFusions]
  const sensorBlock = sensorLines.length > 0 ? `Live entrance telemetry: ${sensorLines.join(' ')}\n` : ''
  const prompt =
    `${sensorBlock}` +
    `Task: Help locate ${targetPhrase}. ` +
    'Specifically report: (1) door direction and distance, (2) whether it is a push, pull, automatic sliding, or revolving door, ' +
    '(3) which side the handle or push plate is on, and (4) any entrance steps, raised threshold, or signage confirming the shopfront.'

  return {
    skill: 'door-finder',
    system,
    prompt,
    combined: buildCombined(system, prompt),
    maxImageTokens: 192,
    maxTokens: 120,
    temperature: 0.15,
  }
}

// ---------------------------------------------------------------------------
// 2. Pedestrian Crossing Assistant
// ---------------------------------------------------------------------------

const CROSSING_UNSAFE_PHRASES =
  /\b(you can cross(?: now)?|cross now|go cross|ready to cross|proceed across|step into the (?:road|street)|now is a good time to cross)\b/gi

/** Extra-strict safety sanitizer for Crossing Assistant replies. */
export function sanitizeCrossingOutput(raw: string): string {
  const base = sanitizeSpokenVisionOutput(raw)
  return base
    .replace(CROSSING_UNSAFE_PHRASES, 'still listen carefully and check traffic with your mobility aid before deciding when to cross')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildCrossingAssistantPrompt(ctx: SkillPromptContext = {}): MobilitySkillPrompt {
  const style = ctx.directionStyle ?? 'natural'
  const fullCtx = toFullContext(ctx)
  const telemetry = buildTelemetryContextLines(fullCtx)
  const lighting = resolveLightingState(ctx.lightingState, ctx.snapshot)
  if (lighting === 'dark' && !telemetry.includes(DARK_LIGHTING_TELEMETRY_NOTE)) {
    telemetry.push(DARK_LIGHTING_TELEMETRY_NOTE)
  }

  const system =
    'You are NearDar Crossing Assistant, helping a blind pedestrian understand the layout of a kerb or road crossing. ' +
    'Respond in 2 to 3 short, calm spoken sentences. ' +
    `${directionHint(style)} ` +
    'CRITICAL SAFETY RULE: NEVER claim a road or crossing is safe to cross, clear to cross, or tell the user to cross or step into the street. ' +
    'Report only what is clearly visible and stay honest when signals or oncoming vehicles are unclear or outside the frame.'

  const sensorBlock = telemetry.length > 0 ? `Live street telemetry: ${telemetry.join(' ')}\n` : ''
  const prompt =
    `${sensorBlock}` +
    'Task: Describe this pedestrian crossing layout concisely. Specifically check for: ' +
    '(1) tactile paving under or ahead of the user, ' +
    '(2) dropped kerb edge or step-down distance and alignment, ' +
    '(3) pedestrian push-button box pole direction and distance, ' +
    '(4) zebra, pelican, or signalized crossing markings and any central island, ' +
    '(5) traffic signal or pedestrian light indicator ONLY if clearly visible, and ' +
    '(6) any approaching cyclists, e-scooters, or cars visible in frame. ' +
    'Never say it is safe to cross.'

  return {
    skill: 'crossing',
    system,
    prompt,
    combined: buildCombined(system, prompt),
    maxImageTokens: 224,
    maxTokens: 135,
    temperature: 0.1,
  }
}

// ---------------------------------------------------------------------------
// 3. Public Transit & Bus Number Watcher
// ---------------------------------------------------------------------------

/** Normalizes a spoken or typed bus route number ("bus 73", "route n73", "X12") -> "73", "N73", "X12". */
export function normalizeBusNumber(raw: string): string {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/^(?:BUS|ROUTE|NUMBER|NO\.?|LINE|SERVICE|THE|#)\s+/i, '')
    .replace(/\s+(?:BUS|ROUTE|LINE|PLEASE)$/i, '')
    .replace(/^#/, '')
    .replace(/\s+/g, '')
  return /^[A-Z]{0,2}\d{1,4}[A-Z]?$/.test(cleaned) ? cleaned : ''
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const CURRENCY_PREFIX_RE = /(?:£|\$|€|¥|₹|GBP|USD|EUR)\s*$/i
const PHONE_PREFIX_RE = /(?:tel|phone|call|mob|mobile|fax)\s*[:.#-]?\s*$/i
const EST_PREFIX_RE = /\b(?:est\.?|since|circa|founded|copyright|©)\s*$/i
const LEADING_PHONE_AREA_RE = /(?:^|\s)0\d{2,4}[\s-]*$/
const UNIT_SUFFIX_RE =
  /^\s*(?:ml|cl|dl|kg|mg|oz|lb|lbs|cm|mm|km|ft|yd|yds|mph|kph|km\/h|kcal|cal|kj|pence|cents?|gbp|usd|eur|deg|degrees|mins?|hrs?|secs?|am|pm|%|°)\b/i
const DECIMAL_OR_TIME_BEFORE_RE = /[.:£$€¥₹+]\s*$/
const DECIMAL_OR_TIME_AFTER_RE = /^[.:%°]/
const PHONE_DASH_AFTER_RE = /^\s*-\s*\d{3,}/

/**
 * Instant zero-VLM OCR matcher for watched bus numbers ("73", "N73", "X12").
 * Rejects false positives inside prices ("£7.30", "£73"), years ("1973"),
 * volumes/units ("730ml", "73 ml"), decimals ("7.30", "73.5"), times ("7:30"),
 * and phone/long digit strings ("0731234").
 */
export function matchWatchedBusNumber(
  recognizedText: string[],
  targetBus: string,
): string | undefined {
  const target = normalizeBusNumber(targetBus)
  if (!target || recognizedText.length === 0) return undefined

  const pattern = new RegExp(escapeRegex(target), 'gi')
  let bestMatch: { text: string; score: number } | undefined

  for (const rawLine of recognizedText) {
    const line = rawLine.replace(/\s+/g, ' ').trim()
    if (!line) continue

    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(line)) !== null) {
      const start = match.index
      const end = start + match[0].length
      const charBefore = start > 0 ? line[start - 1]! : ''
      const charAfter = end < line.length ? line[end]! : ''

      // Strict alphanumeric boundary: rejects "1973", "730ml", "0731234", "N73" (when looking for "73"), "73A", "73p", "73rd"
      if (charBefore && /[A-Za-z0-9]/.test(charBefore)) continue
      if (charAfter && /[A-Za-z0-9]/.test(charAfter)) continue

      const prefix = line.slice(0, start)
      const suffix = line.slice(end)

      // Reject currency, decimal, time, phone, year/est, and measurement-unit contexts
      if (DECIMAL_OR_TIME_BEFORE_RE.test(prefix)) continue
      if (DECIMAL_OR_TIME_AFTER_RE.test(suffix)) continue
      if (CURRENCY_PREFIX_RE.test(prefix)) continue
      if (PHONE_PREFIX_RE.test(prefix)) continue
      if (EST_PREFIX_RE.test(prefix)) continue
      if (LEADING_PHONE_AREA_RE.test(prefix)) continue
      if (UNIT_SUFFIX_RE.test(suffix)) continue
      if (PHONE_DASH_AFTER_RE.test(suffix)) continue
      // Reject standalone short metric/currency tokens separated by a single space after digits (e.g. "73 p", "73 g")
      if (/^\s+(?:p|g|m|l)(?:\b|$)/i.test(suffix) && !/\b(?:bus|route|no\.?|stop|stand)\b/i.test(prefix)) continue

      let score = 1
      if (line.toUpperCase() === target) score = 3
      else if (start === 0 || /\b(?:bus|route|no\.?|service)\s*$/i.test(prefix)) score = 2

      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { text: line, score }
      }
      break
    }
  }

  return bestMatch?.text
}

export function formatBusMatchAnnouncement(
  targetBus: string,
  matchedText: string,
  direction?: Direction,
  directionStyle: DirectionStyle = 'natural',
): string {
  const normalized = normalizeBusNumber(targetBus) || targetBus.trim()
  const dir = direction && direction !== 'unknown'
    ? ` ${formatDirectionLabel(direction, directionStyle)}`
    : ''
  const cleanedMatch = matchedText.trim()
  if (cleanedMatch.toUpperCase() === normalized.toUpperCase()) {
    return `Bus ${normalized} spotted${dir}.`
  }
  return `Bus ${normalized} spotted${dir}: ${cleanedMatch}.`
}

export function buildTransitPrompt(
  targetBus?: string,
  ctx: SkillPromptContext = {},
): MobilitySkillPrompt {
  const style = ctx.directionStyle ?? 'natural'
  const fullCtx = toFullContext(ctx)
  const telemetry = buildTelemetryContextLines(fullCtx)
  const normalized = targetBus ? normalizeBusNumber(targetBus) || targetBus.trim() : ''

  const freeSeats = ctx.snapshot?.freeSeats ?? []
  if (freeSeats.length > 0) {
    const seatDesc = freeSeats
      .slice(0, 2)
      .map((s) => `${formatDirectionLabel(s.direction, style, undefined, s.clockSector)}${s.distanceMeters !== undefined ? ` ${s.distanceMeters.toFixed(1)}m` : ''}`)
      .join(', ')
    telemetry.push(`Detected open seats: ${seatDesc}.`)
  }

  const system =
    'You are NearDar Transit Assistant, helping a blind passenger navigate buses, bus stops, train platforms, and carriages. ' +
    'Answer in 1 to 2 crisp, accurate spoken sentences. ' +
    `${directionHint(style)} ` +
    'Read route numbers and departure displays faithfully without guessing blurry digits, and never tell the user to step across a platform edge or road.'

  const sensorBlock = telemetry.length > 0 ? `Live transit telemetry: ${telemetry.join(' ')}\n` : ''
  const busGoal = normalized
    ? `The passenger is watching for bus ${normalized}. Confirm whether bus ${normalized} or another route number is approaching, and report the bus door position.`
    : 'Check for any approaching bus number and boarding door position.'

  const prompt =
    `${sensorBlock}` +
    `Task: ${busGoal} ` +
    'Also report any visible train platform edge or yellow tactile line, departure board or timetable text, or carriage doors and open seats.'

  return {
    skill: 'transit',
    system,
    prompt,
    combined: buildCombined(system, prompt),
    maxImageTokens: 224,
    maxTokens: 120,
    temperature: 0.1,
  }
}

// ---------------------------------------------------------------------------
// 4. Vivid Scene ("Describe the view" / "Paint me the scene")
// ---------------------------------------------------------------------------

export function buildVividScenePrompt(ctx: SkillPromptContext = {}): MobilitySkillPrompt {
  const style = ctx.directionStyle ?? 'natural'
  const fullCtx = toFullContext(ctx)
  const telemetry = buildTelemetryContextLines(fullCtx)
  const lighting = resolveLightingState(ctx.lightingState, ctx.snapshot)
  if (lighting === 'dark' && !telemetry.includes(DARK_LIGHTING_TELEMETRY_NOTE)) {
    telemetry.push(DARK_LIGHTING_TELEMETRY_NOTE)
  }

  const system =
    'You are NearDar in Vivid Scene mode, painting a rich, warm, evocative spoken picture of the surroundings for a blind or visually impaired companion. ' +
    'Write 3 to 4 flowing, natural spoken sentences describing scenery, architecture, greenery, sky and lighting, colours, atmosphere, and people — ideal for parks, travel, cafes, and social moments. ' +
    `${directionHint(style)} ` +
    'Stay grounded in what is truly visible, never invent unseen landmarks, and never claim a road is safe to cross.'

  const sensorBlock = telemetry.length > 0 ? `Live scene context: ${telemetry.join(' ')}\n` : ''
  const prompt =
    `${sensorBlock}` +
    'Task: Paint this view warmly in 3 to 4 vivid spoken sentences. ' +
    'Describe the foreground and background, architecture or greenery, light and colours, atmosphere, and what people around are doing.'

  return {
    skill: 'vivid',
    system,
    prompt,
    combined: buildCombined(system, prompt),
    maxImageTokens: 256,
    maxTokens: 240,
    temperature: 0.45,
  }
}

// ---------------------------------------------------------------------------
// 5. Guided Find / Label / Banknote / Expiry Check
// ---------------------------------------------------------------------------

export function classifyFindObjectTask(targetItem: string): FindObjectCategory {
  const lower = targetItem.toLowerCase()
  if (/\b(?:expir(?:y|ation|e|ed)|use[\s-]?by|best[\s-]?before|sell[\s-]?by|date on)\b/.test(lower)) {
    return 'expiry'
  }
  if (/\b(?:bank\s?note|currency|denomination|paper money|cash|coin|pound note|dollar bill|euro note|bill)\b/.test(lower)) {
    return 'banknote'
  }
  if (/\b(?:menu|letter|mail|receipt|label|ingredients|nutrition|instructions|prescription|medicine|dosage|leaflet|post|bill statement)\b/.test(lower)) {
    return 'reading'
  }
  return 'item'
}

export function buildFindObjectPrompt(
  targetItem: string,
  ctx: SkillPromptContext = {},
): MobilitySkillPrompt {
  const style = ctx.directionStyle ?? 'natural'
  const fullCtx = toFullContext(ctx)
  const telemetry = buildTelemetryContextLines(fullCtx)
  const cleanedTarget = targetItem.trim() || 'the requested item'
  const category = classifyFindObjectTask(cleanedTarget)

  const system =
    'You are NearDar Guided Find, a helpful everyday companion for a blind or visually impaired person checking shelves, product labels, expiry dates, banknotes, menus, or letters. ' +
    'Respond in 1 to 3 clear, practical spoken sentences grounded in the live camera image and OCR text. ' +
    `${directionHint(style)} ` +
    'Never guess unreadable text, dates, or currency denominations—say clearly how to move, rotate, or steady the item if needed.'

  const sensorBlock = telemetry.length > 0 ? `Live camera & OCR telemetry: ${telemetry.join(' ')}\n` : ''

  let instruction: string
  if (category === 'expiry') {
    instruction =
      `Task: Check the expiry, best-before, or use-by date (${cleanedTarget}). ` +
      'Read the exact date from the label or OCR if clearly visible; if out of focus, angled away, or not visible, tell the user gently how to adjust or turn the packaging.'
  } else if (category === 'banknote') {
    instruction =
      `Task: Identify the currency and banknote denomination (${cleanedTarget}). ` +
      'Verify large numerals, colour, and currency markings carefully; if folded, shadowed, or ambiguous, say so honestly rather than guessing.'
  } else if (category === 'reading') {
    instruction =
      `Task: Read and summarize the requested text (${cleanedTarget}) using the camera image and OCR. ` +
      'Prioritize key headings, names, prices, ingredients, or action items cleanly without reciting clutter.'
  } else {
    instruction =
      `Task: Help locate "${cleanedTarget}" in the scene (for example on a shelf, counter, or table). ` +
      'Give exact position (left/center/right, upper/middle/lower shelf, and distance or arm\'s reach if known), verify packaging text with OCR, or suggest which way to pan if not yet in frame.'
  }

  return {
    skill: 'find-object',
    system,
    prompt: `${sensorBlock}${instruction}`,
    combined: buildCombined(system, `${sensorBlock}${instruction}`),
    maxImageTokens: 224,
    maxTokens: 150,
    temperature: 0.15,
  }
}

// ---------------------------------------------------------------------------
// Unified skill dispatch & output formatting
// ---------------------------------------------------------------------------

export function buildMobilitySkillPrompt(
  skill: Exclude<ActiveMobilitySkill, 'none'>,
  ctx: SkillPromptContext = {},
  target?: string,
): MobilitySkillPrompt {
  switch (skill) {
    case 'door-finder':
      return buildDoorFinderPrompt(target, ctx)
    case 'crossing':
      return buildCrossingAssistantPrompt(ctx)
    case 'transit':
      return buildTransitPrompt(target, ctx)
    case 'vivid':
      return buildVividScenePrompt(ctx)
    case 'find-object':
      return buildFindObjectPrompt(target ?? 'item', ctx)
  }
}

export function formatMobilitySkillOutput(
  skill: Exclude<ActiveMobilitySkill, 'none'>,
  rawOutput: string,
): string {
  if (skill === 'crossing') {
    return sanitizeCrossingOutput(rawOutput)
  }
  return sanitizeSpokenVisionOutput(rawOutput)
}
