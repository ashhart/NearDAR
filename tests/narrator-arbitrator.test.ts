import { describe, expect, test } from 'bun:test'
import {
  detectLivePresence,
  extractLiveEntityChips,
  formatDirectionFromBearing,
  formatHazardCallout,
  SpeechArbitrator,
} from '../src/lib/satnav/arbitrator'
import { formatNarrationOutput, StreetNarrator } from '../src/lib/satnav/narrator'
import { parseSatnavIntent } from '../src/lib/satnav/intents'
import { fuseSatnavGuidance } from '../src/lib/navigation/fusion'
import { WalkingRouteTracker } from '../src/lib/navigation/tracker'
import type { SceneSnapshot } from '../src/lib/guidance/types'

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

describe('SpeechArbitrator priority & preemption', () => {
  test('P0 critical preempts P3 ambient, evicts queued ambient, and silences ambient for 3s', () => {
    const arb = new SpeechArbitrator()
    const t0 = 10_000

    const amb1 = arb.submit({ text: 'Cafe on your left.', tier: 'ambient', category: 'explore', cooldownMs: 5_000 }, t0)
    expect(amb1.action).toBe('speak-now')
    expect(arb.activeTier()).toBe('ambient')

    const crit = arb.submit({ text: 'Fast movement, 11 o\'clock, 3.0 metres — hold still.', tier: 'critical' }, t0 + 400)
    expect(crit.action).toBe('speak-now')
    expect(crit.preemptCurrent).toBe(true)
    expect(arb.activeTier()).toBe('critical')

    // Finish P0, then attempt ambient within 3s grace window -> must be dropped
    expect(arb.onFinished()).toBeUndefined()
    const blockedAmbient = arb.submit({ text: 'Shop doorway ahead.', tier: 'ambient' }, t0 + 1_500)
    expect(blockedAmbient.action).toBe('dropped')

    // After 3s grace window -> ambient allowed again
    const allowedAmbient = arb.submit({ text: 'Shop doorway ahead.', tier: 'ambient' }, t0 + 4_000)
    expect(allowedAmbient.action).toBe('speak-now')
  })

  test('P0 critical speaks even while listening; non-critical drops while listening', () => {
    const arb = new SpeechArbitrator()
    arb.setListening(true)
    expect(arb.submit({ text: 'Turn left in 20 metres.', tier: 'navigation' }, 10_000).action).toBe('dropped')
    expect(arb.submit({ text: 'Dog ahead left.', tier: 'ambient' }, 10_000).action).toBe('dropped')
    expect(arb.submit({ text: 'Drop-off ahead, 1.2 metres — stop.', tier: 'critical' }, 10_000).action).toBe('speak-now')
  })

  test('enforces per-category cooldowns', () => {
    const arb = new SpeechArbitrator()
    expect(arb.submit({ text: 'Dog ahead left.', tier: 'ambient', category: 'animal:dog', cooldownMs: 9_000 }, 20_000).action).toBe('speak-now')
    arb.onFinished()
    expect(arb.submit({ text: 'Dog ahead left.', tier: 'ambient', category: 'animal:dog', cooldownMs: 9_000 }, 24_000).action).toBe('dropped')
    expect(arb.submit({ text: 'Dog ahead left.', tier: 'ambient', category: 'animal:dog', cooldownMs: 9_000 }, 30_000).action).toBe('speak-now')
  })
})

