import type { CorridorOpening, SpatialHazard } from '../../../modules/tensorfold-perception/src'
import type { Direction, DirectionStyle, SceneObject, SceneSnapshot } from '../guidance/types'
import { formatWalkingDistance } from '../navigation/geo'

/**
 * 4-tier speech priority model designed for Orientation & Mobility (O&M) safety:
 * - P0 (critical): Fast-approaching cyclists/runners, drop-offs, head-height hazards, < 0.85m stops.
 * - P1 (navigation): Turn-by-turn directions, off-route, arrival.
 * - P2 (interactive): Direct user Q&A, "I'm lost" orientation, sign reading, mode switches.
 * - P3 (ambient): Dog/cat/person presence, doorways, proactive TensorFold roadworks & landmarks.
 */
export type SpeechTier = 'critical' | 'navigation' | 'interactive' | 'ambient'

const TIER_RANK: Record<SpeechTier, number> = {
  critical: 0,
  navigation: 1,
  interactive: 2,
  ambient: 3,
}

export interface SpeechRequest {
  text: string
  tier: SpeechTier
  interrupt?: boolean
  category?: string
  cooldownMs?: number
  record?: boolean
}

export interface ArbitratorDecision {
  action: 'speak-now' | 'queued' | 'dropped'
  preemptCurrent: boolean
  item?: SpeechRequest
}

export class SpeechArbitrator {
  private current: SpeechRequest | null = null
  private queue: SpeechRequest[] = []
  private listening = false
  private lastCriticalAt = 0
  private categorySpokenAt = new Map<string, number>()

  setListening(active: boolean) {
    this.listening = active
    if (active) {
      // Drop low-priority background chatter as soon as the user starts speaking
      this.queue = this.queue.filter((item) => item.tier === 'critical')
    }
  }

  submit(request: SpeechRequest, now = Date.now()): ArbitratorDecision {
    const cleaned = request.text.trim()
    if (!cleaned) return { action: 'dropped', preemptCurrent: false }
    const item: SpeechRequest = { ...request, text: cleaned }

    // Category deduplication / cooldown check (skip for critical P0 if cooldown isn't explicitly set)
    if (item.category && item.cooldownMs && item.cooldownMs > 0) {
      const prev = this.categorySpokenAt.get(item.category)
      if (prev !== undefined && now - prev < item.cooldownMs) {
        return { action: 'dropped', preemptCurrent: false }
      }
    }

    const incomingRank = TIER_RANK[item.tier]

    // Ambient chatter is suppressed right after a critical hazard or while the user is speaking or busy
    if (item.tier === 'ambient') {
      if (this.listening) return { action: 'dropped', preemptCurrent: false }
      if (now - this.lastCriticalAt < 3_000) return { action: 'dropped', preemptCurrent: false }
      if (this.current && TIER_RANK[this.current.tier] < TIER_RANK.ambient) {
        return { action: 'dropped', preemptCurrent: false }
      }
    }

    // Non-critical speech pauses while user is actively talking into the mic
    if (this.listening && item.tier !== 'critical') {
      return { action: 'dropped', preemptCurrent: false }
    }

    if (item.tier === 'critical') {
      this.lastCriticalAt = now
    }

    // Determine whether this request preempts what is currently speaking
    const currentRank = this.current ? TIER_RANK[this.current.tier] : Number.POSITIVE_INFINITY
    const shouldPreempt =
      !this.current ||
      incomingRank < currentRank ||
      (item.interrupt === true && incomingRank <= currentRank)

    if (item.category) {
      this.categorySpokenAt.set(item.category, now)
    }

    if (shouldPreempt) {
      const hadCurrent = this.current !== null
      // Evict strictly lower-priority queued items when a higher tier takes over
      this.queue = this.queue.filter((queued) => TIER_RANK[queued.tier] < incomingRank)
      if (item.interrupt && item.tier !== 'ambient') {
        this.queue = this.queue.filter((queued) => TIER_RANK[queued.tier] < incomingRank)
      }
      this.current = item
      return { action: 'speak-now', preemptCurrent: hadCurrent, item }
    }

    // Never queue duplicate ambient items on top of each other
    if (item.tier === 'ambient') {
      if (this.queue.some((q) => q.tier === 'ambient')) {
        return { action: 'dropped', preemptCurrent: false }
      }
    }

    // Insert keeping highest-priority (lowest rank) items at the front
    let insertAt = this.queue.length
    for (let i = 0; i < this.queue.length; i++) {
      if (TIER_RANK[this.queue[i]!.tier] > incomingRank) {
        insertAt = i
        break
      }
    }
    this.queue.splice(insertAt, 0, item)
    if (this.queue.length > 6) this.queue.length = 6
    return { action: 'queued', preemptCurrent: false, item }
  }

