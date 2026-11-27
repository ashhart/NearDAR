import type { GeoPoint } from '../../../modules/tensorfold-navigation/src'
import { cardinalDirection } from '../navigation/geo'

export interface LocationShareInput {
  location?: GeoPoint
  streetAddress?: string
  headingDegrees?: number
  destinationName?: string
  senderName?: string
}

const MIN_DIALABLE_DIGITS = 3
const MAX_DIALABLE_DIGITS = 20

/**
 * Strips formatting and non-dialable characters from a phone number,
 * preserving at most a single leading `+` followed by digits.
 */
export function sanitizePhoneNumber(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const stripped = trimmed.replace(/[^0-9+]/g, '')
  const hasLeadingPlus = stripped.startsWith('+')
  const digits = stripped.replace(/\+/g, '').slice(0, MAX_DIALABLE_DIGITS)
  if (!digits) return ''
  return hasLeadingPlus ? `+${digits}` : digits
}

function hasDialableLength(sanitized: string): boolean {
  const digitCount = sanitized.startsWith('+') ? sanitized.length - 1 : sanitized.length
  return digitCount >= MIN_DIALABLE_DIGITS
}

/** Builds an RFC 3966 `tel:` URI for quick emergency or trusted-companion calling. */
export function buildEmergencyCallUrl(phone: string): string | undefined {
  const clean = sanitizePhoneNumber(phone)
  if (!hasDialableLength(clean)) return undefined
  return `tel:${clean}`
}

/**
 * Builds a platform-appropriate `sms:` URI with URL-encoded body text.
 * Uses `&body=` on iOS and `?body=` on Android and web.
 */
export function buildEmergencySmsUrl(
  phone: string,
  body: string,
  platform: 'ios' | 'android' | 'web',
): string | undefined {
  const clean = sanitizePhoneNumber(phone)
  if (!hasDialableLength(clean)) return undefined
  const message = body.trim()
  if (!message) return `sms:${clean}`
  const separator = platform === 'ios' ? '&' : '?'
  return `sms:${clean}${separator}body=${encodeURIComponent(message)}`
}

function isValidGeoPoint(point: GeoPoint | undefined): point is GeoPoint {
  return Boolean(
    point &&
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.latitude) <= 90 &&
    Math.abs(point.longitude) <= 180,
  )
}

/**
 * Composes a clear, scannable location-sharing message for SMS or OS Share Sheet handoff
 * with street address, compass heading, destination, and both Apple Maps and OpenStreetMap links.
 */
export function buildLocationShareMessage({
  location,
  streetAddress,
  headingDegrees,
  destinationName,
  senderName,
}: LocationShareInput): string {
  const lines: string[] = []
  const cleanedSender = senderName?.trim()
  lines.push(cleanedSender ? `NearDar location share from ${cleanedSender}:` : 'NearDar location share:')

  const cleanedStreet = streetAddress?.trim()
  if (cleanedStreet) {
    lines.push(`Near ${cleanedStreet}.`)
  }

  if (headingDegrees !== undefined && Number.isFinite(headingDegrees)) {
    const normalizedDeg = Math.round(((headingDegrees % 360) + 360) % 360) % 360
    const cardinal = cardinalDirection(normalizedDeg)
    lines.push(`Facing ${cardinal} (${normalizedDeg}°).`)
  }

  const cleanedDest = destinationName?.trim()
  if (cleanedDest) {
    lines.push(`Heading to ${cleanedDest}.`)
  }

  if (isValidGeoPoint(location)) {
    const lat = location.latitude.toFixed(6)
    const lng = location.longitude.toFixed(6)
    lines.push(`Coordinates: ${lat}, ${lng}`)
    lines.push(`Apple Maps: https://maps.apple.com/?ll=${lat},${lng}`)
    lines.push(`OpenStreetMap: https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`)
  } else {
    lines.push('GPS coordinates are currently unavailable.')
  }

  return lines.join('\n')
}
