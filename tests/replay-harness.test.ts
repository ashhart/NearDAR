import { describe, expect, test } from 'bun:test'
import {
  BUILT_IN_STREET_WALK_SCENARIOS,
  evaluateReplayScenario,
  makeReplayRoute,
  makeReplaySnapshot,
  makeSectorProfile,
  runStreetWalkReplayBenchmark,
  type ReplayScenario,
} from '../src/lib/satnav/replay'

describe('Street Walk Replay Benchmark', () => {
  test('all 6 built-in realistic scenarios pass with 100% precision, 100% recall, and fast reaction times', () => {
    const summary = runStreetWalkReplayBenchmark()

    expect(summary.scenarioCount).toBe(6)
    expect(summary.passedCount).toBe(6)
    expect(summary.passed).toBe(true)
    expect(summary.overallPrecision).toBe(1.0)
    expect(summary.overallRecall).toBe(1.0)
    expect(summary.falseAlarmCount).toBe(0)
    expect(summary.maxReactionTimeMs).toBeLessThanOrEqual(120)
    expect(summary.meanReactionTimeMs).toBeLessThanOrEqual(120)

    for (const result of summary.results) {
      expect(result.failures).toEqual([])
      expect(result.passed).toBe(true)
    }
  })

  test('cyclist fast-approach fires urgent fast-mover haptic and 3D audio on first onset frame', () => {
    const scenario = BUILT_IN_STREET_WALK_SCENARIOS.find((s) => s.id === 'cyclist-fast-approach')!
    const result = evaluateReplayScenario(scenario)

    expect(result.passed).toBe(true)
    expect(result.truePositives).toBe(5)
    expect(result.falsePositives).toBe(0)
    expect(result.falseNegatives).toBe(0)
    expect(result.reactionTimeMs).toBe(0)

    const alertFrames = result.frameResults.filter((f) => f.groundTruthActive)
    expect(alertFrames.every((f) => f.fused.urgentHapticCue === 'fast-mover')).toBe(true)
    expect(alertFrames.every((f) => f.fused.urgentSpatialCue?.kind === 'fast-mover')).toBe(true)
  })

  test('roadworks detour blends active route into right micro-detour and resumes route once clear', () => {
    const scenario = BUILT_IN_STREET_WALK_SCENARIOS.find((s) => s.id === 'roadworks-detour')!
    const result = evaluateReplayScenario(scenario)

    expect(result.passed).toBe(true)
    expect(result.precision).toBe(1.0)
    expect(result.recall).toBe(1.0)
    expect(result.reactionTimeMs).toBe(0)

    const detourFrames = result.frameResults.filter((f) => f.groundTruthActive)
    expect(detourFrames.every((f) => f.fused.steeringSource === 'corridor-detour')).toBe(true)
    expect(detourFrames.every((f) => (f.fused.steeringOffsetDeg ?? 0) >= 15)).toBe(true)

    const resumedFrames = result.frameResults.slice(10)
    expect(resumedFrames.every((f) => f.fused.steeringSource === 'route')).toBe(true)
  })

  test('dog ahead-left triggers live animal presence without spurious obstacle alerts', () => {
    const scenario = BUILT_IN_STREET_WALK_SCENARIOS.find((s) => s.id === 'dog-ahead-left')!
    const result = evaluateReplayScenario(scenario)

    expect(result.passed).toBe(true)
    expect(result.truePositives).toBe(5)
    expect(result.falsePositives).toBe(0)
    expect(result.reactionTimeMs).toBe(0)
    expect(result.frameResults[3]?.presence?.kind).toBe('animal')
    expect(result.frameResults[3]?.presence?.message).toContain('Dog')
  })

  test('kerb drop-off elevates drop-off haptic and negative-elevation 3D spatial cue', () => {
    const scenario = BUILT_IN_STREET_WALK_SCENARIOS.find((s) => s.id === 'kerb-drop-off')!
    const result = evaluateReplayScenario(scenario)

    expect(result.passed).toBe(true)
    expect(result.reactionTimeMs).toBe(0)
    const activeFrames = result.frameResults.filter((f) => f.groundTruthActive)
    expect(activeFrames.every((f) => f.fused.urgentHapticCue === 'drop-off')).toBe(true)
    expect(activeFrames.every((f) => (f.fused.urgentSpatialCue?.elevationMeters ?? 0) < 0)).toBe(true)
  })

  test('dark night walk stays 100% effective via LiDAR at 0-lux (ambientLuma < 0.14)', () => {
    const scenario = BUILT_IN_STREET_WALK_SCENARIOS.find((s) => s.id === 'dark-night-walk')!
    const result = evaluateReplayScenario(scenario)

    expect(result.passed).toBe(true)
    expect(result.precision).toBe(1.0)
    expect(result.recall).toBe(1.0)
    expect(result.reactionTimeMs).toBe(0)
    const detourFrames = result.frameResults.filter((f) => f.groundTruthActive)
    expect(detourFrames.every((f) => (f.fused.steeringOffsetDeg ?? 0) <= -15)).toBe(true)
  })

  test('clear walk produces zero false alarms even with sway, distant people, and lowered standby', () => {
    const scenario = BUILT_IN_STREET_WALK_SCENARIOS.find((s) => s.id === 'clear-walk-zero-false-alarms')!
    const result = evaluateReplayScenario(scenario)

    expect(result.passed).toBe(true)
    expect(result.falsePositives).toBe(0)
    expect(result.precision).toBe(1.0)
    expect(result.reactionTimeMs).toBeNull()
    expect(result.frameResults.slice(17).every((f) => f.fused.standby && !f.fused.primaryHazard)).toBe(true)
  })

  test('thermal-throttled lanyard walk still triggers P0 head-height hazard with zero latency penalty', () => {
    const route = makeReplayRoute(0, 'Station')
    const customScenario: ReplayScenario = {
      id: 'thermal-critical-lanyard-overhang',
      name: 'Critical Thermal + Lanyard Head Hazard',
      description: 'Even under critical thermals (proactiveVlmAllowed=false) in lanyard posture (-40 deg -> level), P0 head-height hazard triggers immediately.',
      expectation: {
        expectAlert: true,
        expectedKind: 'head-height',
        expectedHapticCue: 'head-hazard',
        eventOnsetMs: 760,
        maxReactionTimeMs: 0,
      },
      frames: [
        {
          timestampMs: 0,
          route,
          groundTruthActive: false,
          snapshot: makeReplaySnapshot(0, 1, {
            thermalState: 'critical',
            proactiveVlmAllowed: false,
            pitchDegrees: -40,
            aimState: 'level',
            corridor: { pitchDegrees: -40, aimState: 'level' },
          }),
        },
        {
          timestampMs: 380,
          route,
          groundTruthActive: false,
          snapshot: makeReplaySnapshot(380, 2, {
            thermalState: 'critical',
            proactiveVlmAllowed: false,
            pitchDegrees: -40,
            aimState: 'level',
            corridor: { pitchDegrees: -40, aimState: 'level' },
          }),
        },
        {
          timestampMs: 760,
          route,
          groundTruthActive: true,
          snapshot: makeReplaySnapshot(760, 3, {
            thermalState: 'critical',
            proactiveVlmAllowed: false,
            pitchDegrees: -40,
            aimState: 'level',
            corridor: {
              pitchDegrees: -40,
              aimState: 'level',
              sectors: makeSectorProfile([4.0, 4.0, 4.0, 4.0, 4.0, 4.0, 4.0]),
            },
            hazards: [
              {
                id: 'lidar-head-height',
                kind: 'head-height',
                severity: 'urgent',
                direction: 'ahead',
                bearingDegrees: 2,
                distanceMeters: 1.05,
                confidence: 0.86,
                message: 'Head-height obstacle ahead, 1.1 metres.',
                observedAt: 760,
              },
            ],
          }),
        },
      ],
    }

    const result = evaluateReplayScenario(customScenario)
    expect(result.passed).toBe(true)
    expect(result.reactionTimeMs).toBe(0)
    expect(result.frameResults[2]?.fused.urgentHapticCue).toBe('head-hazard')
    expect(result.frameResults[2]?.fused.urgentSpatialCue?.elevationMeters).toBeGreaterThan(0)
  })

  test('benchmark evaluator detects missed hazards and false alarms accurately', () => {
    const missedScenario: ReplayScenario = {
      id: 'synthetic-miss',
      name: 'Synthetic Miss Check',
      description: 'Verifies benchmark fails when an expected alert never fires.',
      expectation: {
        expectAlert: true,
        expectedKind: 'drop-off',
        expectedHapticCue: 'drop-off',
        eventOnsetMs: 120,
        maxReactionTimeMs: 120,
      },
      frames: [
        { timestampMs: 0, groundTruthActive: false, snapshot: makeReplaySnapshot(0, 1) },
        { timestampMs: 120, groundTruthActive: true, snapshot: makeReplaySnapshot(120, 2) },
      ],
    }

    const result = evaluateReplayScenario(missedScenario)
    expect(result.passed).toBe(false)
    expect(result.recall).toBe(0)
    expect(result.falseNegatives).toBe(1)
    expect(result.reactionTimeMs).toBeNull()
    expect(result.failures.length).toBeGreaterThan(0)
  })
})
