import type { FusedSatnavGuidance } from '../navigation/fusion'
import type { RouteProgress } from '../navigation/tracker'
import type { SceneSnapshot } from '../guidance/types'
import type { ActiveMobilitySkill } from './modes'

export type WebDemoScenario = 'walk' | 'hazard' | 'sheet'

export interface WebDemoOverride {
  snapshot: SceneSnapshot
  fused: FusedSatnavGuidance
  routeProgress: RouteProgress
  headingDegrees: number
  activeSkill: ActiveMobilitySkill
  watchedBus?: string
  caption: string
  headphones: boolean
  openSheet?: boolean
  forceOled?: boolean
}

const SECTORS_DETOUR = [
  { index: 0, centerDegrees: -45, label: 'far-left', clearanceMeters: 1.1, sampleCount: 18, confidence: 0.92 },
  { index: 1, centerDegrees: -30, label: 'left', clearanceMeters: 1.3, sampleCount: 22, confidence: 0.94 },
  { index: 2, centerDegrees: -15, label: 'ahead-left', clearanceMeters: 1.5, sampleCount: 24, confidence: 0.95 },
  { index: 3, centerDegrees: 0, label: 'ahead', clearanceMeters: 1.9, sampleCount: 21, confidence: 0.93 },
  { index: 4, centerDegrees: 15, label: 'ahead-right', clearanceMeters: 3.9, sampleCount: 16, confidence: 0.90 },
  { index: 5, centerDegrees: 30, label: 'right', clearanceMeters: 4.5, sampleCount: 15, confidence: 0.89 },
  { index: 6, centerDegrees: 45, label: 'far-right', clearanceMeters: 4.2, sampleCount: 14, confidence: 0.88 },
]

const SECTORS_FAST = [
  { index: 0, centerDegrees: -45, label: 'far-left', clearanceMeters: 3.6, sampleCount: 16, confidence: 0.90 },
  { index: 1, centerDegrees: -30, label: 'left', clearanceMeters: 2.8, sampleCount: 22, confidence: 0.94 },
  { index: 2, centerDegrees: -15, label: 'ahead-left', clearanceMeters: 0.85, sampleCount: 26, confidence: 0.96 },
  { index: 3, centerDegrees: 0, label: 'ahead', clearanceMeters: 2.9, sampleCount: 20, confidence: 0.92 },
  { index: 4, centerDegrees: 15, label: 'ahead-right', clearanceMeters: 4.1, sampleCount: 18, confidence: 0.91 },
  { index: 5, centerDegrees: 30, label: 'right', clearanceMeters: 4.3, sampleCount: 15, confidence: 0.89 },
  { index: 6, centerDegrees: 45, label: 'far-right', clearanceMeters: 3.8, sampleCount: 14, confidence: 0.88 },
]

const DEMO_ROUTE: RouteProgress = {
  route: {
    id: 'demo-route-1',
    destinationName: 'High St Pharmacy',
    origin: { latitude: 51.5005, longitude: -0.1005 },
    destination: { latitude: 51.5012, longitude: -0.0998 },
    distanceMeters: 120,
    expectedTravelTimeSeconds: 95,
    polyline: [
      { latitude: 51.5005, longitude: -0.1005 },
      { latitude: 51.5012, longitude: -0.0998 },
    ],
    steps: [
      {
        instruction: 'Continue straight, then turn right onto High Street',
        distanceMeters: 85,
        coordinates: [
          { latitude: 51.5005, longitude: -0.1005 },
          { latitude: 51.5012, longitude: -0.0998 },
        ],
      },
    ],
    source: 'mapkit',
    createdAt: 1_700_000_000_000,
  },
  active: true,
  arrived: false,
  offRoute: false,
  stepIndex: 0,
  currentStep: {
    instruction: 'Continue straight, then turn right onto High Street',
    distanceMeters: 85,
    coordinates: [
      { latitude: 51.5005, longitude: -0.1005 },
      { latitude: 51.5012, longitude: -0.0998 },
    ],
  },
  remainingDistanceMeters: 85,
  distanceToNextTurnMeters: 24,
  crossTrackErrorMeters: 1.2,
  targetBearingDeg: 42,
  headingOffsetDeg: 15,
}

