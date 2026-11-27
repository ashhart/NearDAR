import { describe, expect, test } from 'bun:test'
import type { SceneSnapshot } from '../src/lib/guidance/types'
import {
  clearIndoorAnchors,
  computeIndoorGuidance,
  findIndoorAnchorByLabel,
  INDOOR_ANCHORS_STORAGE_KEY,
  listIndoorSpaces,
  loadIndoorAnchors,
  removeIndoorAnchor,
  saveIndoorAnchor,
  type IndoorAnchor,
  type IndoorStorageAdapter,
} from '../src/lib/navigation/indoor'
import { WalkingRouteTracker, type RouteProgress } from '../src/lib/navigation/tracker'
import { parseSatnavIntent } from '../src/lib/satnav/intents'
import {
  buildCrossingAssistantPrompt,
  buildDoorFinderPrompt,
  buildFindObjectPrompt,
  buildMobilitySkillPrompt,
  buildTransitPrompt,
  buildVividScenePrompt,
  classifyFindObjectTask,
  formatBusMatchAnnouncement,
  formatDoorFinderSuggestion,
  formatDoorTelemetryFallback,
  formatMobilitySkillOutput,
  matchWatchedBusNumber,
  normalizeBusNumber,
  sanitizeCrossingOutput,
  shouldAutoSuggestDoorFinder,
} from '../src/lib/satnav/modes'
import { StreetNarrator } from '../src/lib/satnav/narrator'
import {
  buildConversationalVisionPrompt,
  buildSatnavSystemPrompt,
  buildSatnavUserPrompt,
  DARK_LIGHTING_TELEMETRY_NOTE,
} from '../src/lib/satnav/prompts'

function makeSnapshot(overrides: Partial<SceneSnapshot> & Record<string, unknown> = {}): SceneSnapshot {
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
      forwardClearanceMeters: 4.0,
      bestClearanceMeters: 4.0,
      aimState: 'level',
      pitchDegrees: 0,
      valid: true,
    },
    hazards: [],
    notes: [],
    ...overrides,
  } as SceneSnapshot
}

function makeRouteProgress(remainingDistanceMeters: number, overrides: Partial<RouteProgress> = {}): RouteProgress {
  return {
    active: true,
    route: {
      id: 'route-test',
      destinationName: 'Costa Coffee',
      origin: { latitude: 51.5, longitude: -0.1 },
      destination: { latitude: 51.5002, longitude: -0.1 },
      distanceMeters: 40,
      expectedTravelTimeSeconds: 35,
      polyline: [
        { latitude: 51.5, longitude: -0.1 },
        { latitude: 51.5002, longitude: -0.1 },
      ],
      steps: [
        {
          instruction: 'Continue straight on High Street',
          distanceMeters: 40,
          coordinates: [
            { latitude: 51.5, longitude: -0.1 },
            { latitude: 51.5002, longitude: -0.1 },
          ],
        },
      ],
      source: 'mapkit',
      createdAt: Date.now(),
    },
    stepIndex: 0,
    currentStep: {
      instruction: 'Continue straight on High Street',
      distanceMeters: 40,
      coordinates: [
        { latitude: 51.5, longitude: -0.1 },
        { latitude: 51.5002, longitude: -0.1 },
      ],
    },
    distanceToNextTurnMeters: remainingDistanceMeters,
    remainingDistanceMeters,
    targetBearingDeg: 0,
    headingOffsetDeg: 4,
    crossTrackErrorMeters: 1,
    offRoute: false,
    arrived: false,
    ...overrides,
  }
}

function makeMemoryStorage(): IndoorStorageAdapter & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    async getItem(key: string) {
      return data.get(key) ?? null
    },
    async setItem(key: string, value: string) {
      data.set(key, value)
    },
    async removeItem(key: string) {
      data.delete(key)
    },
  }
}