  onFinished(): SpeechRequest | undefined {
    this.current = null
    if (this.listening) {
      // Only let critical speech through while mic is open
      const idx = this.queue.findIndex((q) => q.tier === 'critical')
      if (idx === -1) return undefined
      const [next] = this.queue.splice(idx, 1)
      this.current = next ?? null
      return next
    }
    const next = this.queue.shift()
    this.current = next ?? null
    return next
  }

  cancelAll() {
    this.current = null
    this.queue = []
  }

  activeTier(): SpeechTier | null {
    return this.current?.tier ?? null
  }

  pendingCount(): number {
    return this.queue.length
  }

  reset() {
    this.current = null
    this.queue = []
    this.listening = false
    this.lastCriticalAt = 0
    this.categorySpokenAt.clear()
  }
}

/** Converts a relative bearing in degrees (-180..+180) to clock-face ("11 o'clock") or natural ("ahead left") phrasing. */
export function formatDirectionFromBearing(bearingDeg: number, style: DirectionStyle): string {
  const normalized = ((((bearingDeg + 180) % 360) + 360) % 360) - 180
  if (style === 'clock') {
    const rawHour = Math.round(normalized / 30)
    const hour = ((rawHour % 12) + 12) % 12
    const clock = hour === 0 ? 12 : hour
    return `${clock} o'clock`
  }
  const abs = Math.abs(normalized)
  if (abs <= 12) return 'ahead'
  if (abs <= 38) return normalized < 0 ? 'ahead left' : 'ahead right'
  if (abs <= 115) return normalized < 0 ? 'to your left' : 'to your right'
  return 'behind you'
}

export function directionToBearing(direction: Direction, clockSector?: number): number {
  if (clockSector !== undefined && clockSector >= 1 && clockSector <= 12) {
    const delta = clockSector === 12 ? 0 : clockSector <= 6 ? clockSector * 30 : (clockSector - 12) * 30
    return delta
  }
  switch (direction) {
    case 'ahead': return 0
    case 'ahead-left': return -25
    case 'ahead-right': return 25
    case 'left': return -75
    case 'right': return 75
    case 'behind': return 180
    default: return 0
  }
}

export function formatDirectionLabel(direction: Direction, style: DirectionStyle, bearingDeg?: number, clockSector?: number): string {
  if (style === 'clock') {
    if (bearingDeg !== undefined && Number.isFinite(bearingDeg)) {
      return formatDirectionFromBearing(bearingDeg, 'clock')
    }
    if (clockSector !== undefined && clockSector >= 1 && clockSector <= 12) {
      return `${clockSector} o'clock`
    }
    return formatDirectionFromBearing(directionToBearing(direction), 'clock')
  }
  if (bearingDeg !== undefined && Number.isFinite(bearingDeg)) {
    return formatDirectionFromBearing(bearingDeg, 'natural')
  }
  return direction === 'unknown' ? 'ahead' : direction.replace(/-/g, ' ')
}

