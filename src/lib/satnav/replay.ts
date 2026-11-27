import type {
  CorridorSector,
  CorridorSummary,
  DepthSource,
  LightingState,
  SceneObject,
  SceneSnapshot,
  SpatialHazard,
  ThermalState,
} from '../../../modules/tensorfold-perception/src'
import type { HapticCue } from '../../../modules/tensorfold-haptics/src'
import { fuseSatnavGuidance, type FusedSatnavGuidance, type FusionPreferences } from '../navigation/fusion'
import type { RouteProgress } from '../navigation/tracker'
import { detectLivePresence, type LivePresenceEvent } from './arbitrator'

export type ReplayTriggerKind =
  | 'fast-mover'
  | 'drop-off'
  | 'head-height'
  | 'corridor-detour'
  | 'animal'
  | 'obstacle'
  | 'none'

export interface ReplayExpectation {
  expectAlert: boolean
  expectedKind?: Exclude<ReplayTriggerKind, 'none'>
  expectedHapticCue?: HapticCue
  expectedDetourDirection?: 'left' | 'right'
  eventOnsetMs?: number
  maxReactionTimeMs?: number
  minPrecision?: number
  minRecall?: number
  requireDarkLidar?: boolean
}

export interface ReplayFrame {
  timestampMs: number
  route?: RouteProgress
  snapshot: SceneSnapshot
  groundTruthActive: boolean
}

export interface ReplayScenario {
  id: string
  name: string
  description: string
  prefs?: Partial<FusionPreferences>
  expectation: ReplayExpectation
  frames: ReplayFrame[]
}

export interface ReplayFrameEvaluation {
  timestampMs: number
  groundTruthActive: boolean
  triggered: boolean
  triggerKind: ReplayTriggerKind
  activeSignals: ReplayTriggerKind[]
  matchedExpected: boolean
  fused: FusedSatnavGuidance
  presence?: LivePresenceEvent
}

export interface ScenarioReplayResult {
  scenarioId: string
  scenarioName: string
  passed: boolean
  failures: string[]
  truePositives: number
  falsePositives: number
  falseNegatives: number
  trueNegatives: number
  precision: number
  recall: number
  reactionTimeMs: number | null
  framesEvaluated: number
  frameResults: ReplayFrameEvaluation[]
}

export interface ReplayBenchmarkSummary {
  passed: boolean
  scenarioCount: number
  passedCount: number
  overallPrecision: number
  overallRecall: number
  maxReactionTimeMs: number
  meanReactionTimeMs: number
  falseAlarmCount: number
  results: ScenarioReplayResult[]
}

const DEFAULT_PREFS: FusionPreferences = {
  hapticSteering: true,
  hapticProximity: true,
  spatialBeacon: true,
  beaconHeadphonesOnly: true,
}

const SECTOR_CENTERS = [-45, -30, -15, 0, 15, 30, 45] as const
const SECTOR_LABELS = ['far-left', 'left', 'ahead-left', 'ahead', 'ahead-right', 'right', 'far-right'] as const

export function makeSectorProfile(clearances: readonly number[], confidence = 0.9): CorridorSector[] {
  return SECTOR_CENTERS.map((centerDegrees, index) => ({
    index,
    centerDegrees,
    label: SECTOR_LABELS[index]!,
    clearanceMeters: clearances[index] ?? 4.2,
    sampleCount: 18,
    confidence,
  }))
}

export function makeReplayCorridor(overrides: Partial<CorridorSummary> = {}): CorridorSummary {
  return {
    sectors: makeSectorProfile([4.4, 4.4, 4.4, 4.4, 4.4, 4.4, 4.4]),
    openings: [],
    recommendedHeadingOffsetDeg: 0,
    corridorState: 'clear',
    forwardClearanceMeters: 4.4,
    bestClearanceMeters: 4.4,
    aimState: 'level',
    pitchDegrees: -6,
    headingDegrees: 0,
    floorHeightMeters: 0,
    maxClosingSpeedMps: 0,
    recedingObstacle: false,
    valid: true,
    ...overrides,
  }
}