describe('Door Finder assistant (Last 20 Metres)', () => {
  test('auto-suggests only within 2..25 metres of an active destination and respects standby', () => {
    const snap = makeSnapshot()
    expect(shouldAutoSuggestDoorFinder(undefined, snap)).toBe(false)
    expect(shouldAutoSuggestDoorFinder(makeRouteProgress(30), snap)).toBe(false)
    expect(shouldAutoSuggestDoorFinder(makeRouteProgress(25), snap)).toBe(true)
    expect(shouldAutoSuggestDoorFinder(makeRouteProgress(12), snap)).toBe(true)
    expect(shouldAutoSuggestDoorFinder(makeRouteProgress(2), snap)).toBe(true)
    expect(shouldAutoSuggestDoorFinder(makeRouteProgress(1.9), snap)).toBe(false)
    expect(shouldAutoSuggestDoorFinder(makeRouteProgress(10, { active: false, arrived: true }), snap)).toBe(false)
    expect(shouldAutoSuggestDoorFinder(makeRouteProgress(10), makeSnapshot({ aimState: 'lowered' }))).toBe(false)
    expect(shouldAutoSuggestDoorFinder(makeRouteProgress(10), makeSnapshot({ aimState: 'covered' }))).toBe(false)
  })

  test('fuses LiDAR openings, ARKit door mesh, and OCR shopfront text into Door Finder prompt', () => {
    const snap = makeSnapshot({
      corridor: {
        sectors: [],
        openings: [{ bearingDegrees: 28, direction: 'ahead-right', distanceMeters: 3.4, clearanceMeters: 2.8, widthDegrees: 22 }],
        recommendedHeadingOffsetDeg: 15,
        corridorState: 'clear',
        forwardClearanceMeters: 3.4,
        bestClearanceMeters: 4.0,
        aimState: 'level',
        pitchDegrees: 0,
        valid: true,
      },
      objects: [{ id: 'd1', label: 'door', confidence: 0.92, direction: 'ahead-right', clockSector: 1, distanceMeters: 3.5, evidence: [] }],
      recognizedText: ['COSTA COFFEE', 'PUSH', 'OPEN'],
    })

    const spec = buildDoorFinderPrompt('Costa Coffee', {
      snapshot: snap,
      directionStyle: 'clock',
      headingDeg: 45,
    })

    expect(spec.skill).toBe('door-finder')
    expect(spec.prompt).toContain('Costa Coffee')
    expect(spec.prompt).toContain("LiDAR opening 1 o'clock at 3.4m")
    expect(spec.prompt).toContain("ARKit door mesh 1 o'clock at 3.5m")
    expect(spec.prompt).toContain('COSTA COFFEE | PUSH | OPEN')
    expect(spec.prompt).toContain('push, pull, automatic sliding, or revolving')
    expect(spec.prompt).toContain('handle or push plate')
    expect(spec.prompt).toContain('entrance steps')

    const suggestion = formatDoorFinderSuggestion('Costa Coffee', 18, 0.65)
    expect(suggestion).toContain('Costa Coffee')
    expect(suggestion).toContain('find the door')

    const fallback = formatDoorTelemetryFallback('Costa Coffee', snap, 'clock', 0.65)
    expect(fallback).toContain("1 o'clock")
    expect(fallback).toContain('COSTA COFFEE')
  })
})

