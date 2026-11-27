import { describe, expect, test } from 'bun:test'
import type { SceneSnapshot } from '../src/lib/guidance/types'
import { defaultSettings, normalizeEmergencyContactPhone, validSettings } from '../src/lib/settings'
import { formatWalkingDistance } from '../src/lib/navigation/geo'
import {
  detectLivePresence,
  extractLiveEntityChips,
  formatHazardCallout,
  formatShortDistance,
} from '../src/lib/satnav/arbitrator'
import {
  applyProfilePatch,
  MOBILITY_PROFILE_ORDER,
  MOBILITY_PROFILES,
  shouldAnnounceHazardForProfile,
  shouldAnnouncePresenceForProfile,
} from '../src/lib/satnav/profiles'
import {
  buildEmergencyCallUrl,
  buildEmergencySmsUrl,
  buildLocationShareMessage,
  sanitizePhoneNumber,
} from '../src/lib/satnav/emergency'

function makeSnapshot(overrides: Partial<SceneSnapshot> = {}): SceneSnapshot {
  return {
    observedAt: Date.now(),
    sequence: 1,
    trackingReady: true,
    depthState: 'ready',
    validDepthFraction: 0.9,
    cameraOrientation: 'camera-forward',
    objects: [],
    freeSeats: [],
    recognizedText: [],
    aimState: 'level',
    depthSource: 'lidar',
    thermalState: 'nominal',
    proactiveVlmAllowed: true,
    lightingState: 'good',
    ambientLuma: 0.62,
    corridor: {
      sectors: [],
      recommendedHeadingOffsetDeg: 0,
      corridorState: 'clear',
      forwardClearanceMeters: 4.2,
      bestClearanceMeters: 4.2,
      aimState: 'level',
      pitchDegrees: 0,
      valid: true,
    },
    hazards: [],
    notes: [],
    ...overrides,
  }
}

describe('settings validation and defaults', () => {
  test('preserves all existing defaults and sets safe defaults for new fields', () => {
    expect(defaultSettings.guidanceMode).toBe('satnav')
    expect(defaultSettings.stepLengthMeters).toBe(0.65)
    expect(defaultSettings.directionStyle).toBe('natural')
    expect(defaultSettings.oledHighContrast).toBe(false)
    expect(defaultSettings.mobilityProfile).toBe('standard')
    expect(defaultSettings.distanceUnit).toBe('metric')
    expect(defaultSettings.mountMode).toBe('handheld')
    expect(defaultSettings.screenCurtain).toBe(false)
    expect(defaultSettings.backgroundSatnav).toBe(true)
    expect(defaultSettings.autoTorch).toBe(false)
    expect(defaultSettings.emergencyContactName).toBe('')
    expect(defaultSettings.emergencyContactPhone).toBe('')
  })

  test('validates new mobility, unit, mount, thermal/curtain, and emergency settings', () => {
    const parsed = validSettings({
      mobilityProfile: 'guide-dog',
      distanceUnit: 'imperial',
      mountMode: 'lanyard',
      screenCurtain: true,
      backgroundSatnav: false,
      autoTorch: true,
      emergencyContactName: '   Sarah   Connor   ',
      emergencyContactPhone: '  +44 7700-900 123  ',
    })
    expect(parsed.mobilityProfile).toBe('guide-dog')
    expect(parsed.distanceUnit).toBe('imperial')
    expect(parsed.mountMode).toBe('lanyard')
    expect(parsed.screenCurtain).toBe(true)
    expect(parsed.backgroundSatnav).toBe(false)
    expect(parsed.autoTorch).toBe(true)
    expect(parsed.emergencyContactName).toBe('Sarah Connor')
    expect(parsed.emergencyContactPhone).toBe('+44 7700-900 123')
  })

  test('falls back safely on invalid values and enforces length/character constraints', () => {
    const parsed = validSettings({
      mobilityProfile: 'wheelchair',
      distanceUnit: 'nautical',
      mountMode: 'helmet',
      screenCurtain: 'yes',
      backgroundSatnav: undefined,
      autoTorch: 1,
      emergencyContactName: 'A'.repeat(60),
      emergencyContactPhone: 'call: +44 (0) 7700-900-123-456-789-000',
    })
    expect(parsed.mobilityProfile).toBe('standard')
    expect(parsed.distanceUnit).toBe('metric')
    expect(parsed.mountMode).toBe('handheld')
    expect(parsed.screenCurtain).toBe(false)
    expect(parsed.backgroundSatnav).toBe(true)
    expect(parsed.autoTorch).toBe(false)
    expect(parsed.emergencyContactName.length).toBe(40)
    expect(parsed.emergencyContactPhone.length).toBeLessThanOrEqual(24)
    expect(parsed.emergencyContactPhone).toMatch(/^[0-9+\-\s]+$/)

    expect(normalizeEmergencyContactPhone('abc---+++')).toBe('')
    expect(normalizeEmergencyContactPhone('123+456')).toBe('123456')
  })
})