export function getWebDemoOverride(scenario: string | undefined): WebDemoOverride | undefined {
  if (scenario !== 'walk' && scenario !== 'hazard' && scenario !== 'sheet') return undefined
  const now = Date.now()

  if (scenario === 'hazard') {
    const fastHazard = {
      id: 'lidar-fast-mover',
      kind: 'fast-mover' as const,
      severity: 'urgent' as const,
      direction: 'ahead-left' as const,
      bearingDegrees: -25,
      distanceMeters: 2.8,
      confidence: 0.94,
      message: 'Fast movement, 11 o’clock, 3 metres — hold still.',
      observedAt: now,
      closingSpeedMps: 4.3,
      externalSpeedMps: 3.9,
      ttcSeconds: 0.65,
    }
    return {
      headingDegrees: 315,
      activeSkill: 'crossing',
      headphones: true,
      forceOled: true,
      caption: 'Fast movement, 11 o’clock, 3 metres — hold still. Cyclist approaching near the crossing.',
      routeProgress: {
        ...DEMO_ROUTE,
        remainingDistanceMeters: 18,
        currentStep: {
          ...DEMO_ROUTE.currentStep,
          instruction: 'Approaching pedestrian crossing — listen and check traffic',
        },
      },
      snapshot: {
        observedAt: now,
        sequence: 42,
        trackingReady: true,
        depthState: 'ready',
        depthSource: 'lidar',
        thermalState: 'nominal',
        lightingState: 'dark',
        ambientLuma: 0.09,
        validDepthFraction: 0.95,
        cameraOrientation: 'camera-forward',
        objects: [
          { id: 'p1', label: 'person', confidence: 0.92, direction: 'ahead-right', clockSector: 1, distanceMeters: 2.6, evidence: [] },
        ],
        freeSeats: [],
        recognizedText: ['WAIT', 'HIGH ST'],
        aimState: 'level',
        pitchDegrees: -4,
        headingDegrees: 315,
        corridor: {
          sectors: SECTORS_FAST,
          recommendedHeadingOffsetDeg: 15,
          corridorState: 'narrow',
          forwardClearanceMeters: 2.9,
          bestClearanceMeters: 4.1,
          aimState: 'level',
          pitchDegrees: -4,
          headingDegrees: 315,
          maxClosingSpeedMps: 4.3,
          valid: true,
        },
        hazards: [fastHazard],
        notes: [],
      },
      fused: {
        steeringOffsetDeg: 0,
        steeringSource: 'route',
        forwardClearanceMeters: 2.9,
        corridorState: 'narrow',
        aimState: 'level',
        standby: false,
        primaryHazard: fastHazard,
        hapticState: { active: true, steeringEnabled: true, proximityEnabled: true, headingOffsetDeg: 0, forwardClearanceMeters: 2.9 },
        spatialBeacon: { active: true, azimuthDeg: 0, distanceMeters: 1.5, headphonesOnly: true },
        urgentHapticCue: 'fast-mover',
        urgentSpatialCue: { kind: 'fast-mover', azimuthDeg: -25, distanceMeters: 2.8, elevationMeters: 0 },
        summary: fastHazard.message,
      },
    }
  }

  return {
    headingDegrees: 38,
    activeSkill: 'none',
    headphones: true,
    openSheet: scenario === 'sheet',
    caption: 'Roadworks barrier, ahead left, 2 metres — pass right. Dog at 10 o’clock, 2 metres.',
    routeProgress: DEMO_ROUTE,
    snapshot: {
      observedAt: now,
      sequence: 19,
      trackingReady: true,
      depthState: 'ready',
      depthSource: 'lidar',
      thermalState: 'nominal',
      lightingState: 'good',
      ambientLuma: 0.56,
      validDepthFraction: 0.94,
      cameraOrientation: 'camera-forward',
      objects: [
        { id: 'dog-1', label: 'dog', confidence: 0.91, direction: 'ahead-left', clockSector: 10, distanceMeters: 1.9, evidence: [] },
        { id: 'person-1', label: 'person', confidence: 0.93, direction: 'ahead-right', clockSector: 1, distanceMeters: 3.1, evidence: [] },
      ],
      freeSeats: [],
      recognizedText: ['HIGH STREET', 'PHARMACY'],
      aimState: 'level',
      pitchDegrees: -2,
      headingDegrees: 38,
      corridor: {
        sectors: SECTORS_DETOUR,
        openings: [{ bearingDegrees: 30, direction: 'ahead-right', distanceMeters: 2.1, clearanceMeters: 4.5, widthDegrees: 15 }],
        recommendedHeadingOffsetDeg: 30,
        corridorState: 'narrow',
        forwardClearanceMeters: 1.9,
        bestClearanceMeters: 4.2,
        aimState: 'level',
        pitchDegrees: -2,
        headingDegrees: 38,
        valid: true,
      },
      hazards: [],
      notes: [],
    },
    fused: {
      steeringOffsetDeg: 30,
      steeringSource: 'corridor-detour',
      forwardClearanceMeters: 1.9,
      corridorState: 'narrow',
      aimState: 'level',
      standby: false,
      hapticState: { active: true, steeringEnabled: true, proximityEnabled: true, headingOffsetDeg: 30, forwardClearanceMeters: 1.9 },
      spatialBeacon: { active: true, azimuthDeg: 30, distanceMeters: 2.0, headphonesOnly: true },
      summary: 'Obstacle ahead — step slightly right around it.',
    },
  }
}