describe('Pedestrian Crossing Assistant', () => {
  test('builds safety-grounded prompt covering tactile paving, kerbs, button pole, layout, signals, and traffic', () => {
    const snap = makeSnapshot({
      hazards: [{
        id: 'h-kerb',
        kind: 'step-down',
        severity: 'caution',
        direction: 'ahead',
        bearingDegrees: 0,
        distanceMeters: 1.4,
        confidence: 0.85,
        message: 'Step down ahead, 1.4 metres.',
        observedAt: Date.now(),
      }],
    })
    const spec = buildCrossingAssistantPrompt({ snapshot: snap, directionStyle: 'natural' })
    expect(spec.skill).toBe('crossing')
    expect(spec.system).toMatch(/NEVER claim a road or crossing is safe to cross/i)
    expect(spec.prompt).toContain('tactile paving')
    expect(spec.prompt).toContain('dropped kerb edge')
    expect(spec.prompt).toContain('push-button box pole')
    expect(spec.prompt).toContain('zebra, pelican')
    expect(spec.prompt).toContain('traffic signal')
    expect(spec.prompt).toContain('approaching cyclists')
    expect(spec.prompt).toContain('step-down ahead at 1.4m')
  })

  test('strictly strips unsafe crossing guarantees during output sanitization', () => {
    const samples = [
      'Tactile paving is ahead and it is safe to cross now.',
      'The light is green, clear to cross.',
      'No cars visible so you can cross now.',
      'Go ahead and cross toward the island.',
      'It looks okay to cross.',
    ]
    for (const raw of samples) {
      const safe = formatMobilitySkillOutput('crossing', raw)
      expect(safe).not.toMatch(/safe to cross|clear to cross|you can cross|go ahead and cross|okay to cross/i)
      expect(safe).toMatch(/listen|check/i)
    }

    const layoutOnly = sanitizeCrossingOutput('Blister tactile paving ahead with the push-button pole at 2 o\'clock, 1.5 metres.')
    expect(layoutOnly).toBe("Blister tactile paving ahead with the push-button pole at 2 o'clock, 1.5 metres.")
  })
})

describe('Public Transit & Bus Number Watcher', () => {
  test('normalizes route codes and matches real bus displays while rejecting prices, years, volumes, and phone numbers', () => {
    expect(normalizeBusNumber('bus 73')).toBe('73')
    expect(normalizeBusNumber('route n73')).toBe('N73')
    expect(normalizeBusNumber('X12 please')).toBe('X12')

    // Positive matches
    expect(matchWatchedBusNumber(['73'], '73')).toBe('73')
    expect(matchWatchedBusNumber(['73 OXFORD CIRCUS'], '73')).toBe('73 OXFORD CIRCUS')
    expect(matchWatchedBusNumber(['BUS 73 Victoria'], 'bus 73')).toBe('BUS 73 Victoria')
    expect(matchWatchedBusNumber(['N73 Walthamstow Central'], 'n73')).toBe('N73 Walthamstow Central')
    expect(matchWatchedBusNumber(['Stop C', 'X12 Express'], 'X12')).toBe('X12 Express')
    expect(matchWatchedBusNumber(['Routes 73/476'], '73')).toBe('Routes 73/476')

    // False-positive resistance (prices, years, volumes, phone numbers, neighboring route codes)
    const falsePositives = [
      '£7.30',
      '$7.30',
      '€7.30',
      '£73',
      '£ 73',
      '1973',
      'EST 1973',
      '730ml',
      '73ml',
      '73 ml',
      '73kg',
      '0731234',
      '020 7312 4567',
      'Tel: 73',
      '73.50',
      '7:30',
      '73:00',
      '173',
      'N73',
      '73A',
      '73p',
      '73%',
      '73rd Street',
      '73 g',
    ]
    for (const sample of falsePositives) {
      expect(matchWatchedBusNumber([sample], '73')).toBeUndefined()
    }

    expect(formatBusMatchAnnouncement('73', '73 Victoria', 'ahead-left', 'clock')).toBe(
      "Bus 73 spotted 11 o'clock: 73 Victoria.",
    )
    expect(formatBusMatchAnnouncement('N73', 'N73')).toBe('Bus N73 spotted.')
  })

  test('builds transit prompt covering bus doors, platform edge, departure board, and open seats', () => {
    const snap = makeSnapshot({
      recognizedText: ['PLATFORM 2', '73 VICTORIA 2 MIN'],
      freeSeats: [{ id: 's1', label: 'seat', confidence: 0.9, direction: 'ahead-left', clockSector: 11, distanceMeters: 2.1, free: true, evidence: [] }],
    })
    const spec = buildTransitPrompt('73', { snapshot: snap, directionStyle: 'clock' })
    expect(spec.skill).toBe('transit')
    expect(spec.prompt).toContain('bus 73')
    expect(spec.prompt).toContain('bus door position')
    expect(spec.prompt).toContain('train platform edge')
    expect(spec.prompt).toContain('departure board')
    expect(spec.prompt).toContain('carriage doors and open seats')
    expect(spec.prompt).toContain("Detected open seats: 11 o'clock 2.1m")
  })
})

