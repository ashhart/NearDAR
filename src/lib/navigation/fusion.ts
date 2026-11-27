import type { AimState, CorridorSummary, SpatialHazard } from '../../../modules/tensorfold-perception/src'
import type { GuidanceHapticState, HapticCue } from '../../../modules/tensorfold-haptics/src'
import type { SpatialBeaconOptions, SpatialCueOptions } from '../../../modules/tensorfold-voice/src'
import type { RouteProgress } from './tracker'
import { turnPhraseFromOffset } from './geo'

export interface FusedSatnavGuidance {
  /** Effective steering offset in degrees (-180..+180) blending route bearing and LiDAR open corridor. */
  steeringOffsetDeg?: number
  steeringSource: 'route' | 'corridor-detour' | 'corridor-explore' | 'none'
  /** Forward LiDAR clearance in meters when available. */
  forwardClearanceMeters?: number
  corridorState: 'clear' | 'narrow' | 'blocked' | 'unknown'
  aimState: AimState
  /** True when the phone is lowered to the user's side or lens is covered; keeps route/compass active while muting LiDAR hazards. */
  standby: boolean
  /** Highest priority active spatial hazard, if any. */
  primaryHazard?: SpatialHazard
  /** Continuous haptic state to push into native CoreHaptics engine. */
  hapticState: GuidanceHapticState
  /** Continuous 3D spatial audio beacon configuration. */
  spatialBeacon: SpatialBeaconOptions
  /** Immediate one-shot haptic cue (e.g. fast-mover, drop-off, head-height, turn-left), if triggered. */
  urgentHapticCue?: HapticCue
  /** Immediate one-shot 3D spatial audio cue, if triggered. */
  urgentSpatialCue?: SpatialCueOptions
  /** Short, actionable one-line status text for the HUD & on-demand readback. */
  summary: string
}

export interface FusionPreferences {
  hapticSteering: boolean
  hapticProximity: boolean
  spatialBeacon: boolean
  beaconHeadphonesOnly: boolean
  muted?: boolean
}

const HAZARD_PRIORITY: Record<SpatialHazard['kind'], number> = {
  'fast-mover': 6,
  'drop-off': 5,
  'step-down': 4,
  'head-height': 4,
  'step-up': 3,
  obstacle: 2,
  doorway: 1,
}

export function selectPrimaryHazard(hazards: SpatialHazard[] = []): SpatialHazard | undefined {
  if (!hazards.length) return undefined
  return [...hazards].sort((a, b) => {
    const sevA = a.severity === 'urgent' ? 2 : a.severity === 'caution' ? 1 : 0
    const sevB = b.severity === 'urgent' ? 2 : b.severity === 'caution' ? 1 : 0
    if (sevA !== sevB) return sevB - sevA
    const prioDiff = (HAZARD_PRIORITY[b.kind] ?? 0) - (HAZARD_PRIORITY[a.kind] ?? 0)
    if (prioDiff !== 0) return prioDiff
    return a.distanceMeters - b.distanceMeters
  })[0]
}