describe('metric and imperial walking distance formatting', () => {
  test('preserves exact metric formatting by default', () => {
    expect(formatWalkingDistance(-1)).toBe('unknown distance')
    expect(formatWalkingDistance(Number.NaN)).toBe('unknown distance')
    expect(formatWalkingDistance(0.8)).toBe('less than a metre')
    expect(formatWalkingDistance(3.25, 0.65)).toBe('about 5 steps')
    expect(formatWalkingDistance(1.3, 0.65, 'metric')).toBe('about 2 steps')
    expect(formatWalkingDistance(12)).toBe('12 metres')
    expect(formatWalkingDistance(42, 0.65)).toBe('40 metres')
    expect(formatWalkingDistance(254)).toBe('250 metres')
    expect(formatWalkingDistance(1250)).toBe('1.3 kilometres')
  })

  test('formats imperial walking distances accurately across all ranges', () => {
    expect(formatWalkingDistance(-2, undefined, 'imperial')).toBe('unknown distance')
    expect(formatWalkingDistance(0.5, undefined, 'imperial')).toBe('less than 3 feet')
    expect(formatWalkingDistance(0.89, 0.65, 'imperial')).toBe('less than 3 feet')

    // Calibrated steps for short distances when stepLengthMeters is provided
    expect(formatWalkingDistance(3.25, 0.65, 'imperial')).toBe('about 5 steps')
    expect(formatWalkingDistance(0.95, 0.8, 'imperial')).toBe('about 1 step')

    // < 100m without steps: rounded feet
    expect(formatWalkingDistance(1.83, undefined, 'imperial')).toBe('6 feet')
    expect(formatWalkingDistance(7.62, undefined, 'imperial')).toBe('25 feet')
    expect(formatWalkingDistance(15, 0.65, 'imperial')).toBe('50 feet')
    expect(formatWalkingDistance(50, undefined, 'imperial')).toBe('165 feet')

    // 100m..400m: nearest 10 feet
    expect(formatWalkingDistance(100, undefined, 'imperial')).toBe('330 feet')
    expect(formatWalkingDistance(150, undefined, 'imperial')).toBe('490 feet')
    expect(formatWalkingDistance(300, undefined, 'imperial')).toBe('980 feet')

    // >= 400m: tenths of a mile
    expect(formatWalkingDistance(483, undefined, 'imperial')).toBe('0.3 miles')
    expect(formatWalkingDistance(1609.344, undefined, 'imperial')).toBe('1.0 miles')
    expect(formatWalkingDistance(2414, undefined, 'imperial')).toBe('1.5 miles')
  })
})