describe('Vivid Scene & Guided Find modes', () => {
  test('builds rich 3-to-4 sentence Vivid Scene prompt with wider token budget', () => {
    const spec = buildVividScenePrompt({
      snapshot: makeSnapshot({ recognizedText: ['REGENT PARK'] }),
      headingDeg: 180,
    })
    expect(spec.skill).toBe('vivid')
    expect(spec.system).toContain('3 to 4')
    expect(spec.system).toMatch(/scenery|architecture|greenery|atmosphere/i)
    expect(spec.maxTokens).toBeGreaterThanOrEqual(200)
    expect(spec.prompt).toContain('Facing south (180 deg)')
    expect(spec.prompt).toContain('REGENT PARK')
  })

  test('tailors Guided Find prompts for shelf items, expiry dates, banknotes, and menus/letters', () => {
    expect(classifyFindObjectTask('oat milk')).toBe('item')
    expect(classifyFindObjectTask('expiry date')).toBe('expiry')
    expect(classifyFindObjectTask('best before date')).toBe('expiry')
    expect(classifyFindObjectTask('banknote')).toBe('banknote')
    expect(classifyFindObjectTask('dinner menu')).toBe('reading')

    const shelf = buildFindObjectPrompt('oat milk', {
      snapshot: makeSnapshot({ recognizedText: ['OATLY', 'BARISTA'] }),
    })
    expect(shelf.prompt).toContain('oat milk')
    expect(shelf.prompt).toContain('shelf')
    expect(shelf.prompt).toContain('OATLY | BARISTA')

    const expiry = buildFindObjectPrompt('expiry date')
    expect(expiry.prompt).toMatch(/best-before|use-by|expiry/i)

    const note = buildFindObjectPrompt('banknote')
    expect(note.prompt).toMatch(/currency|denomination/i)

    const dispatched = buildMobilitySkillPrompt('find-object', {}, 'prescription label')
    expect(dispatched.prompt).toMatch(/read and summarize/i)
  })
})