export function fuseSatnavGuidance(
  route: RouteProgress | undefined,
  corridor: CorridorSummary | undefined,
  hazards: SpatialHazard[] | undefined,
  prefs: FusionPreferences,
): FusedSatnavGuidance {
  const aimState: AimState = corridor?.aimState ?? 'level'
  const standby = aimState === 'lowered' || aimState === 'covered'
  const corridorValid = !standby && corridor?.valid === true
  const corridorState = corridorValid ? corridor.corridorState : 'unknown'
  const forwardClearance = corridorValid ? corridor.forwardClearanceMeters : undefined
  const primaryHazard = standby ? undefined : selectPrimaryHazard(hazards)

  let steeringOffsetDeg: number | undefined
  let steeringSource: FusedSatnavGuidance['steeringSource'] = 'none'
  let summary = standby
    ? (aimState === 'covered' ? 'Camera covered — route and compass active.' : 'Camera lowered — route and compass active.')
    : 'Ready. Point your phone ahead.'

  const routeActive = Boolean(route && route.active && !route.arrived)
  const routeOffset = routeActive ? route?.headingOffsetDeg : undefined

  if (routeActive && routeOffset !== undefined) {
    // Route wants us going roughly forward, but LiDAR sees a near obstacle with a clear side corridor -> micro-detour!
    if (
      corridorValid &&
      Math.abs(routeOffset) <= 25 &&
      corridor.corridorState === 'narrow' &&
      corridor.forwardClearanceMeters < 2.0 &&
      Math.abs(corridor.recommendedHeadingOffsetDeg) >= 15
    ) {
      steeringOffsetDeg = corridor.recommendedHeadingOffsetDeg
      steeringSource = 'corridor-detour'
      const side = corridor.recommendedHeadingOffsetDeg < 0 ? 'left' : 'right'
      summary = `Obstacle ahead — step slightly ${side} around it.`
    } else if (corridorValid && corridor.corridorState === 'blocked') {
      steeringOffsetDeg = routeOffset
      steeringSource = 'route'
      summary = 'Path ahead is blocked. Check surroundings before moving.'
    } else {
      steeringOffsetDeg = routeOffset
      steeringSource = 'route'
      const phrase = turnPhraseFromOffset(routeOffset)
      summary = Math.abs(routeOffset) <= 15
        ? `On course — ${route!.currentStep.instruction}.`
        : `${phrase[0]!.toUpperCase() + phrase.slice(1)} toward ${route!.route.destinationName}.`
    }
  } else if (corridorValid) {
    // Free-roam micro-satnav mode using LiDAR open corridor
    steeringOffsetDeg = corridor.recommendedHeadingOffsetDeg
    steeringSource = 'corridor-explore'
    if (corridor.corridorState === 'blocked') {
      summary = 'Path blocked ahead.'
    } else if (corridor.corridorState === 'narrow' && Math.abs(corridor.recommendedHeadingOffsetDeg) >= 15) {
      const side = corridor.recommendedHeadingOffsetDeg < 0 ? 'left' : 'right'
      summary = `Open corridor to your ${side}.`
    } else {
      summary = `Clear ahead for ${corridor.forwardClearanceMeters >= 4.5 ? 'over 4 metres' : `${corridor.forwardClearanceMeters.toFixed(1)} metres`}.`
    }
  }

  let urgentHapticCue: HapticCue | undefined
  let urgentSpatialCue: SpatialCueOptions | undefined

  if (primaryHazard && (primaryHazard.severity === 'urgent' || primaryHazard.kind === 'fast-mover' || primaryHazard.kind === 'head-height' || primaryHazard.kind === 'drop-off' || primaryHazard.kind === 'step-down')) {
    if (primaryHazard.kind === 'fast-mover') {
      urgentHapticCue = 'fast-mover'
      urgentSpatialCue = { kind: 'fast-mover', azimuthDeg: primaryHazard.bearingDegrees, distanceMeters: primaryHazard.distanceMeters, elevationMeters: 0 }
      summary = primaryHazard.message
    } else if (primaryHazard.kind === 'head-height') {
      urgentHapticCue = 'head-hazard'
      urgentSpatialCue = { kind: 'head-height', azimuthDeg: primaryHazard.bearingDegrees, distanceMeters: primaryHazard.distanceMeters, elevationMeters: 0.9 }
      summary = primaryHazard.message
    } else if (primaryHazard.kind === 'drop-off' || primaryHazard.kind === 'step-down') {
      urgentHapticCue = 'drop-off'
      urgentSpatialCue = { kind: primaryHazard.kind, azimuthDeg: primaryHazard.bearingDegrees, distanceMeters: primaryHazard.distanceMeters, elevationMeters: -0.9 }
      summary = primaryHazard.message
    } else if (primaryHazard.kind === 'obstacle' && primaryHazard.severity === 'urgent') {
      urgentSpatialCue = { kind: 'obstacle', azimuthDeg: primaryHazard.bearingDegrees, distanceMeters: primaryHazard.distanceMeters, elevationMeters: 0 }
      summary = primaryHazard.message
    }
  }

  const hapticState: GuidanceHapticState = {
    active: (routeActive || corridorValid) && !prefs.muted,
    steeringEnabled: prefs.hapticSteering && steeringOffsetDeg !== undefined,
    proximityEnabled: !standby && prefs.hapticProximity && forwardClearance !== undefined,
    headingOffsetDeg: steeringOffsetDeg,
    forwardClearanceMeters: standby ? undefined : forwardClearance,
    muted: prefs.muted === true,
  }

  // 3D Spatial Audio beacon aims at route waypoint when navigating, or clear corridor when exploring in narrow spaces
  const beaconActive = Boolean(
    prefs.spatialBeacon &&
    !prefs.muted &&
    steeringOffsetDeg !== undefined &&
    (routeActive || (corridorValid && corridorState === 'narrow')),
  )

  const spatialBeacon: SpatialBeaconOptions = {
    active: beaconActive,
    azimuthDeg: steeringOffsetDeg ?? 0,
    distanceMeters: routeActive ? Math.min(5, Math.max(1, (route?.distanceToNextTurnMeters ?? 15) / 8)) : 2.0,
    headphonesOnly: prefs.beaconHeadphonesOnly,
  }

  return {
    steeringOffsetDeg,
    steeringSource,
    forwardClearanceMeters: forwardClearance,
    corridorState,
    aimState,
    standby,
    primaryHazard,
    hapticState,
    spatialBeacon,
    urgentHapticCue,
    urgentSpatialCue,
    summary,
  }
}