describe('mobility profiles and O&M filtering', () => {
  test('registers all 4 profiles with non-empty metadata and fresh settings patches', () => {
    expect(MOBILITY_PROFILE_ORDER).toEqual(['standard', 'cane', 'guide-dog', 'low-vision'])
    for (const id of MOBILITY_PROFILE_ORDER) {
      const cfg = MOBILITY_PROFILES[id]
      expect(cfg.id).toBe(id)
      expect(cfg.label.length).toBeGreaterThan(0)
      expect(cfg.shortDescription.length).toBeGreaterThan(10)
      const patch = applyProfilePatch(id)
      expect(patch.mobilityProfile).toBe(id)
      // Mutating returned patch must not mutate the registry
      patch.warningDistanceMeters = 9.9
      expect(MOBILITY_PROFILES[id].recommendedSettings.warningDistanceMeters).not.toBe(9.9)
    }

    expect(applyProfilePatch('low-vision').oledHighContrast).toBe(true)
    expect(applyProfilePatch('cane').ambientObstacleNaming).toBe(false)
    expect(applyProfilePatch('guide-dog').ambientObstacleNaming).toBe(false)
    expect(applyProfilePatch('guide-dog').hapticProximity).toBe(false)
    expect(applyProfilePatch('standard').ambientObstacleNaming).toBe(true)
    expect(applyProfilePatch('standard').proactiveNarration).toBe(true)
  })

  test('white cane profile suppresses non-urgent ground obstacle chatter while keeping critical hazards', () => {
    expect(shouldAnnounceHazardForProfile('obstacle', 'caution', 1.6, 'cane')).toBe(false)
    expect(shouldAnnounceHazardForProfile('obstacle', 'info', 2.2, 'cane')).toBe(false)
    expect(shouldAnnounceHazardForProfile('step-up', 'caution', 1.4, 'cane')).toBe(false)
    expect(shouldAnnounceHazardForProfile('obstacle', 'urgent', 0.7, 'cane')).toBe(true)

    expect(shouldAnnounceHazardForProfile('fast-mover', 'urgent', 3.5, 'cane')).toBe(true)
    expect(shouldAnnounceHazardForProfile('head-height', 'caution', 1.8, 'cane')).toBe(true)
    expect(shouldAnnounceHazardForProfile('drop-off', 'urgent', 1.4, 'cane')).toBe(true)
    expect(shouldAnnounceHazardForProfile('step-down', 'caution', 1.5, 'cane')).toBe(true)
    expect(shouldAnnounceHazardForProfile('doorway', 'info', 2.0, 'cane')).toBe(true)

    expect(shouldAnnouncePresenceForProfile('animal', 'cane')).toBe(true)
    expect(shouldAnnouncePresenceForProfile('opening', 'cane')).toBe(true)
    expect(shouldAnnouncePresenceForProfile('crowd', 'cane')).toBe(true)
    expect(shouldAnnouncePresenceForProfile('person', 'cane')).toBe(true)
  })

  test('guide dog profile suppresses routine static obstacles & single pedestrians while keeping overhead, fast movers, animals, and doorways', () => {
    expect(shouldAnnounceHazardForProfile('obstacle', 'caution', 1.8, 'guide-dog')).toBe(false)
    expect(shouldAnnounceHazardForProfile('obstacle', 'urgent', 0.9, 'guide-dog')).toBe(false)
    expect(shouldAnnounceHazardForProfile('obstacle', 'urgent', 0.5, 'guide-dog')).toBe(true)
    expect(shouldAnnounceHazardForProfile('step-up', 'caution', 1.2, 'guide-dog')).toBe(false)
    expect(shouldAnnounceHazardForProfile('step-down', 'caution', 1.2, 'guide-dog')).toBe(false)
    expect(shouldAnnounceHazardForProfile('step-down', 'urgent', 0.9, 'guide-dog')).toBe(true)

    expect(shouldAnnounceHazardForProfile('fast-mover', 'urgent', 3.2, 'guide-dog')).toBe(true)
    expect(shouldAnnounceHazardForProfile('head-height', 'caution', 1.6, 'guide-dog')).toBe(true)
    expect(shouldAnnounceHazardForProfile('drop-off', 'urgent', 1.5, 'guide-dog')).toBe(true)
    expect(shouldAnnounceHazardForProfile('doorway', 'info', 2.0, 'guide-dog')).toBe(true)

    expect(shouldAnnouncePresenceForProfile('person', 'guide-dog')).toBe(false)
    expect(shouldAnnouncePresenceForProfile('animal', 'guide-dog')).toBe(true)
    expect(shouldAnnouncePresenceForProfile('opening', 'guide-dog')).toBe(true)
    expect(shouldAnnouncePresenceForProfile('crowd', 'guide-dog')).toBe(true)
  })

  test('low-vision and standard profiles filter hazards and presence appropriately', () => {
    // Low vision keeps steps, drop-offs, head-height, fast movers, and close/urgent obstacles
    expect(shouldAnnounceHazardForProfile('step-up', 'caution', 1.6, 'low-vision')).toBe(true)
    expect(shouldAnnounceHazardForProfile('step-down', 'caution', 1.6, 'low-vision')).toBe(true)
    expect(shouldAnnounceHazardForProfile('drop-off', 'urgent', 1.5, 'low-vision')).toBe(true)
    expect(shouldAnnounceHazardForProfile('head-height', 'caution', 1.8, 'low-vision')).toBe(true)
    expect(shouldAnnounceHazardForProfile('obstacle', 'caution', 2.2, 'low-vision')).toBe(false)
    expect(shouldAnnounceHazardForProfile('obstacle', 'caution', 1.0, 'low-vision')).toBe(true)
    expect(shouldAnnouncePresenceForProfile('animal', 'low-vision')).toBe(true)
    expect(shouldAnnouncePresenceForProfile('crowd', 'low-vision')).toBe(true)
    expect(shouldAnnouncePresenceForProfile('person', 'low-vision')).toBe(false)
    expect(shouldAnnouncePresenceForProfile('opening', 'low-vision')).toBe(false)

    // Standard keeps everything active
    expect(shouldAnnounceHazardForProfile('obstacle', 'caution', 2.0, 'standard')).toBe(true)
    expect(shouldAnnounceHazardForProfile('step-up', 'info', 1.8, 'standard')).toBe(true)
    expect(shouldAnnouncePresenceForProfile('person', 'standard')).toBe(true)
    expect(shouldAnnouncePresenceForProfile('opening', 'standard')).toBe(true)
  })
})

