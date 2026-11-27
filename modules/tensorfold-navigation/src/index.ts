import { type EventSubscription, requireOptionalNativeModule } from 'expo-modules-core'
import { Platform } from 'react-native'

export interface GeoPoint {
  latitude: number
  longitude: number
}

export interface PlaceMatch {
  name: string
  address: string
  latitude: number
  longitude: number
  distanceMeters?: number
}

export interface RouteStep {
  instruction: string
  distanceMeters: number
  coordinates: GeoPoint[]
}

export interface WalkingRoute {
  id: string
  destinationName: string
  destination: GeoPoint
  origin: GeoPoint
  distanceMeters: number
  expectedTravelTimeSeconds: number
  polyline: GeoPoint[]
  steps: RouteStep[]
  source: 'mapkit' | 'cached' | 'breadcrumb-return' | 'direct-beacon'
  createdAt: number
}

export interface NavigationCapabilities {
  available: boolean
  platform: 'ios' | 'android' | 'web'
  mapKitDirections: boolean
  compassHeading: boolean
  locationPermission: 'granted' | 'denied' | 'restricted' | 'notDetermined' | 'unknown'
  backgroundSupported?: boolean
}

export interface NavigationEvent {
  type: 'location' | 'heading' | 'error'
  latitude?: number
  longitude?: number
  accuracyMeters?: number
  speedMps?: number
  courseDegrees?: number
  trueHeadingDegrees?: number
  magneticHeadingDegrees?: number
  accuracyDegrees?: number
  message?: string
  timestampMs: number
}

interface NativeTensorFoldNavigation {
  getCapabilities(): Promise<NavigationCapabilities>
  startTracking(): Promise<{ active: boolean }>
  stopTracking(): Promise<void>
  setBackgroundEnabled?(enabled: boolean): Promise<void>
  searchPlaces(query: string, nearLat?: number | null, nearLng?: number | null): Promise<PlaceMatch[]>
  calculateWalkingRoute(
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number,
    destinationName?: string | null
  ): Promise<WalkingRoute>
  addListener(eventName: string, listener: (event: NavigationEvent) => void): void
  removeListener(eventName: string, listener: (event: NavigationEvent) => void): void
}

const native = requireOptionalNativeModule<NativeTensorFoldNavigation>('TensorFoldNavigation')

// Lightweight JS fallback subscriptions for Android/Web via expo-location
const fallbackListeners = new Set<(event: NavigationEvent) => void>()
let fallbackPositionSub: { remove(): void } | null = null
let fallbackHeadingSub: { remove(): void } | null = null

function emitFallback(event: NavigationEvent) {
  fallbackListeners.forEach((listener) => listener(event))
}

export async function getCapabilities(): Promise<NavigationCapabilities> {
  if (native) return native.getCapabilities()
  return {
    available: Platform.OS !== 'web',
    platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web',
    mapKitDirections: false,
    compassHeading: Platform.OS !== 'web',
    locationPermission: 'unknown',
    backgroundSupported: false,
  }
}

export async function startTracking(): Promise<{ active: boolean }> {
  if (native) return native.startTracking()
  if (Platform.OS === 'web') return { active: false }
  const Location = await import('expo-location')
  const perm = await Location.requestForegroundPermissionsAsync()
  if (!perm.granted) throw new Error('Location access is required for walking navigation.')
  await stopTracking()
  fallbackPositionSub = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1_000, distanceInterval: 1.5 },
    (pos) => {
      emitFallback({
        type: 'location',
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracyMeters: pos.coords.accuracy ?? 20,
        speedMps: pos.coords.speed ?? undefined,
        courseDegrees: pos.coords.heading ?? undefined,
        timestampMs: pos.timestamp,
      })
    },
  )
  fallbackHeadingSub = await Location.watchHeadingAsync((heading) => {
    emitFallback({
      type: 'heading',
      trueHeadingDegrees: heading.trueHeading >= 0 ? heading.trueHeading : undefined,
      magneticHeadingDegrees: heading.magHeading,
      accuracyDegrees: heading.accuracy,
      timestampMs: Date.now(),
    })
  }).catch(() => null)
  return { active: true }
}

export async function stopTracking(): Promise<void> {
  if (native) {
    await native.stopTracking()
    return
  }
  fallbackPositionSub?.remove()
  fallbackPositionSub = null
  fallbackHeadingSub?.remove()
  fallbackHeadingSub = null
}

export async function setBackgroundEnabled(enabled: boolean): Promise<void> {
  if (native?.setBackgroundEnabled) {
    await native.setBackgroundEnabled(enabled)
  }
}

export async function searchPlaces(query: string, near?: GeoPoint): Promise<PlaceMatch[]> {
  if (native) {
    return native.searchPlaces(query, near?.latitude ?? null, near?.longitude ?? null)
  }
  return []
}

export async function calculateWalkingRoute(
  from: GeoPoint,
  to: GeoPoint,
  destinationName?: string,
): Promise<WalkingRoute> {
  if (native) {
    return native.calculateWalkingRoute(from.latitude, from.longitude, to.latitude, to.longitude, destinationName ?? null)
  }
  throw new Error('Native MapKit walking directions require the iOS app. Saved places and offline beacon guidance remain available.')
}

export function addNavigationListener(listener: (event: NavigationEvent) => void): EventSubscription {
  if (native) {
    native.addListener('onNavigationEvent', listener)
    return { remove: () => native.removeListener('onNavigationEvent', listener) }
  }
  fallbackListeners.add(listener)
  return { remove: () => { fallbackListeners.delete(listener) } }
}

export default native