describe('Clock-face phrasing, O&M hazard callouts, and live presence', () => {
  test('formats bearings in natural and clock-face styles accurately', () => {
    expect(formatDirectionFromBearing(0, 'clock')).toBe("12 o'clock")
    expect(formatDirectionFromBearing(-30, 'clock')).toBe("11 o'clock")
    expect(formatDirectionFromBearing(60, 'clock')).toBe("2 o'clock")
    expect(formatDirectionFromBearing(-90, 'clock')).toBe("9 o'clock")
    expect(formatDirectionFromBearing(-25, 'natural')).toBe('ahead left')
    expect(formatDirectionFromBearing(75, 'natural')).toBe('to your right')
  })

  test('formats fast-mover hazard in concise O&M radio brevity', () => {
    const msg = formatHazardCallout(
      {
        id: 'lidar-fast-mover',
        kind: 'fast-mover',
        severity: 'urgent',
        direction: 'ahead-left',
        bearingDegrees: -30,
        distanceMeters: 3.2,
        confidence: 0.9,
        message: 'Fast movement ahead left, 3.2 metres — hold still.',
        observedAt: Date.now(),
        closingSpeedMps: 4.1,
        externalSpeedMps: 3.8,
        ttcSeconds: 0.78,
      },
      'clock',
    )
    expect(msg).toBe("Fast movement, 11 o'clock, 3 metres — hold still.")
  })

  test('detects dogs, crowds, openings, and HUD chips while respecting standby', () => {
    const dogSnap = makeSnapshot({
      objects: [
        { id: 'p1', label: 'person', confidence: 0.9, direction: 'ahead-right', clockSector: 1, distanceMeters: 2.8, evidence: [] },
        { id: 'a1', label: 'dog', confidence: 0.85, direction: 'ahead-left', clockSector: 11, distanceMeters: 1.9, evidence: [] },
      ],
    })
    const petPresence = detectLivePresence(dogSnap, 'clock')
    expect(petPresence?.kind).toBe('animal')
    expect(petPresence?.message).toContain("Dog, 11 o'clock")

    const chips = extractLiveEntityChips(dogSnap)
    expect(chips.some((c) => c.label.startsWith('Dog'))).toBe(true)
    expect(chips.some((c) => c.label.startsWith('Person'))).toBe(true)

    const crowdSnap = makeSnapshot({
      objects: [
        { id: 'p1', label: 'person', confidence: 0.9, direction: 'ahead', distanceMeters: 2.1, evidence: [] },
        { id: 'p2', label: 'person', confidence: 0.9, direction: 'ahead-left', distanceMeters: 2.5, evidence: [] },
        { id: 'p3', label: 'person', confidence: 0.9, direction: 'ahead-right', distanceMeters: 3.0, evidence: [] },
      ],
    })
    expect(detectLivePresence(crowdSnap, 'natural')?.kind).toBe('crowd')

    const standbySnap = makeSnapshot({ aimState: 'lowered', objects: dogSnap.objects })
    expect(detectLivePresence(standbySnap, 'natural')).toBeUndefined()
    expect(extractLiveEntityChips(standbySnap)[0]?.label).toBe('Standby')
  })
})

