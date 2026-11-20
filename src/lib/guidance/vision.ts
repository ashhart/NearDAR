import type { Direction, SceneObject, SceneSnapshot, SeatCandidate } from './types'

interface VisionObject {
  label?: unknown
  direction?: unknown
}

interface ValidVisionObject {
  label: string
  direction: string
}
interface VisionResult {
  object?: unknown
  objects?: unknown
  unoccupiedSeats?: unknown
  occupiedSeats?: unknown
  uncertainty?: unknown
}
interface ValidatedVisionResult {
  objects: unknown[]
  unoccupiedSeats: unknown[]
  occupiedSeats: unknown[]
  uncertainty?: unknown
}

const genericLabels: Record<string, true> = { object: true, obstacle: true, 'unknown object': true, 'nearby geometry': true }
const labelPattern = /^[a-z][a-z -]{1,39}$/
const unsafeLabel = /\b(safe|clear|cross|walk|go|empty|danger-free)\b/
const seatLabels = new Set(['chair', 'seat', 'bench', 'stool'])

function direction(value: unknown): Direction {
  switch (value) {
    case 'left': return 'left'
    case 'center-left': return 'ahead-left'
    case 'center': return 'ahead'
    case 'center-right': return 'ahead-right'
    case 'right': return 'right'
    default: return 'unknown'
  }
}

function parsedLines(raw: string): ValidatedVisionResult | null {
  if (raw.length > 2_000) return null
  if (/^none\.?$/i.test(raw.trim())) return { objects: [], unoccupiedSeats: [], occupiedSeats: [], uncertainty: '' }
  const lines = raw.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0 || lines.length > 12) return null
  const objects: unknown[] = []
  const seats: unknown[] = []
  const occupied: unknown[] = []
  for (const line of lines) {
    const match = /^([a-z][a-z -]{1,39})\s*\|\s*(left|center-left|center|center-right|right)\.?$/.exec(line)
    if (!match) return null
    const label = match[1]!.trim()
    const seat = /^(unoccupied|occupied) (chair|seat|bench|stool)$/.exec(label)
    const value = { label: seat?.[2] ?? label, direction: match[2]! }
    objects.push(value)
    if (seat?.[1] === 'unoccupied') seats.push(value)
    if (seat?.[1] === 'occupied') occupied.push(value)
  }
  return { objects, unoccupiedSeats: seats, occupiedSeats: occupied, uncertainty: 'Plain visual labels are uncertain appearance evidence.' }
}

function parsedVision(raw: string): ValidatedVisionResult | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return parsedLines(raw)
  try {
    const value = JSON.parse(raw.slice(start, end + 1)) as VisionResult
    const objects = Array.isArray(value.objects) ? value.objects : value.object !== undefined ? [value.object] : undefined
    const seats = value.unoccupiedSeats === undefined ? [] : value.unoccupiedSeats
    const occupied = value.occupiedSeats === undefined ? [] : value.occupiedSeats
    if (!objects || !Array.isArray(seats) || !Array.isArray(occupied) || objects.length > 12 || seats.length > 6 || occupied.length > 6) return null
    return { objects, unoccupiedSeats: seats, occupiedSeats: occupied, uncertainty: value.uncertainty }
  } catch {
    return null
  }
}

function validObject(value: unknown): value is ValidVisionObject {
  if (!value || typeof value !== 'object') return false
  const candidate = value as VisionObject
  return typeof candidate.label === 'string' && labelPattern.test(candidate.label) && !unsafeLabel.test(candidate.label) && typeof candidate.direction === 'string' && ['left', 'center-left', 'center', 'center-right', 'right', 'unknown'].includes(candidate.direction)
}

export function visionPrompt(question: string, checkingSeats = false): string {
  if (checkingSeats) return `Examine only chairs, benches, or stools in this current image. Report at most five distinct seats, one per line. Mark a seat unoccupied only when the whole sitting surface is visible and there is no person, bag, or other object on it. Mark occupied if a person or belongings cover it. If the surface is hidden or unclear, report the seat without an occupancy label. Use these formats with the real seat type and position:
unoccupied chair | left
occupied chair | right
chair | center
Use only lowercase words and one position: left, center-left, center, center-right, or right. Do not guess distances. If you cannot see a seat, reply none.`
  return `Question: ${question}
Inspect only the supplied current image. If a requested object is visible, list it first. List up to five clearly visible objects, one per line, using this exact format:
chair | left
lamppost | right
Use lowercase object names and one position: left, center-left, center, center-right, or right. Do not write distances, steps, descriptions, JSON, or any other text.
Never identify people or infer sensitive traits.`
}

