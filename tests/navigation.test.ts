import { describe, expect, test } from 'bun:test'
import {
  bearingDegrees,
  clockDirectionFromOffset,
  formatWalkingDistance,
  haversineMeters,
  normalizeAngleOffset,
  projectOntoPolyline,
  turnPhraseFromOffset,
} from '../src/lib/navigation/geo'
import {
  buildBreadcrumbReturnRoute,
  buildDirectBeaconRoute,
  findOfflineCachedRoute,
} from '../src/lib/navigation/store'
import { WalkingRouteTracker } from '../src/lib/navigation/tracker'
import type { WalkingRoute } from '../modules/tensorfold-navigation/src'

const sampleRoute: WalkingRoute = {
  id: 'route-1',
  destinationName: 'Costa Coffee',
  origin: { latitude: 51.5000, longitude: -0.1200 },
  destination: { latitude: 51.5005, longitude: -0.1190 },
  distanceMeters: 125,
  expectedTravelTimeSeconds: 100,
  polyline: [
    { latitude: 51.5000, longitude: -0.1200 },
    { latitude: 51.5005, longitude: -0.1200 }, // ~55.6m north
    { latitude: 51.5005, longitude: -0.1190 }, // ~69.3m east
  ],
  steps: [
    {
      instruction: 'Walk north on King Street',
      distanceMeters: 55.6,
      coordinates: [
        { latitude: 51.5000, longitude: -0.1200 },
        { latitude: 51.5005, longitude: -0.1200 },
      ],
    },
    {
      instruction: 'Turn right onto High Street',
      distanceMeters: 69.3,
      coordinates: [
        { latitude: 51.5005, longitude: -0.1200 },
        { latitude: 51.5005, longitude: -0.1190 },
      ],
    },
  ],
  source: 'mapkit',
  createdAt: Date.now(),
}

describe('walking navigation geometry', () => {
  test('computes accurate bearings, angle offsets, and clock sectors', () => {
    const start = { latitude: 51.5, longitude: -0.12 }
    const north = { latitude: 51.501, longitude: -0.12 }
    const east = { latitude: 51.5, longitude: -0.118 }

    expect(Math.round(bearingDegrees(start, north))).toBe(0)
    expect(Math.round(bearingDegrees(start, east))).toBe(90)
    expect(normalizeAngleOffset(10, 350)).toBe(20)
    expect(normalizeAngleOffset(350, 10)).toBe(-20)
    expect(clockDirectionFromOffset(0)).toBe(12)
    expect(clockDirectionFromOffset(90)).toBe(3)
    expect(clockDirectionFromOffset(-90)).toBe(9)
    expect(turnPhraseFromOffset(8)).toBe('straight ahead')
    expect(turnPhraseFromOffset(-90)).toBe('turn left')
    expect(turnPhraseFromOffset(45)).toBe('bear right')
  })

  test('projects onto polyline and formats natural walking distances', () => {
    const proj = projectOntoPolyline({ latitude: 51.50025, longitude: -0.1200 }, sampleRoute.polyline)
    expect(proj.distanceMeters).toBeLessThan(1)
    expect(proj.segmentIndex).toBe(0)
    expect(proj.remainingMeters).toBeGreaterThan(85)
    expect(formatWalkingDistance(3.25, 0.65)).toBe('about 5 steps')
    expect(formatWalkingDistance(42, 0.65)).toBe('40 metres')
    expect(formatWalkingDistance(1250)).toBe('1.3 kilometres')
  })
})

