import type { DirectionStyle, SceneSnapshot } from '../guidance/types'
import type { RouteProgress } from '../navigation/tracker'
import { cardinalDirection, formatWalkingDistance, turnPhraseFromOffset } from '../navigation/geo'
import { formatDirectionLabel } from './arbitrator'

export interface ConversationTurn {
  role: 'user' | 'assistant'
  text: string
  at: number
}

export interface VisionPromptContext {
  snapshot?: SceneSnapshot
  route?: RouteProgress
  headingDeg?: number
  stepLengthMeters?: number
  directionStyle?: DirectionStyle
  history: ConversationTurn[]
}

const UNSAFE_GUARANTEE = /\b(it is safe to cross|safe to cross|clear to cross|you can safely cross|guaranteed clear|completely safe to walk|100% clear|go ahead and cross)\b/gi

/** Keeps rich natural descriptions while softening reckless traffic/crossing guarantees. */
export function sanitizeSpokenVisionOutput(raw: string): string {
  const cleaned = raw
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^["']|["']$/g, '')
    .replace(UNSAFE_GUARANTEE, 'visually clear from the camera—still listen and check with your mobility aid')
    .trim()
  return cleaned
}

export const SATNAV_SYSTEM_PROMPT =
  'You are NearDar, a calm, concise walking satnav speaking aloud to a blind or visually impaired person. ' +
  'Answer in 1 to 2 short, clear spoken sentences grounded in the live camera image and phone sensor telemetry. ' +
  'Prioritize real-world mobility details: people, dogs or animals, cyclists or pushbikes, roadworks or barriers, kerbs, steps, doorways, and signs. ' +
  'Use clear directions (ahead, ahead left, ahead right, or clock-face when requested) and measured distances when supplied. ' +
  'Never claim a road or crossing is safe to cross, and be honest when something is unclear.'

export function buildSatnavSystemPrompt(directionStyle: DirectionStyle = 'natural'): string {
  if (directionStyle === 'clock') {
    return (
      `${SATNAV_SYSTEM_PROMPT} ` +
      'The user prefers clock-face directions (12 o\'clock for straight ahead, 11 o\'clock ahead-left, 1 o\'clock ahead-right, 9 o\'clock left, 3 o\'clock right).'
    )
  }
  return SATNAV_SYSTEM_PROMPT
}

/** Builds the compact user prompt with live LiDAR, OCR, heading, route, and recent turn context. */
export function buildSatnavUserPrompt(question: string, ctx: VisionPromptContext): string {
  const telemetry: string[] = []
  const style = ctx.directionStyle ?? 'natural'

  if (ctx.headingDeg !== undefined && Number.isFinite(ctx.headingDeg)) {
    telemetry.push(`Facing ${cardinalDirection(ctx.headingDeg)} (${Math.round(ctx.headingDeg)} deg).`)
  }

  if (ctx.route?.active) {
    const rem = formatWalkingDistance(ctx.route.remainingDistanceMeters, ctx.stepLengthMeters)
    const offset = ctx.route.headingOffsetDeg !== undefined ? `, ${turnPhraseFromOffset(ctx.route.headingOffsetDeg)}` : ''
    telemetry.push(`Satnav route to ${ctx.route.route.destinationName} (${rem} left${offset}): ${ctx.route.currentStep.instruction}.`)
  }

  const corridor = ctx.snapshot?.corridor
  if (corridor?.valid) {
    const dir = corridor.recommendedHeadingOffsetDeg <= -15
      ? 'open space left'
      : corridor.recommendedHeadingOffsetDeg >= 15
        ? 'open space right'
        : 'center open'
    telemetry.push(
      `LiDAR: path ${corridor.corridorState}, ahead clearance ${corridor.forwardClearanceMeters.toFixed(1)}m (${dir}).`,
    )
    if (corridor.openings && corridor.openings.length > 0) {
      const op = corridor.openings[0]!
      telemetry.push(`Passage opening ${formatDirectionLabel(op.direction, style, op.bearingDegrees)} at ${op.distanceMeters.toFixed(1)}m.`)
    }
  }

  const hazards = ctx.snapshot?.hazards ?? []
  if (hazards.length > 0) {
    const top = hazards
      .slice(0, 2)
      .map((h) => `${h.kind} ${formatDirectionLabel(h.direction, style, h.bearingDegrees)} at ${h.distanceMeters.toFixed(1)}m`)
      .join('; ')
    telemetry.push(`Measured hazards: ${top}.`)
  }

  const meshObjects = (ctx.snapshot?.objects ?? [])
    .filter((o) => o.label !== 'obstacle' && o.distanceMeters !== undefined)
    .sort((a, b) => (a.distanceMeters ?? 99) - (b.distanceMeters ?? 99))
    .slice(0, 5)
  if (meshObjects.length > 0) {
    const list = meshObjects
      .map((o) => `${o.label} ${formatDirectionLabel(o.direction, style, undefined, o.clockSector)} ${o.distanceMeters!.toFixed(1)}m`)
      .join(', ')
    telemetry.push(`Detected objects: ${list}.`)
  }

  const ocr = (ctx.snapshot?.recognizedText ?? []).filter(Boolean).slice(0, 6)
  if (ocr.length > 0) {
    telemetry.push(`Visible text: "${ocr.join(' | ').slice(0, 180)}".`)
  }

  const recentTurns = ctx.history.slice(-4)
  const historyBlock = recentTurns.length > 0
    ? `\nRecent conversation:\n${recentTurns.map((t) => `${t.role === 'user' ? 'User' : 'NearDar'}: ${t.text}`).join('\n')}`
    : ''

  const sensorBlock = telemetry.length > 0 ? `Live phone sensors: ${telemetry.join(' ')}\n` : ''
  return `${sensorBlock}${historyBlock ? `${historyBlock}\n` : ''}User asks: ${question}`
}

/** Builds a combined single-string prompt for backends without a separate system channel. */
export function buildConversationalVisionPrompt(question: string, ctx: VisionPromptContext): string {
  return `${buildSatnavSystemPrompt(ctx.directionStyle)}\n\n${buildSatnavUserPrompt(question, ctx)}\nSpoken reply:`
}

export function buildAmbientObstaclePrompt(direction: string, distanceMeters: number): string {
  const dir = direction.replace(/-/g, ' ')
  return (
    `Look at the obstacle ${dir} about ${distanceMeters.toFixed(1)} metres away in this street/indoor camera view. ` +
    'Reply with ONLY a short 1 to 3 word name identifying what it is (for example: roadworks barrier, traffic cone, bicycle, pushbike, cyclist, e-scooter, dog, person, parked car, wheelie bin, A-board sign, bollard, lamppost, scaffolding, pushchair, puddle, overhanging branch, hedge, bench, doorway). ' +
    'Do not write a full sentence.'
  )
}

export function parseAmbientObstacleLabel(raw: string): string | undefined {
  const cleaned = raw
    .toLowerCase()
    .replace(/^(?:it(?:'s| is)\s+(?:a|an|the)\s+|there(?:'s| is)\s+(?:a|an|the)\s+|looks like\s+(?:a|an|the)\s+|a\s+|an\s+|the\s+)/i, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const words = cleaned.split(' ').filter(Boolean)
  if (words.length === 0 || words.length > 4) return undefined
  const label = words.join(' ')
  if (/^(?:obstacle|object|nothing|none|unknown|unclear|blurry|image|photo|camera|safe|clear)$/.test(label)) return undefined
  return label
}

/** Splits streamed VLM text deltas into complete spoken sentences for low-latency TTS. */
export class SentenceStreamSplitter {
  private emittedLength = 0

  push(accumulatedText: string): string[] {
    const remaining = accumulatedText.slice(this.emittedLength)
    if (!remaining) return []
    const ready: string[] = []
    let start = 0
    for (let i = 0; i < remaining.length; i++) {
      const ch = remaining[i]!
      if (ch !== '.' && ch !== '!' && ch !== '?') continue
      const prev = i > 0 ? remaining[i - 1]! : ''
      const next = i + 1 < remaining.length ? remaining[i + 1]! : ''
      // Do not split on decimal numbers (e.g. "1.5") or before the following character arrives
      if (!next || !/\s/.test(next)) continue
      if (ch === '.' && /\d/.test(prev) && /\d/.test(next)) continue
      const chunk = sanitizeSpokenVisionOutput(remaining.slice(start, i + 1))
      if (chunk.length >= 4) ready.push(chunk)
      start = i + 1
    }
    this.emittedLength += start
    return ready
  }

  flush(accumulatedText: string): string | undefined {
    const tail = sanitizeSpokenVisionOutput(accumulatedText.slice(this.emittedLength))
    this.emittedLength = accumulatedText.length
    return tail.length > 0 ? tail : undefined
  }
}

/** Instant deterministic telemetry reply for corridor/clearance queries (<50ms). */
export function buildFastCorridorReply(
  snapshot?: SceneSnapshot,
  route?: RouteProgress,
  stepLengthMeters?: number,
  directionStyle: DirectionStyle = 'natural',
): string {
  const corridor = snapshot?.corridor
  if (snapshot?.aimState === 'lowered' || corridor?.aimState === 'lowered') {
    return 'Your phone is lowered. Raise it slightly toward eye level so NearDar can scan ahead.'
  }
  if (snapshot?.aimState === 'covered' || corridor?.aimState === 'covered') {
    return 'The camera looks covered. Uncover the rear lens to scan ahead.'
  }
  if (!snapshot?.trackingReady || !corridor?.valid) {
    return 'LiDAR depth is still stabilizing. Hold your phone steady and level for a moment.'
  }
  const parts: string[] = []
  if (corridor.aimState === 'too-low') {
    parts.push('Your phone is angled down. Tilt it slightly up.')
  } else if (corridor.aimState === 'too-high') {
    parts.push('Your phone is angled up. Tilt it slightly down.')
  }

  const hazards = snapshot.hazards ?? []
  const priorityHazard = hazards.find(
    (h) => h.kind === 'fast-mover' || h.kind === 'drop-off' || h.kind === 'step-down' || h.kind === 'head-height' || h.kind === 'step-up',
  )
  if (priorityHazard) {
    const dir = formatDirectionLabel(priorityHazard.direction, directionStyle, priorityHazard.bearingDegrees)
    parts.push(
      priorityHazard.kind === 'fast-mover'
        ? `Fast movement, ${dir}, ${formatWalkingDistance(priorityHazard.distanceMeters, stepLengthMeters)} — hold still.`
        : priorityHazard.message,
    )
  } else if (corridor.corridorState === 'blocked') {
    parts.push(`Path blocked about ${formatWalkingDistance(corridor.forwardClearanceMeters, stepLengthMeters)} ahead.`)
  } else if (corridor.corridorState === 'narrow') {
    const side = corridor.recommendedHeadingOffsetDeg < 0 ? 'left' : 'right'
    parts.push(`Obstacle ${formatWalkingDistance(corridor.forwardClearanceMeters, stepLengthMeters)} ahead. Clear corridor to your ${side}.`)
  } else {
    const clearDist = corridor.forwardClearanceMeters >= 4.5
      ? 'over 4 metres'
      : formatWalkingDistance(corridor.forwardClearanceMeters, stepLengthMeters)
    parts.push(`Corridor looks open for ${clearDist} ahead.`)
  }

  const living = (snapshot.objects ?? [])
    .filter((o) => (o.label === 'dog' || o.label === 'cat' || o.label === 'person') && o.distanceMeters !== undefined && o.distanceMeters <= 4.0)
    .sort((a, b) => (a.distanceMeters ?? 99) - (b.distanceMeters ?? 99))
    .slice(0, 2)
  if (living.length > 0) {
    const desc = living
      .map((o) => `${o.label} ${formatDirectionLabel(o.direction, directionStyle, undefined, o.clockSector)} at ${formatWalkingDistance(o.distanceMeters!, stepLengthMeters)}`)
      .join(', ')
    parts.push(`Nearby: ${desc}.`)
  }

  if (route?.active && route.headingOffsetDeg !== undefined) {
    const phrase = turnPhraseFromOffset(route.headingOffsetDeg)
    parts.push(`Route to ${route.route.destinationName}: ${phrase}, ${formatWalkingDistance(route.remainingDistanceMeters, stepLengthMeters)} remaining.`)
  }
  return parts.join(' ')
}