export function mergeVisionEvidence(raw: string, snapshot: SceneSnapshot): SceneSnapshot {
  const parsed = parsedVision(raw)
  if (!parsed) {
    return { ...snapshot, notes: [...snapshot.notes, 'Visual model output could not be validated and was discarded.'] }
  }
  if (typeof parsed.uncertainty !== 'string' || parsed.uncertainty.length > 240) {
    return { ...snapshot, notes: [...snapshot.notes, 'Visual model uncertainty was missing or invalid; output was discarded.'] }
  }
  const visible = parsed.objects.filter(validObject)
  if (visible.length !== parsed.objects.length || !parsed.unoccupiedSeats.every(validObject) || !parsed.occupiedSeats.every(validObject)) {
    return { ...snapshot, notes: [...snapshot.notes, 'Visual model fields failed validation and were discarded.'] }
  }

  const occupiedTracks = new Set<string>()
  const additions: SceneObject[] = []
  let merged = [...snapshot.objects]
  visible.forEach((visionObject, index) => {
    const label = visionObject.label.toLowerCase()
    const isSeat = seatLabels.has(label)
    const visualDirection = direction(visionObject.direction)
    const matches = isSeat ? [] : merged.filter((object) => !occupiedTracks.has(object.id) && object.direction === visualDirection && genericLabels[object.label.toLowerCase()])
    if (matches.length === 1) {
      const match = matches[0]!
      occupiedTracks.add(match.id)
      merged = merged.map((object) => object.id === match.id ? {
        ...object, label, evidence: [...object.evidence, 'on-device-vlm'],
      } : object)
      return
    }
    const alreadyLocated = merged.some((object) => object.label.toLowerCase() === label && object.direction === visualDirection)
    if (alreadyLocated || (!isSeat && visualDirection === 'unknown')) return
    if (isSeat && additions.some((object) => object.label === label)) return
    // The model can misplace a seat or infer an empty seat from its cropped edge.
    additions.push({
      id: `vision-${snapshot.sequence}-${index}`, label, direction: isSeat ? 'unknown' : visualDirection, confidence: 0,
      evidence: ['on-device-vlm'],
    })
  })
  merged = [...merged, ...additions]

  const freeSeats: SeatCandidate[] = []
  for (const seat of parsed.unoccupiedSeats) {
    if (!seatLabels.has(seat.label)) continue
    const seatDirection = direction(seat.direction)
    if (seatDirection === 'unknown' || parsed.occupiedSeats.some((other) => other.direction === seat.direction)) continue
    if (parsed.unoccupiedSeats.filter((other) => other.direction === seat.direction).length !== 1) continue
    if (visible.filter((other) => other.direction === seat.direction && seatLabels.has(other.label)).length !== 1) continue
    const tracks = snapshot.objects.filter((object) => object.direction === seatDirection && seatLabels.has(object.label) && !snapshot.freeSeats.some((known) => known.id === object.id || known.id === `candidate-${object.id}`))
    const native = [...tracks, ...snapshot.freeSeats.filter((object) => object.direction === seatDirection)]
    if (native.length > 1 || native.some((object) => object.occupied === true)) continue
    const matched = native[0]
    if (snapshot.depthState === 'ready' && matched && matched.occupied === false &&
        (snapshot.freeSeats.includes(matched as SeatCandidate) || matched.evidence.some((item) => item === 'depth' || item === 'mesh' || item === 'depth-or-tracked-seat'))) {
      freeSeats.push({
        ...matched, label: seat.label, free: true,
        evidence: [...new Set([...matched.evidence, 'on-device-vlm', 'depth-or-tracked-seat'])],
      })
    }
  }

  return {
    ...snapshot,
    objects: merged.filter((object) => !freeSeats.some((seat) => seat.id === object.id || seat.id === `candidate-${object.id}`)),
    freeSeats,
    notes: [...snapshot.notes, 'Visual labels are uncertain appearance evidence, never depth measurements or safe-movement decisions.'],
  }
}
