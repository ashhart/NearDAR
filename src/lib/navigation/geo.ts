import type { GeoPoint } from '../../../modules/tensorfold-navigation/src'
import type { DistanceUnit } from '../guidance/types'

const EARTH_RADIUS_M = 6_371_000
const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI
const METERS_TO_FEET = 3.28084
const METERS_PER_MILE = 1609.344

export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.latitude - a.latitude) * DEG_TO_RAD
  const dLon = (b.longitude - a.longitude) * DEG_TO_RAD
  const lat1 = a.latitude * DEG_TO_RAD
  const lat2 = b.latitude * DEG_TO_RAD
  const sinLat = Math.sin(dLat / 2)
  const sinLon = Math.sin(dLon / 2)
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** True-north bearing in [0, 360) from point a to point b. */
export function bearingDegrees(a: GeoPoint, b: GeoPoint): number {
  const lat1 = a.latitude * DEG_TO_RAD
  const lat2 = b.latitude * DEG_TO_RAD
  const dLon = (b.longitude - a.longitude) * DEG_TO_RAD
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return ((Math.atan2(y, x) * RAD_TO_DEG) + 360) % 360
}

/** Signed angle offset in (-180, 180]: positive = turn right, negative = turn left. */
export function normalizeAngleOffset(targetDeg: number, currentDeg: number): number {
  let diff = ((targetDeg - currentDeg) % 360 + 540) % 360 - 180
  if (diff <= -180) diff += 360
  return diff
}

export function clockDirectionFromOffset(offsetDeg: number): number {
  const normalized = ((offsetDeg % 360) + 360) % 360
  const hour = Math.round(normalized / 30) % 12
  return hour === 0 ? 12 : hour
}

export function turnPhraseFromOffset(offsetDeg: number): string {
  const abs = Math.abs(offsetDeg)
  if (abs <= 15) return 'straight ahead'
  if (abs <= 35) return offsetDeg < 0 ? 'bear slightly left' : 'bear slightly right'
  if (abs <= 65) return offsetDeg < 0 ? 'bear left' : 'bear right'
  if (abs <= 125) return offsetDeg < 0 ? 'turn left' : 'turn right'
  if (abs <= 155) return offsetDeg < 0 ? 'sharp left' : 'sharp right'
  return 'turn around'
}

export function cardinalDirection(headingDeg: number): string {
  const dirs = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']
  const idx = Math.round((((headingDeg % 360) + 360) % 360) / 45) % 8
  return dirs[idx]!
}

/** Local flat-Earth projection (meters) relative to an origin, accurate over walking distances. */
function toLocalXY(point: GeoPoint, origin: GeoPoint): [number, number] {
  const latRad = origin.latitude * DEG_TO_RAD
  const x = (point.longitude - origin.longitude) * DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(latRad)
  const y = (point.latitude - origin.latitude) * DEG_TO_RAD * EARTH_RADIUS_M
  return [x, y]
}

export interface PolylineProjection {
  distanceMeters: number
  segmentIndex: number
  t: number
  closestPoint: GeoPoint
  remainingMeters: number
}