/** O&M radio-brevity hazard callout: Object, direction, distance, action. */
export function formatHazardCallout(
  hazard: SpatialHazard,
  style: DirectionStyle,
  stepLengthMeters?: number,
  recommendedHeadingOffsetDeg?: number,
): string {
  const dir = formatDirectionLabel(hazard.direction, style, hazard.bearingDegrees)
  const dist = formatWalkingDistance(hazard.distanceMeters, stepLengthMeters)
  switch (hazard.kind) {
    case 'fast-mover':
      return `Fast movement, ${dir}, ${dist} — hold still.`
    case 'drop-off':
      return `Drop-off, ${dir}, ${dist} — stop.`
    case 'step-down':
      return `Step down, ${dir}, ${dist}.`
    case 'step-up':
      return `Step up, ${dir}, ${dist}.`
    case 'head-height':
      return `Head-height hazard, ${dir}, ${dist} — watch your head.`
    case 'doorway':
      return `Opening, ${dir}, ${dist}.`
    default: {
      const steer =
        recommendedHeadingOffsetDeg !== undefined && Math.abs(recommendedHeadingOffsetDeg) >= 15
          ? ` — pass ${recommendedHeadingOffsetDeg < 0 ? 'left' : 'right'}`
          : ''
      return `Obstacle, ${dir}, ${dist}${steer}.`
    }
  }
}

export interface LivePresenceEvent {
  kind: 'animal' | 'person' | 'crowd' | 'opening'
  label: string
  direction: Direction
  bearingDegrees: number
  distanceMeters: number
  message: string
  category: string
}

/** Extracts immediate street presence (dogs, cats, people, crowds, doorway openings) from a live LiDAR + Vision snapshot. */
export function detectLivePresence(
  snapshot: SceneSnapshot | undefined,
  style: DirectionStyle,
  stepLengthMeters?: number,
): LivePresenceEvent | undefined {
  if (!snapshot?.trackingReady) return undefined
  if (snapshot.aimState === 'lowered' || snapshot.aimState === 'covered') return undefined

  const objects = snapshot.objects ?? []

  // 1. Animals (dogs / cats) get priority because canes and people easily startle/trip over pets
  const animals = objects
    .filter((o) => (o.label === 'dog' || o.label === 'cat' || o.label === 'animal') && o.distanceMeters !== undefined && o.distanceMeters <= 4.0)
    .sort((a, b) => (a.distanceMeters ?? 99) - (b.distanceMeters ?? 99))

  if (animals[0]) {
    const pet = animals[0]
    const dist = pet.distanceMeters!
    const bearing = directionToBearing(pet.direction, pet.clockSector)
    const dir = formatDirectionLabel(pet.direction, style, undefined, pet.clockSector)
    const name = pet.label[0]!.toUpperCase() + pet.label.slice(1)
    return {
      kind: 'animal',
      label: pet.label,
      direction: pet.direction,
      bearingDegrees: bearing,
      distanceMeters: dist,
      message: `${name}, ${dir}, ${formatWalkingDistance(dist, stepLengthMeters)}.`,
      category: `animal:${pet.label}:${pet.direction}`,
    }
  }

  // 2. People & Crowds within 3.8m
  const nearbyPeople = objects
    .filter((o) => o.label === 'person' && o.distanceMeters !== undefined && o.distanceMeters <= 3.8)
    .sort((a, b) => (a.distanceMeters ?? 99) - (b.distanceMeters ?? 99))

  if (nearbyPeople.length >= 3) {
    const nearest = nearbyPeople[0]!
    const dist = nearest.distanceMeters!
    return {
      kind: 'crowd',
      label: 'crowd',
      direction: nearest.direction,
      bearingDegrees: directionToBearing(nearest.direction, nearest.clockSector),
      distanceMeters: dist,
      message: `Busy ahead — ${nearbyPeople.length} people, nearest ${formatWalkingDistance(dist, stepLengthMeters)}.`,
      category: 'presence:crowd',
    }
  }

  if (nearbyPeople[0] && nearbyPeople[0].distanceMeters! <= 3.0) {
    const person = nearbyPeople[0]
    const dist = person.distanceMeters!
    const bearing = directionToBearing(person.direction, person.clockSector)
    const dir = formatDirectionLabel(person.direction, style, undefined, person.clockSector)
    return {
      kind: 'person',
      label: 'person',
      direction: person.direction,
      bearingDegrees: bearing,
      distanceMeters: dist,
      message: `Person, ${dir}, ${formatWalkingDistance(dist, stepLengthMeters)}.`,
      category: `presence:person:${person.direction}`,
    }
  }

  // 3. Doorways / passage openings when walking alongside walls or looking for entrances
  const openings: CorridorOpening[] = snapshot.corridor?.openings ?? []
  const bestOpening = openings
    .filter((op) => op.distanceMeters <= 2.4)
    .sort((a, b) => Math.abs(a.bearingDegrees) - Math.abs(b.bearingDegrees))[0]

  if (bestOpening) {
    const dir = formatDirectionLabel(bestOpening.direction, style, bestOpening.bearingDegrees)
    return {
      kind: 'opening',
      label: 'opening',
      direction: bestOpening.direction,
      bearingDegrees: bestOpening.bearingDegrees,
      distanceMeters: bestOpening.distanceMeters,
      message: `Opening, ${dir}, ${formatWalkingDistance(bestOpening.distanceMeters, stepLengthMeters)}.`,
      category: `presence:opening:${bestOpening.direction}`,
    }
  }

  return undefined
}

