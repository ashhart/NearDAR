import { describe, expect, test } from 'bun:test'
import { fuseSatnavGuidance } from '../src/lib/navigation/fusion'
import type { CorridorSummary, SpatialHazard } from '../modules/tensorfold-perception/src'
import type { RouteProgress } from '../src/lib/navigation/tracker'

const prefs = {
  hapticSteering: true,
  hapticProximity: true,
  spatialBeacon: true,
  beaconHeadphonesOnly: true,
}

function makeCorridor(overrides: Partial<CorridorSummary> = {}): CorridorSummary {
  return {
    sectors: [
      { index: 0, centerDegrees: -45, label: 'far-left', clearanceMeters: 4, sampleCount: 20, confidence: 0.9 },
      { index: 1, centerDegrees: -30, label: 'left', clearanceMeters: 4, sampleCount: 20, confidence: 0.9 },
      { index: 2, centerDegrees: -15, label: 'ahead-left', clearanceMeters: 4, sampleCount: 20, confidence: 0.9 },
      { index: 3, centerDegrees: 0, label: 'ahead', clearanceMeters: 4, sampleCount: 20, confidence: 0.9 },
      { index: 4, centerDegrees: 15, label: 'ahead-right', clearanceMeters: 4, sampleCount: 20, confidence: 0.9 },
      { index: 5, centerDegrees: 30, label: 'right', clearanceMeters: 4, sampleCount: 20, confidence: 0.9 },
      { index: 6, centerDegrees: 45, label: 'far-right', clearanceMeters: 4, sampleCount: 20, confidence: 0.9 },
    ],
    recommendedHeadingOffsetDeg: 0,
    corridorState: 'clear',
    forwardClearanceMeters: 4,
    bestClearanceMeters: 4,
    aimState: 'level',
    pitchDegrees: -5,
    valid: true,
    ...overrides,
  }
}

function makeRoute(headingOffsetDeg = 5): RouteProgress {
  return {
    active: true,
    route: {
      id: 'r1',
      destinationName: 'Library',
      origin: { latitude: 0, longitude: 0 },
      destination: { latitude: 0.001, longitude: 0 },
      distanceMeters: 110,
      expectedTravelTimeSeconds: 90,
      polyline: [{ latitude: 0, longitude: 0 }, { latitude: 0.001, longitude: 0 }],
      steps: [{ instruction: 'Walk north', distanceMeters: 110, coordinates: [{ latitude: 0, longitude: 0 }, { latitude: 0.001, longitude: 0 }] }],
      source: 'mapkit',
      createdAt: Date.now(),
    },
    stepIndex: 0,
    currentStep: { instruction: 'Walk north', distanceMeters: 110, coordinates: [] },
    distanceToNextTurnMeters: 40,
    remainingDistanceMeters: 110,
    targetBearingDeg: 0,
    headingOffsetDeg,
    crossTrackErrorMeters: 1,
    offRoute: false,
    arrived: false,
  }
}

describe('macro route + micro LiDAR steering fusion', () => {
  test('steers along route bearing when LiDAR corridor is clear', () => {
    const fused = fuseSatnavGuidance(makeRoute(-18), makeCorridor(), [], prefs)
    expect(fused.steeringSource).toBe('route')
    expect(fused.steeringOffsetDeg).toBe(-18)
    expect(fused.spatialBeacon.active).toBe(true)
    expect(fused.spatialBeacon.azimuthDeg).toBe(-18)
    expect(fused.hapticState.active).toBe(true)
  })

  test('blends into a micro-detour when center is obstructed on an active route', () => {
    const narrow = makeCorridor({
      corridorState: 'narrow',
      forwardClearanceMeters: 1.3,
      recommendedHeadingOffsetDeg: 30,
    })
    const fused = fuseSatnavGuidance(makeRoute(5), narrow, [], prefs)
    expect(fused.steeringSource).toBe('corridor-detour')
    expect(fused.steeringOffsetDeg).toBe(30)
    expect(fused.summary).toContain('step slightly right')
  })

  test('elevates drop-off and head-height hazards to distinct haptic and vertical 3D audio cues', () => {
    const headHazard: SpatialHazard = {
      id: 'lidar-head-height',
      kind: 'head-height',
      severity: 'caution',
      direction: 'ahead',
      bearingDegrees: 4,
      distanceMeters: 1.3,
      confidence: 0.85,
      message: 'Head-height obstacle ahead, 1.3 metres.',
      observedAt: Date.now(),
    }
    const fusedHead = fuseSatnavGuidance(makeRoute(0), makeCorridor(), [headHazard], prefs)
    expect(fusedHead.urgentHapticCue).toBe('head-hazard')
    expect(fusedHead.urgentSpatialCue?.elevationMeters).toBeGreaterThan(0)

    const dropHazard: SpatialHazard = {
      id: 'lidar-drop-off',
      kind: 'drop-off',
      severity: 'urgent',
      direction: 'ahead',
      bearingDegrees: 0,
      distanceMeters: 1.4,
      confidence: 0.8,
      message: 'Drop-off ahead, 1.4 metres.',
      observedAt: Date.now(),
    }
    const fusedDrop = fuseSatnavGuidance(makeRoute(0), makeCorridor(), [headHazard, dropHazard], prefs)
    expect(fusedDrop.primaryHazard?.kind).toBe('drop-off')
    expect(fusedDrop.urgentHapticCue).toBe('drop-off')
    expect(fusedDrop.urgentSpatialCue?.elevationMeters).toBeLessThan(0)
  })

  test('supports free-roam corridor steering without an active route', () => {
    const narrow = makeCorridor({
      corridorState: 'narrow',
      forwardClearanceMeters: 1.4,
      recommendedHeadingOffsetDeg: -15,
    })
    const fused = fuseSatnavGuidance(undefined, narrow, [], prefs)
    expect(fused.steeringSource).toBe('corridor-explore')
    expect(fused.steeringOffsetDeg).toBe(-15)
    expect(fused.spatialBeacon.active).toBe(true)
    expect(fused.summary).toContain('Open corridor to your left')
  })
})