describe('Conversational intent parser upgrades', () => {
  test('parses all 12 new everyday companion intents naturally', () => {
    // Door finder
    expect(parseSatnavIntent('Find the door')).toEqual({ kind: 'find-door' })
    expect(parseSatnavIntent('Where is the entrance?')).toEqual({ kind: 'find-door' })
    expect(parseSatnavIntent('Door finder')).toEqual({ kind: 'find-door' })

    // Crossing assistant
    expect(parseSatnavIntent('Help me cross')).toEqual({ kind: 'crossing-assist' })
    expect(parseSatnavIntent('Crossing mode')).toEqual({ kind: 'crossing-assist' })
    expect(parseSatnavIntent('Find the crossing button')).toEqual({ kind: 'crossing-assist' })
    expect(parseSatnavIntent('Where is the pedestrian button?')).toEqual({ kind: 'crossing-assist' })

    // Transit / bus watcher
    expect(parseSatnavIntent('Watch for bus 73')).toEqual({ kind: 'watch-bus', busNumber: '73' })
    expect(parseSatnavIntent('Look for the 24 bus')).toEqual({ kind: 'watch-bus', busNumber: '24' })
    expect(parseSatnavIntent('Watch for bus N73')).toEqual({ kind: 'watch-bus', busNumber: 'N73' })
    expect(parseSatnavIntent('Transit mode')).toEqual({ kind: 'watch-bus' })
    expect(parseSatnavIntent('Read the bus')).toEqual({ kind: 'watch-bus' })

    // Vivid scene
    expect(parseSatnavIntent('Describe the view')).toEqual({ kind: 'vivid-scene' })
    expect(parseSatnavIntent('Paint me the scene')).toEqual({ kind: 'vivid-scene' })
    expect(parseSatnavIntent('Describe the scenery')).toEqual({ kind: 'vivid-scene' })

    // Guided find / expiry / banknote
    expect(parseSatnavIntent('Help me find oat milk')).toEqual({ kind: 'find-object', target: 'oat milk' })
    expect(parseSatnavIntent('Check the expiry date')).toEqual({ kind: 'find-object', target: 'expiry date' })
    expect(parseSatnavIntent('What banknote is this?')).toEqual({ kind: 'find-object', target: 'banknote' })

    // Emergency handoff
    expect(parseSatnavIntent('Share my location')).toEqual({ kind: 'emergency-share' })
    expect(parseSatnavIntent('Send my location to my emergency contact')).toEqual({ kind: 'emergency-share' })
    expect(parseSatnavIntent('Text my location')).toEqual({ kind: 'emergency-share' })
    expect(parseSatnavIntent('Call my emergency contact')).toEqual({ kind: 'emergency-call' })
    expect(parseSatnavIntent('Call for help')).toEqual({ kind: 'emergency-call' })

    // Torch & Screen curtain
    expect(parseSatnavIntent('Turn on the torch')).toEqual({ kind: 'toggle-torch', enabled: true })
    expect(parseSatnavIntent('Flashlight on')).toEqual({ kind: 'toggle-torch', enabled: true })
    expect(parseSatnavIntent('Turn off the light')).toEqual({ kind: 'toggle-torch', enabled: false })
    expect(parseSatnavIntent('Toggle torch')).toEqual({ kind: 'toggle-torch' })

    expect(parseSatnavIntent('Screen curtain on')).toEqual({ kind: 'toggle-curtain', enabled: true })
    expect(parseSatnavIntent('Blackout screen')).toEqual({ kind: 'toggle-curtain', enabled: true })
    expect(parseSatnavIntent('Turn screen back on')).toEqual({ kind: 'toggle-curtain', enabled: false })
    expect(parseSatnavIntent('Screen curtain off')).toEqual({ kind: 'toggle-curtain', enabled: false })

    // Mobility profiles
    expect(parseSatnavIntent('White cane profile')).toEqual({ kind: 'set-profile', profile: 'cane' })
    expect(parseSatnavIntent('Guide dog mode')).toEqual({ kind: 'set-profile', profile: 'guide-dog' })
    expect(parseSatnavIntent('Low vision mode')).toEqual({ kind: 'set-profile', profile: 'low-vision' })
    expect(parseSatnavIntent('Standard profile')).toEqual({ kind: 'set-profile', profile: 'standard' })

    // Indoor waypoints
    expect(parseSatnavIntent('Remember this room as kitchen')).toEqual({ kind: 'indoor-save', name: 'kitchen' })
    expect(parseSatnavIntent('Save indoor spot as desk')).toEqual({ kind: 'indoor-save', name: 'desk' })
    expect(parseSatnavIntent('Guide me to the kitchen')).toEqual({ kind: 'indoor-guide', name: 'kitchen' })
    expect(parseSatnavIntent('Take me to my desk inside')).toEqual({ kind: 'indoor-guide', name: 'desk' })
  })

  test('preserves outdoor navigation, sign reading, and visual Q&A without false captures', () => {
    expect(parseSatnavIntent('Guide me to the nearest pharmacy please')).toEqual({
      kind: 'navigate-to',
      destination: 'the nearest pharmacy',
    })
    expect(parseSatnavIntent('Save this spot as Home')).toEqual({ kind: 'save-place', name: 'Home' })
    expect(parseSatnavIntent('Read that sign')).toEqual({ kind: 'read-text' })
    expect(parseSatnavIntent('Is there a doorway ahead?')).toEqual({
      kind: 'visual-question',
      question: 'Is there a doorway ahead?',
    })
    expect(parseSatnavIntent('Where am I?')).toEqual({ kind: 'location' })
    expect(parseSatnavIntent('Help')).toEqual({ kind: 'help' })
  })
})