export function makeReplayRoute(headingOffsetDeg = 0, destinationName = 'High Street Station'): RouteProgress {
  return {
    active: true,
    route: {
      id: 'replay-route-1',
      destinationName,
      origin: { latitude: 51.5074, longitude: -0.1278 },
      destination: { latitude: 51.5094, longitude: -0.1278 },
      distanceMeters: 220,
      expectedTravelTimeSeconds: 180,
      polyline: [
        { latitude: 51.5074, longitude: -0.1278 },
        { latitude: 51.5094, longitude: -0.1278 },
      ],
      steps: [
        {
          instruction: 'Walk straight along High Street',
          distanceMeters: 220,
          coordinates: [
            { latitude: 51.5074, longitude: -0.1278 },
            { latitude: 51.5094, longitude: -0.1278 },
          ],
        },
      ],
      source: 'mapkit',
      createdAt: 1_700_000_000_000,
    },
    stepIndex: 0,
    currentStep: {
      instruction: 'Walk straight along High Street',
      distanceMeters: 220,
      coordinates: [],
    },
    distanceToNextTurnMeters: 45,
    remainingDistanceMeters: 220,
    targetBearingDeg: 0,
    headingOffsetDeg,
    crossTrackErrorMeters: 0.8,
    offRoute: false,
    arrived: false,
  }
}

export function makeReplaySnapshot(
  timestampMs: number,
  sequence: number,
  overrides: Omit<Partial<SceneSnapshot>, 'corridor'> & {
    corridor?: Partial<CorridorSummary>
    depthSource?: DepthSource
    thermalState?: ThermalState
    lightingState?: LightingState
    ambientLuma?: number
  } = {},
): SceneSnapshot {
  const { corridor: corridorOverrides, ...rest } = overrides
  const corridor = makeReplayCorridor(corridorOverrides)
  return {
    observedAt: timestampMs,
    sequence,
    trackingReady: true,
    depthState: 'ready',
    depthSource: 'lidar',
    thermalState: 'nominal',
    proactiveVlmAllowed: true,
    lightingState: 'good',
    ambientLuma: 0.62,
    validDepthFraction: 0.92,
    cameraOrientation: 'camera-forward',
    objects: [],
    freeSeats: [],
    recognizedText: [],
    aimState: corridor.aimState,
    pitchDegrees: corridor.pitchDegrees,
    headingDegrees: corridor.headingDegrees,
    corridor,
    hazards: [],
    notes: [],
    ...rest,
  }
}

function classifyFrameSignals(
  fused: FusedSatnavGuidance,
  presence: LivePresenceEvent | undefined,
): { triggerKind: ReplayTriggerKind; activeSignals: ReplayTriggerKind[] } {
  const signals: ReplayTriggerKind[] = []

  if (fused.primaryHazard?.kind === 'fast-mover' && fused.urgentHapticCue === 'fast-mover') {
    signals.push('fast-mover')
  }
  if (
    (fused.primaryHazard?.kind === 'drop-off' || fused.primaryHazard?.kind === 'step-down') &&
    fused.urgentHapticCue === 'drop-off'
  ) {
    signals.push('drop-off')
  }
  if (fused.primaryHazard?.kind === 'head-height' && fused.urgentHapticCue === 'head-hazard') {
    signals.push('head-height')
  }
  if (fused.steeringSource === 'corridor-detour') {
    signals.push('corridor-detour')
  }
  if (presence?.kind === 'animal') {
    signals.push('animal')
  }
  if (
    fused.primaryHazard?.kind === 'obstacle' &&
    (fused.primaryHazard.severity === 'urgent' || fused.primaryHazard.severity === 'caution')
  ) {
    signals.push('obstacle')
  }

  return {
    triggerKind: signals[0] ?? 'none',
    activeSignals: signals,
  }
}