export function projectOntoPolyline(point: GeoPoint, polyline: GeoPoint[]): PolylineProjection {
  if (polyline.length === 0) {
    return { distanceMeters: Infinity, segmentIndex: 0, t: 0, closestPoint: point, remainingMeters: 0 }
  }
  if (polyline.length === 1) {
    const d = haversineMeters(point, polyline[0]!)
    return { distanceMeters: d, segmentIndex: 0, t: 0, closestPoint: polyline[0]!, remainingMeters: d }
  }

  let bestDist = Infinity
  let bestIndex = 0
  let bestT = 0
  let bestPoint = polyline[0]!

  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i]!
    const b = polyline[i + 1]!
    const [ax, ay] = [0, 0]
    const [bx, by] = toLocalXY(b, a)
    const [px, py] = toLocalXY(point, a)
    const dx = bx - ax
    const dy = by - ay
    const lenSq = dx * dx + dy * dy
    const t = lenSq > 1e-6 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)) : 0
    const projX = ax + t * dx
    const projY = ay + t * dy
    const dist = Math.hypot(px - projX, py - projY)
    if (dist < bestDist) {
      bestDist = dist
      bestIndex = i
      bestT = t
      bestPoint = {
        latitude: a.latitude + (b.latitude - a.latitude) * t,
        longitude: a.longitude + (b.longitude - a.longitude) * t,
      }
    }
  }

  let remaining = haversineMeters(bestPoint, polyline[bestIndex + 1]!)
  for (let i = bestIndex + 1; i < polyline.length - 1; i++) {
    remaining += haversineMeters(polyline[i]!, polyline[i + 1]!)
  }

  return {
    distanceMeters: bestDist,
    segmentIndex: bestIndex,
    t: bestT,
    closestPoint: bestPoint,
    remainingMeters: remaining,
  }
}

export function polylineLengthMeters(polyline: GeoPoint[]): number {
  let total = 0
  for (let i = 0; i < polyline.length - 1; i++) {
    total += haversineMeters(polyline[i]!, polyline[i + 1]!)
  }
  return total
}

/** Find a point lookaheadMeters ahead along the polyline from a given projection. */
export function lookaheadPoint(polyline: GeoPoint[], proj: PolylineProjection, lookaheadMeters: number): GeoPoint {
  if (polyline.length === 0) return proj.closestPoint
  if (polyline.length === 1) return polyline[0]!
  let remaining = Math.max(1, lookaheadMeters)
  let current = proj.closestPoint
  for (let i = proj.segmentIndex + 1; i < polyline.length; i++) {
    const next = polyline[i]!
    const segDist = haversineMeters(current, next)
    if (segDist >= remaining && segDist > 0.01) {
      const frac = remaining / segDist
      return {
        latitude: current.latitude + (next.latitude - current.latitude) * frac,
        longitude: current.longitude + (next.longitude - current.longitude) * frac,
      }
    }
    remaining -= segDist
    current = next
  }
  return polyline[polyline.length - 1]!
}

export function formatWalkingDistance(
  meters: number,
  stepLengthMeters?: number,
  unit: DistanceUnit = 'metric',
): string {
  if (!Number.isFinite(meters) || meters < 0) return 'unknown distance'

  if (unit === 'imperial') {
    if (meters < 0.9) return 'less than 3 feet'
    if (meters < 8 && stepLengthMeters && stepLengthMeters >= 0.4 && stepLengthMeters <= 1.2) {
      const steps = Math.max(1, Math.round(meters / stepLengthMeters))
      return steps === 1 ? 'about 1 step' : `about ${steps} steps`
    }
    const feet = meters * METERS_TO_FEET
    if (meters < 100) {
      const rounded = feet < 30 ? Math.round(feet) : Math.round(feet / 5) * 5
      return rounded === 1 ? '1 foot' : `${rounded} feet`
    }
    if (meters < 400) {
      const rounded = Math.round(feet / 10) * 10
      return `${rounded} feet`
    }
    return `${(meters / METERS_PER_MILE).toFixed(1)} miles`
  }

  if (meters < 1.2) return 'less than a metre'
  if (meters < 8 && stepLengthMeters && stepLengthMeters >= 0.4 && stepLengthMeters <= 1.2) {
    const steps = Math.max(1, Math.round(meters / stepLengthMeters))
    return steps === 1 ? 'about 1 step' : `about ${steps} steps`
  }
  if (meters < 20) return `${Math.round(meters)} metres`
  if (meters < 100) return `${Math.round(meters / 5) * 5} metres`
  if (meters < 950) return `${Math.round(meters / 10) * 10} metres`
  return `${(meters / 1000).toFixed(1)} kilometres`
}
