import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  clockDirectionFromOffset,
  formatWalkingDistance,
  normalizeAngleOffset,
  turnPhraseFromOffset,
} from './geo'

export const INDOOR_ANCHORS_STORAGE_KEY = 'neardar.indoor.anchors.v1'
export const INDOOR_ARRIVAL_RADIUS_METERS = 1.2
const MAX_INDOOR_ANCHORS = 100
const DEFAULT_STEP_LENGTH_METERS = 0.65
const FLOOR_DELTA_METERS = 2.0
const RAD_TO_DEG = 180 / Math.PI

/**
 * Relative 3D indoor pose using ARKit / ARCore right-handed Y-up world coordinates
 * aligned with `.gravityAndHeading`:
 * - +X = East (metres)
 * - +Y = Up / elevation (metres)
 * - -Z = North (metres), +Z = South
 * - headingDeg = compass heading in [0, 360), where 0 = North (-Z), 90 = East (+X).
 */
export interface IndoorPose {
  x: number
  y: number
  z: number
  headingDeg: number
}

export interface IndoorAnchor {
  id: string
  spaceName: string
  label: string
  x: number
  y: number
  z: number
  headingDeg: number
  createdAt: number
}

export interface IndoorGuidance {
  targetAnchor: IndoorAnchor
  /** Horizontal walking distance to the target anchor in metres. */
  distanceMeters: number
  /** Vertical difference (target.y - current.y) in metres. */
  elevationDeltaMeters: number
  /** Calibrated walking step count to the target anchor. */
  steps: number
  /** True-north world bearing [0, 360) from currentPose to targetAnchor. */
  targetBearingDeg: number
  /** Signed bearing offset in (-180, 180]: negative = left, positive = right. */
  bearingOffsetDeg: number
  /** Clock-face direction (1..12) relative to current heading. */
  clockDirection: number
  /** Natural turn instruction (e.g. "straight ahead", "turn right", "bear left"). */
  turnPhrase: string
  /** True once within 1.2m horizontally on the same floor. */
  arrived: boolean
  /** Concise spoken guidance string ready for TTS. */
  spokenGuidance: string
}