describe('arbitrator unit formatting, imperial hazard callouts, and presence', () => {
  test('formats compact HUD distances in metric and imperial', () => {
    expect(formatShortDistance(0.7)).toBe('0.7m')
    expect(formatShortDistance(3.2, 'metric')).toBe('3.2m')
    expect(formatShortDistance(25, 'metric')).toBe('25m')
    expect(formatShortDistance(1250, 'metric')).toBe('1.3km')
    expect(formatShortDistance(-5, 'metric')).toBe('--')

    expect(formatShortDistance(0.5, 'imperial')).toBe('<3ft')
    expect(formatShortDistance(1.83, 'imperial')).toBe('6ft')
    expect(formatShortDistance(3.2, 'imperial')).toBe('10ft')
    expect(formatShortDistance(150, 'imperial')).toBe('490ft')
    expect(formatShortDistance(483, 'imperial')).toBe('0.3mi')
  })

  test('formats hazard callouts in imperial while preserving metric default', () => {
    const hazard = {
      id: 'h-fast',
      kind: 'fast-mover' as const,
      severity: 'urgent' as const,
      direction: 'ahead-left' as const,
      bearingDegrees: -30,
      distanceMeters: 3.2,
      confidence: 0.9,
      message: 'Fast movement ahead left.',
      observedAt: Date.now(),
    }
    expect(formatHazardCallout(hazard, 'clock')).toBe("Fast movement, 11 o'clock, 3 metres — hold still.")
    expect(formatHazardCallout(hazard, 'clock', undefined, undefined, 'imperial')).toBe(
      "Fast movement, 11 o'clock, 10 feet — hold still.",
    )

    const dropOff = { ...hazard, id: 'h-drop', kind: 'drop-off' as const, distanceMeters: 0.7, bearingDegrees: 0, direction: 'ahead' as const }
    expect(formatHazardCallout(dropOff, 'natural', undefined, undefined, 'imperial')).toBe(
      'Drop-off, ahead, less than 3 feet — stop.',
    )

    const obstacle = { ...hazard, id: 'h-obs', kind: 'obstacle' as const, distanceMeters: 2.13, bearingDegrees: 0, direction: 'ahead' as const }
    expect(formatHazardCallout(obstacle, 'natural', undefined, 25, 'imperial')).toBe(
      'Obstacle, ahead, 7 feet — pass right.',
    )
  })

  test('formats live presence and HUD entity chips in imperial when selected', () => {
    const dogSnap = makeSnapshot({
      objects: [
        { id: 'd1', label: 'dog', confidence: 0.9, direction: 'ahead-left', clockSector: 11, distanceMeters: 1.83, evidence: [] },
        { id: 'p1', label: 'person', confidence: 0.9, direction: 'ahead-right', clockSector: 1, distanceMeters: 3.05, evidence: [] },
      ],
      hazards: [
        {
          id: 'head-1',
          kind: 'head-height',
          severity: 'caution',
          direction: 'ahead',
          bearingDegrees: 0,
          distanceMeters: 1.52,
          confidence: 0.85,
          message: 'Head hazard ahead.',
          observedAt: Date.now(),
        },
      ],
    })

    const presenceImp = detectLivePresence(dogSnap, 'clock', undefined, 'imperial')
    expect(presenceImp?.kind).toBe('animal')
    expect(presenceImp?.message).toBe("Dog, 11 o'clock, 6 feet.")

    const chipsMetric = extractLiveEntityChips(dogSnap)
    expect(chipsMetric.map((c) => c.label)).toContain('Head hazard 1.5m')
    expect(chipsMetric.map((c) => c.label)).toContain('Dog 1.8m')

    const chipsImperial = extractLiveEntityChips(dogSnap, 'imperial')
    expect(chipsImperial.map((c) => c.label)).toContain('Head hazard 5ft')
    expect(chipsImperial.map((c) => c.label)).toContain('Dog 6ft')
    expect(chipsImperial.map((c) => c.label)).toContain('Person 10ft')

    const openingSnap = makeSnapshot({
      corridor: {
        sectors: [],
        openings: [{ bearingDegrees: -45, direction: 'ahead-left', distanceMeters: 1.83, clearanceMeters: 3.5, widthDegrees: 30 }],
        recommendedHeadingOffsetDeg: 0,
        corridorState: 'clear',
        forwardClearanceMeters: 4.0,
        bestClearanceMeters: 4.0,
        aimState: 'level',
        pitchDegrees: 0,
        valid: true,
      },
    })
    expect(detectLivePresence(openingSnap, 'natural', undefined, 'imperial')?.message).toBe(
      'Opening, to your left, 6 feet.',
    )
  })
})