export function evaluateReplayScenario(scenario: ReplayScenario): ScenarioReplayResult {
  const prefs: FusionPreferences = { ...DEFAULT_PREFS, ...scenario.prefs }
  const { expectation } = scenario
  const frameResults: ReplayFrameEvaluation[] = []

  let truePositives = 0
  let falsePositives = 0
  let falseNegatives = 0
  let trueNegatives = 0
  let firstMatchedMs: number | null = null
  let observedExpectedHaptic = false
  let observedExpectedDetourDir = false

  for (const frame of scenario.frames) {
    const fused = fuseSatnavGuidance(frame.route, frame.snapshot.corridor, frame.snapshot.hazards, prefs)
    const presence = detectLivePresence(frame.snapshot, 'natural', 0.72)
    const { triggerKind, activeSignals } = classifyFrameSignals(fused, presence)
    const triggered = activeSignals.length > 0

    const matchedExpected = frame.groundTruthActive
      ? expectation.expectedKind
        ? activeSignals.includes(expectation.expectedKind)
        : triggered
      : false

    if (frame.groundTruthActive) {
      if (matchedExpected) {
        truePositives += 1
        if (firstMatchedMs === null) firstMatchedMs = frame.timestampMs
        if (expectation.expectedHapticCue && fused.urgentHapticCue === expectation.expectedHapticCue) {
          observedExpectedHaptic = true
        }
        if (expectation.expectedDetourDirection && fused.steeringOffsetDeg !== undefined) {
          if (
            (expectation.expectedDetourDirection === 'left' && fused.steeringOffsetDeg <= -15) ||
            (expectation.expectedDetourDirection === 'right' && fused.steeringOffsetDeg >= 15)
          ) {
            observedExpectedDetourDir = true
          }
        }
      } else {
        falseNegatives += 1
      }
    } else if (triggered) {
      falsePositives += 1
    } else {
      trueNegatives += 1
    }

    frameResults.push({
      timestampMs: frame.timestampMs,
      groundTruthActive: frame.groundTruthActive,
      triggered,
      triggerKind,
      activeSignals,
      matchedExpected,
      fused,
      presence,
    })
  }

  const precision = truePositives + falsePositives === 0 ? 1.0 : truePositives / (truePositives + falsePositives)
  const recall = truePositives + falseNegatives === 0 ? 1.0 : truePositives / (truePositives + falseNegatives)

  const inferredOnset =
    expectation.eventOnsetMs ?? scenario.frames.find((f) => f.groundTruthActive)?.timestampMs ?? null
  const reactionTimeMs =
    expectation.expectAlert && firstMatchedMs !== null && inferredOnset !== null
      ? Math.max(0, firstMatchedMs - inferredOnset)
      : null

  const failures: string[] = []
  const minPrecision = expectation.minPrecision ?? 1.0
  const minRecall = expectation.minRecall ?? 1.0

  if (precision < minPrecision) {
    failures.push(`Precision ${precision.toFixed(2)} below minimum ${minPrecision.toFixed(2)} (FP=${falsePositives}).`)
  }
  if (expectation.expectAlert) {
    if (recall < minRecall) {
      failures.push(`Recall ${recall.toFixed(2)} below minimum ${minRecall.toFixed(2)} (FN=${falseNegatives}).`)
    }
    if (reactionTimeMs === null) {
      failures.push('Expected alert never fired during active ground-truth window.')
    } else if (expectation.maxReactionTimeMs !== undefined && reactionTimeMs > expectation.maxReactionTimeMs) {
      failures.push(`Reaction time ${reactionTimeMs}ms exceeded budget ${expectation.maxReactionTimeMs}ms.`)
    }
    if (expectation.expectedHapticCue && !observedExpectedHaptic) {
      failures.push(`Expected urgent haptic cue '${expectation.expectedHapticCue}' was never triggered.`)
    }
    if (expectation.expectedDetourDirection && !observedExpectedDetourDir) {
      failures.push(`Expected corridor detour '${expectation.expectedDetourDirection}' was never produced.`)
    }
  } else if (falsePositives > 0) {
    failures.push(`Expected zero false alarms, but got ${falsePositives}.`)
  }

  if (expectation.requireDarkLidar) {
    const allDarkLidar = scenario.frames.every(
      (f) => f.snapshot.lightingState === 'dark' && (f.snapshot.ambientLuma ?? 1) < 0.14 && f.snapshot.depthSource === 'lidar',
    )
    if (!allDarkLidar) {
      failures.push('Dark night scenario frames must remain dark (luma < 0.14) with LiDAR depth active.')
    }
  }

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    passed: failures.length === 0,
    failures,
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives,
    precision,
    recall,
    reactionTimeMs,
    framesEvaluated: scenario.frames.length,
    frameResults,
  }
}