describe('Proactive StreetNarrator & orient-me recovery', () => {
  test('plans roadworks/pushbike hazard classification and formats actionable phrasing', () => {
    const narrator = new StreetNarrator()
    const task = narrator.planHazardClassification(
      {
        id: 'obs-1',
        kind: 'obstacle',
        severity: 'caution',
        direction: 'ahead',
        distanceMeters: 2.0,
        message: 'Obstacle ahead, 2.0 metres.',
        observedAt: Date.now(),
      },
      { ambientObstacleNaming: true, engineReady: true, busy: false, listening: false, standby: false, now: 10_000 },
    )
    expect(task?.kind).toBe('hazard-classify')
    expect(task?.prompt).toContain('roadworks barrier')
    expect(task?.prompt).toContain('pushbike')

    const roadworks = formatNarrationOutput(task!, 'It is a roadworks barrier.', {
      directionStyle: 'natural',
      recommendedHeadingOffsetDeg: 30,
      corridorState: 'narrow',
    })
    expect(roadworks).toBe('Roadworks barrier, ahead, 2 metres — pass right.')

    const cyclist = formatNarrationOutput(task!, 'cyclist', {
      directionStyle: 'clock',
      recommendedHeadingOffsetDeg: -15,
      corridorState: 'narrow',
    })
    expect(cyclist).toBe("Cyclist, 12 o'clock, 2 metres — hold still.")
  })

  test('triggers crossing lookahead near turns and avoids repeating explore narration while stationary', () => {
    const narrator = new StreetNarrator()
    const tracker = new WalkingRouteTracker({
      id: 'r1',
      destinationName: 'Bakery',
      origin: { latitude: 51.5, longitude: -0.1 },
      destination: { latitude: 51.5005, longitude: -0.1 },
      distanceMeters: 55,
      expectedTravelTimeSeconds: 45,
      source: 'mapkit',
      createdAt: Date.now(),
      polyline: [
        { latitude: 51.5, longitude: -0.1 },
        { latitude: 51.50022, longitude: -0.1 },
        { latitude: 51.50022, longitude: -0.0996 },
      ],
      steps: [
        { instruction: 'Head north', distanceMeters: 25, coordinates: [{ latitude: 51.5, longitude: -0.1 }, { latitude: 51.50022, longitude: -0.1 }] },
        { instruction: 'Turn right onto Market Lane', distanceMeters: 30, coordinates: [{ latitude: 51.50022, longitude: -0.1 }, { latitude: 51.50022, longitude: -0.0996 }] },
      ],
    })
    // Stand ~12m before the turn
    const progress = tracker.update({ latitude: 51.50011, longitude: -0.1 }, 0)
    const snap = makeSnapshot()
    const crossing = narrator.planProactive({
      mode: 'satnav',
      proactiveNarration: true,
      ambientObstacleNaming: true,
      engineReady: true,
      busy: false,
      listening: false,
      standby: false,
      snapshot: snap,
      route: progress,
      location: { latitude: 51.50011, longitude: -0.1 },
      headingDeg: 0,
      directionStyle: 'natural',
      lastCriticalAt: 0,
      now: 50_000,
    })
    expect(crossing?.kind).toBe('crossing-lookahead')

    // Explore mode fires once initially, then stays quiet while stationary, then fires after 60 deg turn
    const exploreNarrator = new StreetNarrator()
    const first = exploreNarrator.planProactive({
      mode: 'explore',
      proactiveNarration: true,
      ambientObstacleNaming: true,
      engineReady: true,
      busy: false,
      listening: false,
      standby: false,
      snapshot: snap,
      location: { latitude: 51.5, longitude: -0.1 },
      headingDeg: 0,
      directionStyle: 'natural',
      lastCriticalAt: 0,
      now: 100_000,
    })
    expect(first?.kind).toBe('street-explore')

    const stationary = exploreNarrator.planProactive({
      mode: 'explore',
      proactiveNarration: true,
      ambientObstacleNaming: true,
      engineReady: true,
      busy: false,
      listening: false,
      standby: false,
      snapshot: snap,
      location: { latitude: 51.5, longitude: -0.1 },
      headingDeg: 5,
      directionStyle: 'natural',
      lastCriticalAt: 0,
      now: 130_000,
    })
    expect(stationary).toBeUndefined()

    const turned = exploreNarrator.planProactive({
      mode: 'explore',
      proactiveNarration: true,
      ambientObstacleNaming: true,
      engineReady: true,
      busy: false,
      listening: false,
      standby: false,
      snapshot: snap,
      location: { latitude: 51.5, longitude: -0.1 },
      headingDeg: 70,
      directionStyle: 'natural',
      lastCriticalAt: 0,
      now: 135_000,
    })
    expect(turned?.kind).toBe('street-explore')
  })

  test('parses orient-me recovery phrases and fuses standby + fast-mover safely', () => {
    expect(parseSatnavIntent("I'm lost")).toEqual({ kind: 'orient-me' })
    expect(parseSatnavIntent("Help, I'm lost")).toEqual({ kind: 'orient-me' })
    expect(parseSatnavIntent('Orient me please')).toEqual({ kind: 'orient-me' })
    expect(parseSatnavIntent('Help me get my bearings')).toEqual({ kind: 'orient-me' })

    const fastFused = fuseSatnavGuidance(
      undefined,
      makeSnapshot().corridor,
      [{
        id: 'lidar-fast-mover',
        kind: 'fast-mover',
        severity: 'urgent',
        direction: 'ahead-left',
        bearingDegrees: -25,
        distanceMeters: 2.8,
        confidence: 0.9,
        message: 'Fast movement ahead left, 2.8 metres — hold still.',
        observedAt: Date.now(),
        closingSpeedMps: 4.5,
      }],
      { hapticSteering: true, hapticProximity: true, spatialBeacon: true, beaconHeadphonesOnly: true },
    )
    expect(fastFused.urgentHapticCue).toBe('fast-mover')
    expect(fastFused.urgentSpatialCue?.kind).toBe('fast-mover')

    const standbyFused = fuseSatnavGuidance(
      undefined,
      { ...makeSnapshot().corridor!, aimState: 'lowered', valid: false },
      [{
        id: 'lidar-drop-off',
        kind: 'drop-off',
        severity: 'urgent',
        direction: 'ahead',
        bearingDegrees: 0,
        distanceMeters: 1.0,
        confidence: 0.8,
        message: 'Drop-off ahead.',
        observedAt: Date.now(),
      }],
      { hapticSteering: true, hapticProximity: true, spatialBeacon: true, beaconHeadphonesOnly: true },
    )
    expect(standbyFused.standby).toBe(true)
    expect(standbyFused.primaryHazard).toBeUndefined()
    expect(standbyFused.hapticState.proximityEnabled).toBe(false)
  })
})