export interface LiveEntityChip {
  id: string
  label: string
  tone: 'danger' | 'warn' | 'accent' | 'clear'
}

/** Builds high-contrast HUD chips for low-vision users from the live snapshot. */
export function extractLiveEntityChips(snapshot: SceneSnapshot | undefined): LiveEntityChip[] {
  if (!snapshot) return []
  const chips: LiveEntityChip[] = []

  if (snapshot.aimState === 'lowered' || snapshot.aimState === 'covered') {
    chips.push({ id: 'standby', label: snapshot.aimState === 'covered' ? 'Lens covered' : 'Standby', tone: 'warn' })
    return chips
  }

  const hazards = snapshot.hazards ?? []
  const fast = hazards.find((h) => h.kind === 'fast-mover')
  if (fast) {
    chips.push({ id: 'fast-mover', label: `Fast mover ${fast.distanceMeters.toFixed(1)}m`, tone: 'danger' })
  }
  const vertical = hazards.find((h) => h.kind === 'drop-off' || h.kind === 'step-down' || h.kind === 'head-height')
  if (vertical) {
    const title = vertical.kind === 'head-height' ? 'Head hazard' : vertical.kind === 'drop-off' ? 'Drop-off' : 'Step down'
    chips.push({ id: vertical.id, label: `${title} ${vertical.distanceMeters.toFixed(1)}m`, tone: 'danger' })
  }

  const objects: SceneObject[] = snapshot.objects ?? []
  const animal = objects
    .filter((o) => (o.label === 'dog' || o.label === 'cat') && o.distanceMeters !== undefined && o.distanceMeters <= 4.5)
    .sort((a, b) => (a.distanceMeters ?? 99) - (b.distanceMeters ?? 99))[0]
  if (animal) {
    chips.push({
      id: animal.id,
      label: `${animal.label[0]!.toUpperCase() + animal.label.slice(1)} ${animal.distanceMeters!.toFixed(1)}m`,
      tone: 'accent',
    })
  }

  const people = objects.filter((o) => o.label === 'person' && o.distanceMeters !== undefined && o.distanceMeters <= 4.5)
  if (people.length >= 2) {
    chips.push({ id: 'people-count', label: `${people.length} people`, tone: 'warn' })
  } else if (people[0]) {
    chips.push({ id: people[0].id, label: `Person ${people[0].distanceMeters!.toFixed(1)}m`, tone: 'warn' })
  }

  const opening = snapshot.corridor?.openings?.[0]
  if (opening && opening.distanceMeters <= 2.8) {
    chips.push({ id: 'opening', label: `Opening ${opening.direction.replace('-', ' ')}`, tone: 'clear' })
  }

  return chips.slice(0, 3)
}