describe('emergency and trusted companion handoff helpers', () => {
  test('sanitizes phone numbers safely and blocks injection characters', () => {
    expect(sanitizePhoneNumber('+44 7700 900123')).toBe('+447700900123')
    expect(sanitizePhoneNumber('+1 (555) 123-4567')).toBe('+15551234567')
    expect(sanitizePhoneNumber('  07700-900 123  ')).toBe('07700900123')
    expect(sanitizePhoneNumber('999')).toBe('999')
    expect(sanitizePhoneNumber('++44+7700')).toBe('+447700')
    expect(sanitizePhoneNumber('123+456')).toBe('123456')
    expect(sanitizePhoneNumber('tel:+44 7700 900123&body=evil')).toBe('+447700900123')
    expect(sanitizePhoneNumber('   ')).toBe('')
    expect(sanitizePhoneNumber('+++')).toBe('')
    expect(sanitizePhoneNumber('not-a-number')).toBe('')
  })

  test('builds valid tel: and platform-specific sms: URLs', () => {
    expect(buildEmergencyCallUrl('+44 7700 900123')).toBe('tel:+447700900123')
    expect(buildEmergencyCallUrl('911')).toBe('tel:911')
    expect(buildEmergencyCallUrl('12')).toBeUndefined()
    expect(buildEmergencyCallUrl('')).toBeUndefined()

    const msg = 'Near 221B Baker St & facing north'
    expect(buildEmergencySmsUrl('+44 7700 900123', msg, 'ios')).toBe(
      `sms:+447700900123&body=${encodeURIComponent(msg)}`,
    )
    expect(buildEmergencySmsUrl('+44 7700 900123', msg, 'android')).toBe(
      `sms:+447700900123?body=${encodeURIComponent(msg)}`,
    )
    expect(buildEmergencySmsUrl('+44 7700 900123', msg, 'web')).toBe(
      `sms:+447700900123?body=${encodeURIComponent(msg)}`,
    )
    expect(buildEmergencySmsUrl('+44 7700 900123', '   ', 'ios')).toBe('sms:+447700900123')
    expect(buildEmergencySmsUrl('bad', msg, 'ios')).toBeUndefined()
  })

  test('builds clean location share messages with Apple Maps, OpenStreetMap, street, heading, and destination', () => {
    const full = buildLocationShareMessage({
      location: { latitude: 51.523767, longitude: -0.158556 },
      streetAddress: '221B Baker Street, London',
      headingDegrees: 359.8,
      destinationName: 'King’s Cross Station',
    })
    expect(full).toContain('Near 221B Baker Street, London.')
    expect(full).toContain('Facing north (0°).')
    expect(full).toContain('Heading to King’s Cross Station.')
    expect(full).toContain('https://maps.apple.com/?ll=51.523767,-0.158556')
    expect(full).toContain('https://www.openstreetmap.org/?mlat=51.523767&mlon=-0.158556#map=18/51.523767/-0.158556')

    const noGps = buildLocationShareMessage({
      streetAddress: 'Oxford Street',
      headingDegrees: 90,
    })
    expect(noGps).toContain('Near Oxford Street.')
    expect(noGps).toContain('Facing east (90°).')
    expect(noGps).toContain('GPS coordinates are currently unavailable.')
    expect(noGps).not.toContain('maps.apple.com')
    expect(noGps).not.toContain('openstreetmap.org')
  })
})
