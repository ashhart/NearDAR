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
  uncertainty?: unknown
}
interface ValidatedVisionResult {
  objects: unknown[]
  unoccupiedSeats: unknown[]
  uncertainty?: unknown
}

const genericLabels: Record<string, true> = { object: true, obstacle: true, 'unknown object': true, 'nearby geometry': true }
const labelPattern = /^[a-z][a-z -]{1,39}$/
const unsafeLabel = /\b(safe|clear|cross|walk|go|empty|danger-free)\b/

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
  const lines = raw.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0 || lines.length > 12) return null
  const objects: unknown[] = []
  const seats: unknown[] = []
  for (const line of lines) {
    const match = /^([a-z][a-z -]{1,39})\s*\|\s*(left|center-left|center|center-right|right)\.?$/.exec(line)
    if (!match) return null
    const label = match[1]!.trim()
    const seat = /^unoccupied (chair|seat|bench|stool)$/.test(label)
    const value = { label: seat ? label.slice('unoccupied '.length) : label, direction: match[2]! }
    objects.push(value)
    if (seat) seats.push(value)
  }
  return { objects, unoccupiedSeats: seats, uncertainty: 'Plain visual labels are uncertain appearance evidence.' }
}

function parsedVision(raw: string): ValidatedVisionResult | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return parsedLines(raw)
  try {
    const value = JSON.parse(raw.slice(start, end + 1)) as VisionResult
    const objects = Array.isArray(value.objects) ? value.objects : value.object !== undefined ? [value.object] : undefined
    const seats = value.unoccupiedSeats === undefined ? [] : value.unoccupiedSeats
    if (!objects || !Array.isArray(seats) || objects.length > 12 || seats.length > 6) return null
    return { objects, unoccupiedSeats: seats, uncertainty: value.uncertainty }
  } catch {
    return null
  }
}

function validObject(value: unknown): value is ValidVisionObject {
  if (!value || typeof value !== 'object') return false
  const candidate = value as VisionObject
  return typeof candidate.label === 'string' && labelPattern.test(candidate.label) && !unsafeLabel.test(candidate.label) && typeof candidate.direction === 'string' && ['left', 'center-left', 'center', 'center-right', 'right', 'unknown'].includes(candidate.direction)
}

export function visionPrompt(question: string): string {
  return `Question: ${question}
Inspect only the supplied current image. List up to five clearly visible objects, one per line, using this exact format:
chair | left
lamppost | right
Use lowercase object names and one position: left, center-left, center, center-right, or right. Do not write distances, steps, descriptions, JSON, or any other text.
If a chair is completely visible and its seat has no person or object on it, add a line in this format:
unoccupied chair | center
Never identify people or infer sensitive traits. Do not include a seat that is partly hidden.`
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
  if (visible.length !== parsed.objects.length || !parsed.unoccupiedSeats.every(validObject)) {
    return { ...snapshot, notes: [...snapshot.notes, 'Visual model fields failed validation and were discarded.'] }
  }

  const occupiedTracks = new Set<string>()
  const additions: SceneObject[] = []
  let merged = [...snapshot.objects]
  visible.forEach((visionObject, index) => {
    const label = visionObject.label.toLowerCase()
    const visualDirection = direction(visionObject.direction)
    const matches = merged.filter((object) => !occupiedTracks.has(object.id) && object.direction === visualDirection && genericLabels[object.label.toLowerCase()])
    if (matches.length === 1) {
      const match = matches[0]!
      occupiedTracks.add(match.id)
      merged = merged.map((object) => object.id === match.id ? {
        ...object, label, evidence: [...object.evidence, 'on-device-vlm'],
      } : object)
      return
    }
    const exactMatches = merged.filter((object) => object.label.toLowerCase() === label && object.direction === visualDirection)
    if (exactMatches.length > 0 || visualDirection === 'unknown') return
    additions.push({
      id: `vision-${snapshot.sequence}-${index}`, label, direction: visualDirection, confidence: 0,
      evidence: ['on-device-vlm'],
    })
  })
  merged = [...merged, ...additions]

  const freeSeats: SeatCandidate[] = [...snapshot.freeSeats]
  for (const seat of parsed.unoccupiedSeats as ValidVisionObject[]) {
    if (!['chair', 'seat', 'bench'].includes(seat.label)) continue
    const seatDirection = direction(seat.direction)
    const candidates = merged.filter((object) => object.direction === seatDirection && /chair|seat/.test(object.label) && object.occupied !== true && object.evidence.some((item) => item === 'depth' || item === 'mesh' || item === 'depth-or-tracked-seat'))
    if (candidates.length !== 1) continue
    const candidate = candidates[0]!
    if (freeSeats.some((existing) => existing.id === candidate.id)) continue
    freeSeats.push({
      ...candidate, free: true,
      evidence: [...new Set([...candidate.evidence, 'on-device-vlm', 'depth-or-tracked-seat'])],
    })
  }

  return {
    ...snapshot,
    objects: merged.filter((object) => !freeSeats.some((seat) => seat.id === object.id)),
    freeSeats,
    notes: [...snapshot.notes, 'Visual labels are uncertain appearance evidence, never depth measurements or safe-movement decisions.'],
  }
}