export function runStreetWalkReplayBenchmark(
  scenarios: ReplayScenario[] = BUILT_IN_STREET_WALK_SCENARIOS,
): ReplayBenchmarkSummary {
  const results = scenarios.map(evaluateReplayScenario)
  const totalTP = results.reduce((sum, r) => sum + r.truePositives, 0)
  const totalFP = results.reduce((sum, r) => sum + r.falsePositives, 0)
  const totalFN = results.reduce((sum, r) => sum + r.falseNegatives, 0)
  const reactionTimes = results.map((r) => r.reactionTimeMs).filter((ms): ms is number => ms !== null)

  const overallPrecision = totalTP + totalFP === 0 ? 1.0 : totalTP / (totalTP + totalFP)
  const overallRecall = totalTP + totalFN === 0 ? 1.0 : totalTP / (totalTP + totalFN)
  const maxReactionTimeMs = reactionTimes.length ? Math.max(...reactionTimes) : 0
  const meanReactionTimeMs = reactionTimes.length
    ? reactionTimes.reduce((sum, ms) => sum + ms, 0) / reactionTimes.length
    : 0
  const passedCount = results.filter((r) => r.passed).length

  return {
    passed: passedCount === results.length,
    scenarioCount: results.length,
    passedCount,
    overallPrecision,
    overallRecall,
    maxReactionTimeMs,
    meanReactionTimeMs,
    falseAlarmCount: totalFP,
    results,
  }
}

// --- Built-in deterministic multi-frame Street Walk scenarios ---

function buildCyclistFastApproachScenario(): ReplayScenario {
  const route = makeReplayRoute(3, 'Park Entrance')
  const frames: ReplayFrame[] = []
  const stepMs = 120
  const distances = [4.4, 4.4, 4.4, 4.4, 3.4, 2.9, 2.4, 1.9, 1.4, 4.4, 4.4, 4.4]

  for (let i = 0; i < distances.length; i++) {
    const t = i * stepMs
    const dist = distances[i]!
    const active = i >= 4 && i <= 8
    const hazards: SpatialHazard[] = active
      ? [
          {
            id: 'lidar-fast-mover',
            kind: 'fast-mover',
            severity: 'urgent',
            direction: 'ahead-left',
            bearingDegrees: -20,
            distanceMeters: dist,
            confidence: 0.91,
            message: `Fast movement ahead left, ${dist.toFixed(1)} metres — hold still.`,
            observedAt: t,
            closingSpeedMps: 4.2,
            externalSpeedMps: 4.0,
            ttcSeconds: dist / 4.2,
          },
        ]
      : []

    frames.push({
      timestampMs: t,
      route,
      groundTruthActive: active,
      snapshot: makeReplaySnapshot(t, i + 1, {
        corridor: {
          sectors: makeSectorProfile([4.4, 4.4, dist, 4.4, 4.4, 4.4, 4.4]),
          maxClosingSpeedMps: active ? 4.2 : 0,
        },
        hazards,
      }),
    })
  }

  return {
    id: 'cyclist-fast-approach',
    name: 'Cyclist Fast Approach',
    description: 'Pavement cyclist closes from 3.4m to 1.4m at 4.2 m/s ahead-left; must fire urgent fast-mover alert immediately.',
    expectation: {
      expectAlert: true,
      expectedKind: 'fast-mover',
      expectedHapticCue: 'fast-mover',
      eventOnsetMs: 4 * stepMs,
      maxReactionTimeMs: 120,
      minPrecision: 1.0,
      minRecall: 1.0,
    },
    frames,
  }
}

function buildRoadworksDetourScenario(): ReplayScenario {
  const route = makeReplayRoute(4, 'City Library')
  const frames: ReplayFrame[] = []
  const stepMs = 120

  for (let i = 0; i < 12; i++) {
    const t = i * stepMs
    const blockedLeftCenter = i >= 4 && i <= 9
    const clearances = blockedLeftCenter ? [1.1, 1.1, 1.2, 1.35, 2.8, 4.1, 4.3] : [4.3, 4.3, 4.3, 4.3, 4.3, 4.3, 4.3]
    const hazards: SpatialHazard[] = blockedLeftCenter
      ? [
          {
            id: 'lidar-corridor-obstacle',
            kind: 'obstacle',
            severity: 'caution',
            direction: 'ahead',
            bearingDegrees: 0,
            distanceMeters: 1.35,
            confidence: 0.88,
            message: 'Obstacle ahead, 1.4 metres. Open space to your right.',
            observedAt: t,
          },
        ]
      : []

    frames.push({
      timestampMs: t,
      route,
      groundTruthActive: blockedLeftCenter,
      snapshot: makeReplaySnapshot(t, i + 1, {
        corridor: {
          sectors: makeSectorProfile(clearances),
          corridorState: blockedLeftCenter ? 'narrow' : 'clear',
          forwardClearanceMeters: blockedLeftCenter ? 1.35 : 4.3,
          bestClearanceMeters: blockedLeftCenter ? 3.8 : 4.3,
          recommendedHeadingOffsetDeg: blockedLeftCenter ? 30 : 0,
        },
        hazards,
      }),
    })
  }

  return {
    id: 'roadworks-detour',
    name: 'Roadworks Barrier Detour',
    description: 'Roadworks barrier blocks left/center pavement while right lane is clear; must steer right around barrier.',
    expectation: {
      expectAlert: true,
      expectedKind: 'corridor-detour',
      expectedDetourDirection: 'right',
      eventOnsetMs: 4 * stepMs,
      maxReactionTimeMs: 120,
      minPrecision: 1.0,
      minRecall: 1.0,
    },
    frames,
  }
}

