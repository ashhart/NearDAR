import AsyncStorage from '@react-native-async-storage/async-storage'
import type { GeoPoint, RouteStep, WalkingRoute } from '../../../modules/tensorfold-navigation/src'
import { bearingDegrees, cardinalDirection, haversineMeters, normalizeAngleOffset, polylineLengthMeters } from './geo'

const PLACES_KEY = 'neardar.savedPlaces.v1'
const ROUTES_KEY = 'neardar.cachedRoutes.v1'
const MAX_CACHED_ROUTES = 25

export interface SavedPlace {
  id: string
  name: string
  latitude: number
  longitude: number
  address?: string
  savedAt: number
}

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

export async function loadSavedPlaces(): Promise<SavedPlace[]> {
  try {
    const raw = await AsyncStorage.getItem(PLACES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is SavedPlace =>
      item && typeof item.id === 'string' && typeof item.name === 'string' &&
      typeof item.latitude === 'number' && typeof item.longitude === 'number',
    )
  } catch {
    return []
  }
}

export async function savePlace(place: Omit<SavedPlace, 'id' | 'savedAt'>): Promise<SavedPlace[]> {
  const existing = await loadSavedPlaces()
  const norm = normalizeLabel(place.name)
  const filtered = existing.filter((item) => normalizeLabel(item.name) !== norm)
  const entry: SavedPlace = {
    id: `place-${Date.now()}`,
    name: place.name.trim(),
    latitude: place.latitude,
    longitude: place.longitude,
    address: place.address,
    savedAt: Date.now(),
  }
  const next = [entry, ...filtered].slice(0, 50)
  await AsyncStorage.setItem(PLACES_KEY, JSON.stringify(next))
  return next
}

export async function removeSavedPlace(id: string): Promise<SavedPlace[]> {
  const existing = await loadSavedPlaces()
  const next = existing.filter((item) => item.id !== id)
  await AsyncStorage.setItem(PLACES_KEY, JSON.stringify(next))
  return next
}

export function findSavedPlaceByName(places: SavedPlace[], query: string): SavedPlace | undefined {
  const target = normalizeLabel(query)
  if (!target) return undefined
  return places.find((place) => normalizeLabel(place.name) === target) ??
    places.find((place) => normalizeLabel(place.name).includes(target) || target.includes(normalizeLabel(place.name)))
}

export async function loadCachedRoutes(): Promise<WalkingRoute[]> {
  try {
    const raw = await AsyncStorage.getItem(ROUTES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((route): route is WalkingRoute =>
      route && typeof route.id === 'string' && typeof route.destinationName === 'string' &&
      Array.isArray(route.polyline) && route.polyline.length >= 2,
    )
  } catch {
    return []
  }
}

export async function cacheWalkingRoute(route: WalkingRoute): Promise<WalkingRoute[]> {
  const existing = await loadCachedRoutes()
  const norm = normalizeLabel(route.destinationName)
  const cached: WalkingRoute = { ...route, source: 'cached' }
  const deduped = existing.filter((item) =>
    !(normalizeLabel(item.destinationName) === norm && haversineMeters(item.origin, route.origin) < 120),
  )
  const next = [cached, ...deduped].slice(0, MAX_CACHED_ROUTES)
  await AsyncStorage.setItem(ROUTES_KEY, JSON.stringify(next))
  return next
}

export async function clearCachedRoutes(): Promise<void> {
  await AsyncStorage.removeItem(ROUTES_KEY)
}

/** Finds an offline cached walking route matching the destination name near the current origin. */
export function findOfflineCachedRoute(
  routes: WalkingRoute[],
  destinationQuery: string,
  origin: GeoPoint,
  maxOriginDriftMeters = 250,
): WalkingRoute | undefined {
  const target = normalizeLabel(destinationQuery)
  if (!target) return undefined
  return routes.find((route) => {
    const routeName = normalizeLabel(route.destinationName)
    const matchesName = routeName === target || routeName.includes(target) || target.includes(routeName)
    if (!matchesName) return false
    // Either our current position is near the cached origin OR near any vertex on the cached polyline
    if (haversineMeters(route.origin, origin) <= maxOriginDriftMeters) return true
    return route.polyline.some((pt) => haversineMeters(pt, origin) <= maxOriginDriftMeters)
  })
}

/** Builds a direct offline compass-beacon route to a saved place when no cached street route exists. */
export function buildDirectBeaconRoute(origin: GeoPoint, destination: GeoPoint, destinationName: string): WalkingRoute {
  const dist = haversineMeters(origin, destination)
  const bearing = bearingDegrees(origin, destination)
  return {
    id: `beacon-${Date.now()}`,
    destinationName,
    origin,
    destination,
    distanceMeters: dist,
    expectedTravelTimeSeconds: Math.round(dist / 1.25),
    polyline: [origin, destination],
    steps: [{
      instruction: `Head ${cardinalDirection(bearing)} toward ${destinationName}`,
      distanceMeters: dist,
      coordinates: [origin, destination],
    }],
    source: 'direct-beacon',
    createdAt: Date.now(),
  }
}

/** Builds an offline return route by reversing recorded session breadcrumbs and inferring turns. */
export function buildBreadcrumbReturnRoute(breadcrumbs: GeoPoint[], label = 'where you started'): WalkingRoute | null {
  if (breadcrumbs.length < 2) return null
  const reversed = [...breadcrumbs].reverse()
  // Simplify closely spaced breadcrumbs (< 6m) while preserving start and end
  const simplified: GeoPoint[] = [reversed[0]!]
  for (let i = 1; i < reversed.length - 1; i++) {
    if (haversineMeters(simplified[simplified.length - 1]!, reversed[i]!) >= 6) {
      simplified.push(reversed[i]!)
    }
  }
  const end = reversed[reversed.length - 1]!
  if (haversineMeters(simplified[simplified.length - 1]!, end) >= 2 || simplified.length === 1) {
    simplified.push(end)
  }

  const steps: RouteStep[] = []
  let segCoords: GeoPoint[] = [simplified[0]!]
  let prevBearing = bearingDegrees(simplified[0]!, simplified[1]!)
  let currentInstruction = `Walk back toward ${label}`

  for (let i = 1; i < simplified.length; i++) {
    segCoords.push(simplified[i]!)
    if (i < simplified.length - 1) {
      const nextBearing = bearingDegrees(simplified[i]!, simplified[i + 1]!)
      const turn = normalizeAngleOffset(nextBearing, prevBearing)
      if (Math.abs(turn) >= 35) {
        steps.push({
          instruction: currentInstruction,
          distanceMeters: polylineLengthMeters(segCoords),
          coordinates: segCoords,
        })
        currentInstruction = turn < 0 ? 'Turn left along your return path' : 'Turn right along your return path'
        segCoords = [simplified[i]!]
      }
      prevBearing = nextBearing
    }
  }
  steps.push({
    instruction: currentInstruction,
    distanceMeters: polylineLengthMeters(segCoords),
    coordinates: segCoords,
  })

  const totalDist = polylineLengthMeters(simplified)
  return {
    id: `return-${Date.now()}`,
    destinationName: label,
    origin: simplified[0]!,
    destination: end,
    distanceMeters: totalDist,
    expectedTravelTimeSeconds: Math.round(totalDist / 1.25),
    polyline: simplified,
    steps,
    source: 'breadcrumb-return',
    createdAt: Date.now(),
  }
}