export interface IndoorStorageAdapter {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

function normalizeHeading(deg: number): number {
  if (!Number.isFinite(deg)) return 0
  return ((deg % 360) + 360) % 360
}

function clampStepLength(stepLengthMeters?: number): number {
  if (stepLengthMeters !== undefined && Number.isFinite(stepLengthMeters) && stepLengthMeters >= 0.4 && stepLengthMeters <= 1.2) {
    return stepLengthMeters
  }
  return DEFAULT_STEP_LENGTH_METERS
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value
}

function isValidAnchor(item: unknown): item is IndoorAnchor {
  if (!item || typeof item !== 'object') return false
  const a = item as Partial<IndoorAnchor>
  return (
    typeof a.id === 'string' &&
    typeof a.spaceName === 'string' &&
    typeof a.label === 'string' &&
    typeof a.x === 'number' && Number.isFinite(a.x) &&
    typeof a.y === 'number' && Number.isFinite(a.y) &&
    typeof a.z === 'number' && Number.isFinite(a.z) &&
    typeof a.headingDeg === 'number' && Number.isFinite(a.headingDeg) &&
    typeof a.createdAt === 'number' && Number.isFinite(a.createdAt)
  )
}

export async function loadIndoorAnchors(
  storage: IndoorStorageAdapter = AsyncStorage,
): Promise<IndoorAnchor[]> {
  try {
    const raw = await storage.getItem(INDOOR_ANCHORS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidAnchor)
  } catch {
    return []
  }
}

export async function saveIndoorAnchor(
  anchor: Omit<IndoorAnchor, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
  storage: IndoorStorageAdapter = AsyncStorage,
): Promise<IndoorAnchor[]> {
  const existing = await loadIndoorAnchors(storage)
  const spaceName = anchor.spaceName.trim() || 'Indoor Space'
  const label = anchor.label.trim()
  if (!label) return existing

  const normSpace = normalizeKey(spaceName)
  const normLabel = normalizeKey(label)
  const deduped = existing.filter(
    (item) => !(normalizeKey(item.spaceName) === normSpace && normalizeKey(item.label) === normLabel),
  )

  const entry: IndoorAnchor = {
    id: anchor.id ?? `indoor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    spaceName,
    label,
    x: Number.isFinite(anchor.x) ? anchor.x : 0,
    y: Number.isFinite(anchor.y) ? anchor.y : 0,
    z: Number.isFinite(anchor.z) ? anchor.z : 0,
    headingDeg: normalizeHeading(anchor.headingDeg),
    createdAt: anchor.createdAt ?? Date.now(),
  }

  const next = [entry, ...deduped].slice(0, MAX_INDOOR_ANCHORS)
  await storage.setItem(INDOOR_ANCHORS_STORAGE_KEY, JSON.stringify(next))
  return next
}

export async function removeIndoorAnchor(
  id: string,
  storage: IndoorStorageAdapter = AsyncStorage,
): Promise<IndoorAnchor[]> {
  const existing = await loadIndoorAnchors(storage)
  const next = existing.filter((item) => item.id !== id)
  await storage.setItem(INDOOR_ANCHORS_STORAGE_KEY, JSON.stringify(next))
  return next
}

export async function clearIndoorAnchors(
  spaceName?: string,
  storage: IndoorStorageAdapter = AsyncStorage,
): Promise<IndoorAnchor[]> {
  if (!spaceName) {
    await storage.removeItem(INDOOR_ANCHORS_STORAGE_KEY)
    return []
  }
  const existing = await loadIndoorAnchors(storage)
  const normSpace = normalizeKey(spaceName)
  const next = existing.filter((item) => normalizeKey(item.spaceName) !== normSpace)
  await storage.setItem(INDOOR_ANCHORS_STORAGE_KEY, JSON.stringify(next))
  return next
}

export function findIndoorAnchorByLabel(
  anchors: IndoorAnchor[],
  query: string,
  spaceName?: string,
): IndoorAnchor | undefined {
  const target = normalizeKey(query)
  if (!target) return undefined

  const scoped = spaceName
    ? anchors.filter((a) => normalizeKey(a.spaceName) === normalizeKey(spaceName))
    : anchors
  const candidates = scoped.length > 0 ? scoped : anchors

  return (
    candidates.find((a) => normalizeKey(a.label) === target) ??
    candidates.find((a) => normalizeKey(a.label).includes(target) || target.includes(normalizeKey(a.label)))
  )
}

export function listIndoorSpaces(anchors: IndoorAnchor[]): string[] {
  const seen = new Set<string>()
  const spaces: string[] = []
  for (const anchor of anchors) {
    const key = normalizeKey(anchor.spaceName)
    if (!seen.has(key)) {
      seen.add(key)
      spaces.push(anchor.spaceName)
    }
  }
  return spaces
}

/**
 * Pure relative spatial geometry helper for offline indoor guidance.
 * Uses ARKit/ARCore `.gravityAndHeading` axes (+X = East, +Y = Up, -Z = North).
 */
export function computeIndoorGuidance(
  currentPose: IndoorPose,
  targetAnchor: IndoorAnchor,
  stepLengthMeters = DEFAULT_STEP_LENGTH_METERS,
): IndoorGuidance {
  const stepLen = clampStepLength(stepLengthMeters)
  const dx = targetAnchor.x - currentPose.x
  const dy = targetAnchor.y - currentPose.y
  const dz = targetAnchor.z - currentPose.z

  const distanceMeters = Math.hypot(dx, dz)
  const elevationDeltaMeters = dy
  const steps = distanceMeters <= 0.15 ? 0 : Math.max(1, Math.round(distanceMeters / stepLen))

  // World bearing [0, 360): 0 = North (-Z), 90 = East (+X), 180 = South (+Z), 270 = West (-X)
  const currentHeading = normalizeHeading(currentPose.headingDeg)
  const targetBearingDeg =
    distanceMeters > 1e-4
      ? ((Math.atan2(dx, -dz) * RAD_TO_DEG) + 360) % 360
      : currentHeading

  const bearingOffsetDeg = distanceMeters > 1e-4
    ? normalizeAngleOffset(targetBearingDeg, currentHeading)
    : 0
  const clockDirection = clockDirectionFromOffset(bearingOffsetDeg)
  const turnPhrase = turnPhraseFromOffset(bearingOffsetDeg)
  const sameFloor = Math.abs(elevationDeltaMeters) < FLOOR_DELTA_METERS
  const arrived = distanceMeters <= INDOOR_ARRIVAL_RADIUS_METERS + 1e-6 && sameFloor

  let spokenGuidance: string
  if (arrived) {
    spokenGuidance = `You have arrived at ${targetAnchor.label}.`
  } else if (!sameFloor) {
    const levelCue = elevationDeltaMeters > 0 ? 'upstairs' : 'downstairs'
    const horizStr = distanceMeters <= INDOOR_ARRIVAL_RADIUS_METERS
      ? `directly ${levelCue}`
      : `${turnPhrase}, ${formatWalkingDistance(distanceMeters, stepLen)}, ${levelCue}`
    spokenGuidance = `${targetAnchor.label} is ${horizStr}.`
  } else {
    const distStr = formatWalkingDistance(distanceMeters, stepLen)
    const stepSuffix = distanceMeters >= 8 ? ` (about ${steps} steps)` : ''
    spokenGuidance = `${capitalize(turnPhrase)} toward ${targetAnchor.label}, ${distStr}${stepSuffix}.`
  }

  return {
    targetAnchor,
    distanceMeters,
    elevationDeltaMeters,
    steps,
    targetBearingDeg,
    bearingOffsetDeg,
    clockDirection,
    turnPhrase,
    arrived,
    spokenGuidance,
  }
}