function buildDogAheadLeftScenario(): ReplayScenario {
  const route = makeReplayRoute(0, 'Corner Cafe')
  const frames: ReplayFrame[] = []
  const stepMs = 120
  const dogDistances = [null, null, null, 2.6, 2.2, 1.9, 1.6, 1.5, null, null]

  for (let i = 0; i < dogDistances.length; i++) {
    const t = i * stepMs
    const dist = dogDistances[i] ?? null
    const active = dist !== null
    const objects: SceneObject[] = dist !== null
      ? [
          {
            id: 'animal-1',
            label: 'dog',
            confidence: 0.87,
            direction: 'ahead-left',
            clockSector: 11,
            distanceMeters: dist,
            evidence: ['vision-animal'],
          },
        ]
      : []

    frames.push({
      timestampMs: t,
      route,
      groundTruthActive: active,
      snapshot: makeReplaySnapshot(t, i + 1, { objects }),
    })
  }

  return {
    id: 'dog-ahead-left',
    name: 'Dog Ahead-Left Presence',
    description: 'Leashed dog enters ahead-left at 2.6m..1.5m while pavement remains passable; must announce animal presence promptly.',
    expectation: {
      expectAlert: true,
      expectedKind: 'animal',
      eventOnsetMs: 3 * stepMs,
      maxReactionTimeMs: 120,
      minPrecision: 1.0,
      minRecall: 1.0,
    },
    frames,
  }
}

function buildKerbDropOffScenario(): ReplayScenario {
  const route = makeReplayRoute(-2, 'Bus Stop B')
  const frames: ReplayFrame[] = []
  const stepMs = 120
  const dropDistances = [null, null, null, 1.7, 1.5, 1.3, 1.1, 0.95, null, null]

  for (let i = 0; i < dropDistances.length; i++) {
    const t = i * stepMs
    const dist = dropDistances[i] ?? null
    const active = dist !== null
    const hazards: SpatialHazard[] = dist !== null
      ? [
          {
            id: 'lidar-drop-off',
            kind: 'drop-off',
            severity: 'urgent',
            direction: 'ahead',
            bearingDegrees: 0,
            distanceMeters: dist,
            confidence: 0.84,
            message: `Drop-off ahead, ${dist.toFixed(1)} metres.`,
            observedAt: t,
          },
        ]
      : []

    frames.push({
      timestampMs: t,
      route,
      groundTruthActive: active,
      snapshot: makeReplaySnapshot(t, i + 1, { hazards }),
    })
  }

  return {
    id: 'kerb-drop-off',
    name: 'Kerb / Platform Drop-Off',
    description: 'Steep kerb drop-off detected ahead at 1.7m..0.95m; must trigger urgent drop-off haptic and lower-elevation audio cue.',
    expectation: {
      expectAlert: true,
      expectedKind: 'drop-off',
      expectedHapticCue: 'drop-off',
      eventOnsetMs: 3 * stepMs,
      maxReactionTimeMs: 120,
      minPrecision: 1.0,
      minRecall: 1.0,
    },
    frames,
  }
}