describe('Lighting, thermal, and profile awareness in prompts & StreetNarrator', () => {
  test('injects honest dark-lighting telemetry note and profile hints into vision prompts', () => {
    const darkPrompt = buildSatnavUserPrompt('What is ahead?', {
      snapshot: makeSnapshot(),
      lightingState: 'dark',
      mobilityProfile: 'guide-dog',
      history: [],
    })
    expect(darkPrompt).toContain(DARK_LIGHTING_TELEMETRY_NOTE)
    expect(darkPrompt).toContain('guide dog')

    const darkFromSnapshot = buildConversationalVisionPrompt('What is ahead?', {
      snapshot: makeSnapshot({ lightingState: 'dark' }),
      mobilityProfile: 'cane',
      history: [],
    })
    expect(darkFromSnapshot).toContain(DARK_LIGHTING_TELEMETRY_NOTE)
    expect(darkFromSnapshot).toContain('white cane')

    expect(buildSatnavSystemPrompt('natural', 'guide-dog')).toContain('guide dog')
  })

  test('skips proactive VLM tasks when thermally throttled (proactiveVlmAllowed: false)', () => {
    const narrator = new StreetNarrator()
    const snap = makeSnapshot()

    const blockedExplore = narrator.planProactive({
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
      now: 20_000,
      proactiveVlmAllowed: false,
    })
    expect(blockedExplore).toBeUndefined()

    const blockedHazard = narrator.planHazardClassification(
      {
        id: 'obs-thermal',
        kind: 'obstacle',
        severity: 'caution',
        direction: 'ahead',
        distanceMeters: 1.8,
        message: 'Obstacle ahead.',
        observedAt: Date.now(),
      },
      {
        ambientObstacleNaming: true,
        engineReady: true,
        busy: false,
        listening: false,
        standby: false,
        now: 20_000,
        proactiveVlmAllowed: false,
      },
    )
    expect(blockedHazard).toBeUndefined()
  })

  test('pauses non-essential street-explore in dark lighting while keeping crossing lookahead honest', () => {
    const narrator = new StreetNarrator()
    const darkSnap = makeSnapshot({ lightingState: 'dark' })

    // Non-essential street-explore is paused in dark lighting
    const pausedExplore = narrator.planProactive({
      mode: 'explore',
      proactiveNarration: true,
      ambientObstacleNaming: true,
      engineReady: true,
      busy: false,
      listening: false,
      standby: false,
      snapshot: darkSnap,
      location: { latitude: 51.5, longitude: -0.1 },
      headingDeg: 0,
      directionStyle: 'natural',
      lastCriticalAt: 0,
      now: 40_000,
      lightingState: 'dark',
    })
    expect(pausedExplore).toBeUndefined()

    // Approaching a turn still gives a dark-honest crossing lookahead
    const tracker = new WalkingRouteTracker({
      id: 'r-dark',
      destinationName: 'Station',
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
        { instruction: 'Turn right onto Station Road', distanceMeters: 30, coordinates: [{ latitude: 51.50022, longitude: -0.1 }, { latitude: 51.50022, longitude: -0.0996 }] },
      ],
    })
    const progress = tracker.update({ latitude: 51.50011, longitude: -0.1 }, 0)
    const darkCrossing = narrator.planProactive({
      mode: 'satnav',
      proactiveNarration: true,
      ambientObstacleNaming: true,
      engineReady: true,
      busy: false,
      listening: false,
      standby: false,
      snapshot: darkSnap,
      route: progress,
      location: { latitude: 51.50011, longitude: -0.1 },
      headingDeg: 0,
      directionStyle: 'natural',
      lastCriticalAt: 0,
      now: 50_000,
      lightingState: 'dark',
    })
    expect(darkCrossing?.kind).toBe('crossing-lookahead')
    expect(darkCrossing?.prompt).toContain(DARK_LIGHTING_TELEMETRY_NOTE)
  })

  test('filters routine static hazard-classify for guide-dog profile unless path is blocked', () => {
    const narrator = new StreetNarrator()
    const staticWarning = {
      id: 'obs-static',
      kind: 'obstacle' as const,
      severity: 'caution' as const,
      direction: 'ahead' as const,
      distanceMeters: 1.9,
      message: 'Obstacle ahead.',
      observedAt: Date.now(),
    }

    // Narrow corridor: guide dog routes around static obstacle -> skip chatter
    const skipped = narrator.planHazardClassification(staticWarning, {
      ambientObstacleNaming: true,
      engineReady: true,
      busy: false,
      listening: false,
      standby: false,
      now: 10_000,
      mobilityProfile: 'guide-dog',
      corridorState: 'narrow',
    })
    expect(skipped).toBeUndefined()

    // Blocked corridor: handler needs to know why path is blocked -> classify!
    const allowedWhenBlocked = narrator.planHazardClassification(staticWarning, {
      ambientObstacleNaming: true,
      engineReady: true,
      busy: false,
      listening: false,
      standby: false,
      now: 12_000,
      mobilityProfile: 'guide-dog',
      corridorState: 'blocked',
    })
    expect(allowedWhenBlocked?.kind).toBe('hazard-classify')

    // Guide-dog explore prompt prioritizes crossings, doorways, and signs
    const explore = narrator.planProactive({
      mode: 'explore',
      proactiveNarration: true,
      ambientObstacleNaming: true,
      engineReady: true,
      busy: false,
      listening: false,
      standby: false,
      snapshot: makeSnapshot(),
      location: { latitude: 51.5, longitude: -0.1 },
      headingDeg: 0,
      directionStyle: 'natural',
      lastCriticalAt: 0,
      now: 25_000,
      mobilityProfile: 'guide-dog',
    })
    expect(explore?.kind).toBe('street-explore')
    expect(explore?.prompt).toMatch(/crossings, doorways, shopfront signs/i)
  })
})