describe('walking route tracker', () => {
  test('announces start, prepares upcoming turns, triggers turn-now, and arrives', () => {
    const tracker = new WalkingRouteTracker(sampleRoute, 0.65)

    // Initial start facing east (90) when route heads north (0) -> tells user to turn left to align
    const s0 = tracker.update({ latitude: 51.5000, longitude: -0.1200 }, 90)
    expect(s0.announcement?.kind).toBe('route-start')
    expect(s0.announcement?.message).toContain('Costa Coffee')
    expect(s0.headingOffsetDeg).toBeCloseTo(-90, 0)

    // Walk to ~18m before the turn (51.50034)
    const s1 = tracker.update({ latitude: 51.50034, longitude: -0.1200 }, 0)
    expect(s1.announcement?.kind).toBe('turn-prepare')
    expect(s1.announcement?.message).toContain('turn right onto High Street')

    // Walk to ~4m before the turn (51.50046)
    const s2 = tracker.update({ latitude: 51.50046, longitude: -0.1200 }, 0)
    expect(s2.announcement?.kind).toBe('turn-right')
    expect(s2.announcement?.message).toBe('Turn right onto High Street now.')

    // Complete the turn and arrive near destination
    const s3 = tracker.update({ latitude: 51.5005, longitude: -0.11905 }, 90)
    expect(s3.arrived).toBe(true)
    expect(s3.announcement?.kind).toBe('arrived')
  })

  test('detects sustained off-route drift and guides user back onto polyline', () => {
    const tracker = new WalkingRouteTracker(sampleRoute)
    tracker.update({ latitude: 51.5000, longitude: -0.1200 }, 0)
    // Drift ~35m west of King Street (1st fix = streak 1, 2nd fix = offRoute)
    const firstDrift = tracker.update({ latitude: 51.5002, longitude: -0.1205 }, 0)
    expect(firstDrift.offRoute).toBe(false)
    const secondDrift = tracker.update({ latitude: 51.5002, longitude: -0.12055 }, 0)
    expect(secondDrift.offRoute).toBe(true)
    expect(secondDrift.announcement?.kind).toBe('off-route')
    // Aiming back toward King Street (east = ~90 deg) when facing north (0 deg) => positive right offset
    expect(secondDrift.headingOffsetDeg!).toBeGreaterThan(60)

    // Rejoin polyline
    const back = tracker.update({ latitude: 51.50025, longitude: -0.12002 }, 0)
    expect(back.offRoute).toBe(false)
    expect(back.announcement?.kind).toBe('back-on-route')
  })
})

describe('offline route cache, beacon, and breadcrumb return', () => {
  test('matches cached routes near origin or along polyline', () => {
    const matched = findOfflineCachedRoute([sampleRoute], 'costa', { latitude: 51.5002, longitude: -0.1201 })
    expect(matched?.id).toBe('route-1')
    const tooFar = findOfflineCachedRoute([sampleRoute], 'costa', { latitude: 52.0, longitude: -0.12 })
    expect(tooFar).toBeUndefined()
  })

  test('builds an offline breadcrumb return route with inferred turns', () => {
    const trail = [
      { latitude: 51.5000, longitude: -0.1200 },
      { latitude: 51.5002, longitude: -0.1200 },
      { latitude: 51.5004, longitude: -0.1200 },
      { latitude: 51.5004, longitude: -0.1195 },
      { latitude: 51.5004, longitude: -0.1190 },
    ]
    const ret = buildBreadcrumbReturnRoute(trail, 'the park gate')
    expect(ret).not.toBeNull()
    expect(ret!.source).toBe('breadcrumb-return')
    expect(ret!.steps.length).toBeGreaterThanOrEqual(2)
    expect(haversineMeters(ret!.destination, trail[0]!)).toBeLessThan(1)
    expect(ret!.steps.some((step) => /turn left/i.test(step.instruction))).toBe(true)
  })

  test('builds a direct offline compass beacon route', () => {
    const beacon = buildDirectBeaconRoute(
      { latitude: 51.5000, longitude: -0.1200 },
      { latitude: 51.5010, longitude: -0.1200 },
      'Home',
    )
    expect(beacon.source).toBe('direct-beacon')
    expect(beacon.steps[0]!.instruction).toContain('north')
    expect(beacon.distanceMeters).toBeGreaterThan(100)
  })
})