function buildDarkNightWalkScenario(): ReplayScenario {
  const route = makeReplayRoute(2, 'Home')
  const frames: ReplayFrame[] = []
  const stepMs = 120

  for (let i = 0; i < 12; i++) {
    const t = i * stepMs
    const bollardActive = i >= 4 && i <= 8
    const dist = bollardActive ? Math.max(0.75, 1.35 - (i - 4) * 0.15) : 4.5
    const clearances = bollardActive ? [4.2, 4.0, 2.9, dist, 1.2, 1.1, 1.1] : [4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5]
    const hazards: SpatialHazard[] = bollardActive
      ? [
          {
            id: 'lidar-corridor-obstacle',
            kind: 'obstacle',
            severity: dist <= 0.9 ? 'urgent' : 'caution',
            direction: 'ahead',
            bearingDegrees: 0,
            distanceMeters: dist,
            confidence: 0.9,
            message: `Obstacle ahead, ${dist.toFixed(1)} metres. Open space to your left.`,
            observedAt: t,
          },
        ]
      : []

    frames.push({
      timestampMs: t,
      route,
      groundTruthActive: bollardActive,
      snapshot: makeReplaySnapshot(t, i + 1, {
        depthSource: 'lidar',
        lightingState: 'dark',
        ambientLuma: 0.04,
        corridor: {
          sectors: makeSectorProfile(clearances),
          corridorState: bollardActive ? 'narrow' : 'clear',
          forwardClearanceMeters: dist,
          bestClearanceMeters: bollardActive ? 3.8 : 4.5,
          recommendedHeadingOffsetDeg: bollardActive ? -30 : 0,
        },
        hazards,
        notes: ['Camera view is dark; LiDAR depth remains active in zero light.'],
      }),
    })
  }

  return {
    id: 'dark-night-walk',
    name: 'Dark Night Walk (0-Lux LiDAR)',
    description: 'Walking in dark conditions (luma 0.04) past an unlit bollard; LiDAR still guides left detour with zero delay.',
    expectation: {
      expectAlert: true,
      expectedKind: 'corridor-detour',
      expectedDetourDirection: 'left',
      eventOnsetMs: 4 * stepMs,
      maxReactionTimeMs: 120,
      minPrecision: 1.0,
      minRecall: 1.0,
      requireDarkLidar: true,
    },
    frames,
  }
}

function buildClearWalkZeroFalseAlarmsScenario(): ReplayScenario {
  const frames: ReplayFrame[] = []
  const stepMs = 120

  for (let i = 0; i < 20; i++) {
    const t = i * stepMs
    const loweredStandby = i >= 17
    const driftDeg = ((i % 5) - 2) * 4 // gentle -8..+8 deg walking sway
    const route = makeReplayRoute(driftDeg, 'Pharmacy')
    // Distant person (> 3.8m) should NOT trigger proximity presence; lowered phone must suppress synthetic hazards
    const objects: SceneObject[] =
      i >= 6 && i <= 10
        ? [
            {
              id: 'person-far',
              label: 'person',
              confidence: 0.9,
              direction: 'ahead-right',
              clockSector: 1,
              distanceMeters: 5.2,
              evidence: ['vision-person'],
            },
          ]
        : []
    const standbySyntheticHazard: SpatialHazard[] = loweredStandby
      ? [
          {
            id: 'lidar-standby-suppressed',
            kind: 'drop-off',
            severity: 'urgent',
            direction: 'ahead',
            bearingDegrees: 0,
            distanceMeters: 1.1,
            confidence: 0.8,
            message: 'Drop-off ahead, 1.1 metres.',
            observedAt: t,
          },
        ]
      : []

    frames.push({
      timestampMs: t,
      route,
      groundTruthActive: false,
      snapshot: makeReplaySnapshot(t, i + 1, {
        aimState: loweredStandby ? 'lowered' : 'level',
        pitchDegrees: loweredStandby ? -70 : -8,
        corridor: {
          aimState: loweredStandby ? 'lowered' : 'level',
          pitchDegrees: loweredStandby ? -70 : -8,
          valid: !loweredStandby,
          corridorState: loweredStandby ? 'unknown' : 'clear',
          forwardClearanceMeters: loweredStandby ? 0 : 4.6,
        },
        objects,
        hazards: standbySyntheticHazard,
      }),
    })
  }

  return {
    id: 'clear-walk-zero-false-alarms',
    name: 'Clear Walk (Zero False Alarms)',
    description: 'Open pavement walk with normal sway, distant pedestrian (>5m), and lowered standby; must emit zero false alerts.',
    expectation: {
      expectAlert: false,
      minPrecision: 1.0,
      minRecall: 1.0,
    },
    frames,
  }
}

export const BUILT_IN_STREET_WALK_SCENARIOS: ReplayScenario[] = [
  buildCyclistFastApproachScenario(),
  buildRoadworksDetourScenario(),
  buildDogAheadLeftScenario(),
  buildKerbDropOffScenario(),
  buildDarkNightWalkScenario(),
  buildClearWalkZeroFalseAlarmsScenario(),
]