describe('Offline Indoor Spatial Waypoints', () => {
  test('computes relative distance, calibrated steps, bearing offset, turn phrase, and arrival accurately', () => {
    const kitchenNorth: IndoorAnchor = {
      id: 'a-kitchen',
      spaceName: 'Home',
      label: 'Kitchen',
      x: 0,
      y: 0,
      z: -5.2,
      headingDeg: 0,
      createdAt: 1,
    }

    // Facing North (0 deg), target 5.2m North (-Z) -> straight ahead, 8 steps at 0.65m
    const ahead = computeIndoorGuidance({ x: 0, y: 0, z: 0, headingDeg: 0 }, kitchenNorth, 0.65)
    expect(ahead.distanceMeters).toBeCloseTo(5.2, 4)
    expect(ahead.steps).toBe(8)
    expect(ahead.targetBearingDeg).toBeCloseTo(0, 4)
    expect(ahead.bearingOffsetDeg).toBeCloseTo(0, 4)
    expect(ahead.clockDirection).toBe(12)
    expect(ahead.turnPhrase).toBe('straight ahead')
    expect(ahead.arrived).toBe(false)
    expect(ahead.spokenGuidance).toContain('Kitchen')

    // Target 3.25m East (+X) while facing North (0 deg) -> +90 deg turn right, 5 steps
    const deskEast: IndoorAnchor = {
      id: 'a-desk',
      spaceName: 'Home',
      label: 'Desk',
      x: 3.25,
      y: 0,
      z: 0,
      headingDeg: 90,
      createdAt: 2,
    }
    const right = computeIndoorGuidance({ x: 0, y: 0, z: 0, headingDeg: 0 }, deskEast, 0.65)
    expect(right.distanceMeters).toBeCloseTo(3.25, 4)
    expect(right.steps).toBe(5)
    expect(right.targetBearingDeg).toBeCloseTo(90, 4)
    expect(right.bearingOffsetDeg).toBeCloseTo(90, 4)
    expect(right.clockDirection).toBe(3)
    expect(right.turnPhrase).toBe('turn right')
    expect(right.arrived).toBe(false)

    // Same East target while facing South (180 deg) -> -90 deg turn left
    const left = computeIndoorGuidance({ x: 0, y: 0, z: 0, headingDeg: 180 }, deskEast, 0.65)
    expect(left.bearingOffsetDeg).toBeCloseTo(-90, 4)
    expect(left.clockDirection).toBe(9)
    expect(left.turnPhrase).toBe('turn left')

    // Target directly behind (+Z when facing North 0 deg) -> 180 deg turn around
    const behind = computeIndoorGuidance(
      { x: 0, y: 0, z: 0, headingDeg: 0 },
      { ...kitchenNorth, z: 3.9 },
      0.65,
    )
    expect(behind.bearingOffsetDeg).toBeCloseTo(180, 4)
    expect(behind.turnPhrase).toBe('turn around')

    // Heading wrap across 0/360: facing 350 deg, target due North-East at 10 deg -> +20 deg bear slightly right
    const rad10 = (10 * Math.PI) / 180
    const wrapAnchor: IndoorAnchor = {
      ...kitchenNorth,
      x: 4 * Math.sin(rad10),
      z: -4 * Math.cos(rad10),
    }
    const wrapped = computeIndoorGuidance({ x: 0, y: 0, z: 0, headingDeg: 350 }, wrapAnchor, 0.65)
    expect(wrapped.bearingOffsetDeg).toBeCloseTo(20, 1)
    expect(wrapped.turnPhrase).toBe('bear slightly right')

    // Arrival confirmation at <= 1.2m on the same floor
    const nearBoundary = computeIndoorGuidance({ x: 0, y: 0, z: -4.0, headingDeg: 0 }, kitchenNorth, 0.65)
    expect(nearBoundary.distanceMeters).toBeCloseTo(1.2, 4)
    expect(nearBoundary.arrived).toBe(true)
    expect(nearBoundary.spokenGuidance).toContain('arrived')

    const justOutside = computeIndoorGuidance({ x: 0, y: 0, z: -3.9, headingDeg: 0 }, kitchenNorth, 0.65)
    expect(justOutside.arrived).toBe(false)

    // Different floor (y delta >= 2m) does not falsely report arrival
    const upstairs = computeIndoorGuidance(
      { x: 0, y: 0, z: -5.0, headingDeg: 0 },
      { ...kitchenNorth, y: 3.0 },
      0.65,
    )
    expect(upstairs.arrived).toBe(false)
    expect(upstairs.spokenGuidance).toContain('upstairs')
  })

  test('persists, deduplicates, queries, and clears indoor anchors cleanly', async () => {
    const storage = makeMemoryStorage()

    const first = await saveIndoorAnchor(
      { spaceName: 'Home', label: 'Kitchen', x: 1, y: 0, z: -4, headingDeg: 370 },
      storage,
    )
    expect(first).toHaveLength(1)
    expect(first[0]!.headingDeg).toBe(10)
    expect(storage.data.has(INDOOR_ANCHORS_STORAGE_KEY)).toBe(true)

    await saveIndoorAnchor(
      { spaceName: 'Home', label: 'Desk', x: 3, y: 0, z: -1, headingDeg: 90 },
      storage,
    )
    await saveIndoorAnchor(
      { spaceName: 'Office', label: 'Desk', x: 8, y: 0, z: -2, headingDeg: 180 },
      storage,
    )
    // Updating existing (Home, Kitchen) replaces instead of duplicating
    const updated = await saveIndoorAnchor(
      { spaceName: 'Home', label: 'kitchen', x: 1.5, y: 0, z: -4.2, headingDeg: 0 },
      storage,
    )
    expect(updated).toHaveLength(3)
    expect(listIndoorSpaces(updated)).toEqual(['Home', 'Office'])

    const loaded = await loadIndoorAnchors(storage)
    expect(loaded).toHaveLength(3)
    expect(findIndoorAnchorByLabel(loaded, 'kitchen', 'Home')?.x).toBe(1.5)
    expect(findIndoorAnchorByLabel(loaded, 'desk', 'Office')?.x).toBe(8)

    const afterRemove = await removeIndoorAnchor(loaded[0]!.id, storage)
    expect(afterRemove).toHaveLength(2)

    const afterClearHome = await clearIndoorAnchors('Home', storage)
    expect(afterClearHome).toHaveLength(1)
    expect(afterClearHome[0]!.spaceName).toBe('Office')

    const afterClearAll = await clearIndoorAnchors(undefined, storage)
    expect(afterClearAll).toEqual([])

    // Corrupt storage recovers gracefully
    await storage.setItem(INDOOR_ANCHORS_STORAGE_KEY, '{bad json')
    expect(await loadIndoorAnchors(storage)).toEqual([])
  })
})
