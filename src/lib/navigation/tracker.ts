import type { GeoPoint, RouteStep, WalkingRoute } from '../../../modules/tensorfold-navigation/src'
import {
  bearingDegrees,
  formatWalkingDistance,
  haversineMeters,
  lookaheadPoint,
  normalizeAngleOffset,
  projectOntoPolyline,
  turnPhraseFromOffset,
} from './geo'

export type ManeuverCueKind =
  | 'route-start'
  | 'turn-prepare'
  | 'turn-now'
  | 'turn-left'
  | 'turn-right'
  | 'off-route'
  | 'back-on-route'
  | 'arrived'

export interface RouteAnnouncement {
  kind: ManeuverCueKind
  message: string
  urgent?: boolean
}

export interface RouteProgress {
  active: boolean
  route: WalkingRoute
  stepIndex: number
  currentStep: RouteStep
  nextStep?: RouteStep
  distanceToNextTurnMeters: number
  remainingDistanceMeters: number
  targetBearingDeg: number
  /** Difference between targetBearingDeg and user's headingDeg (-180..+180). Undefined if no heading yet. */
  headingOffsetDeg?: number
  crossTrackErrorMeters: number
  offRoute: boolean
  arrived: boolean
  announcement?: RouteAnnouncement
}

const ARRIVAL_RADIUS_M = 8
const OFF_ROUTE_THRESHOLD_M = 22
const BACK_ON_ROUTE_THRESHOLD_M = 14
const LOOKAHEAD_M = 12

export class WalkingRouteTracker {
  private route: WalkingRoute
  private stepIndex = 0
  private offRouteStreak = 0
  private wasOffRoute = false
  private arrived = false
  private announcedPrepareStep = -1
  private announcedNowStep = -1
  private announcedStart = false
  private stepLengthMeters?: number

  constructor(route: WalkingRoute, stepLengthMeters?: number) {
    this.route = route
    this.stepLengthMeters = stepLengthMeters
  }

  getRoute(): WalkingRoute {
    return this.route
  }

  update(position: GeoPoint, headingDeg?: number): RouteProgress {
    const distToDestination = haversineMeters(position, this.route.destination)
    const overall = projectOntoPolyline(position, this.route.polyline)

    // Advance step index when user reaches or passes the corner into the next step.
    let enteredStepIndex: number | undefined
    while (this.stepIndex < this.route.steps.length - 1) {
      const stepCoords = this.route.steps[this.stepIndex]!.coordinates
      const stepEnd = stepCoords[stepCoords.length - 1]
      if (!stepEnd) {
        this.stepIndex += 1
        continue
      }
      const nextStepCoords = this.route.steps[this.stepIndex + 1]!.coordinates
      const distToCurrent = projectOntoPolyline(position, stepCoords).distanceMeters
      const distToNext = projectOntoPolyline(position, nextStepCoords).distanceMeters
      if (haversineMeters(position, stepEnd) <= 5 || (distToNext + 4 < distToCurrent && distToNext < 16)) {
        this.stepIndex += 1
        enteredStepIndex = this.stepIndex
      } else {
        break
      }
    }

    const currentStep = this.route.steps[this.stepIndex] ?? {
      instruction: `Head toward ${this.route.destinationName}`,
      distanceMeters: distToDestination,
      coordinates: this.route.polyline,
    }
    const nextStep = this.route.steps[this.stepIndex + 1]
    const stepProj = projectOntoPolyline(position, currentStep.coordinates)
    const distanceToNextTurn = nextStep ? stepProj.remainingMeters : distToDestination

    // Check off-route status (not applicable to direct-beacon routes)
    let offRoute = this.wasOffRoute
    let announcement: RouteAnnouncement | undefined

    if (this.route.source !== 'direct-beacon') {
      if (overall.distanceMeters > OFF_ROUTE_THRESHOLD_M) {
        this.offRouteStreak += 1
        if (this.offRouteStreak >= 2) offRoute = true
      } else if (overall.distanceMeters <= BACK_ON_ROUTE_THRESHOLD_M) {
        this.offRouteStreak = 0
        offRoute = false
      }
    }

    // Target bearing: if off-route, aim straight back toward closest point on polyline; otherwise aim 12m ahead along route.
    const aimPoint = offRoute
      ? overall.closestPoint
      : lookaheadPoint(this.route.polyline, overall, Math.min(LOOKAHEAD_M, Math.max(4, overall.remainingMeters)))
    const targetBearingDeg = bearingDegrees(position, aimPoint)
    const headingOffsetDeg = headingDeg !== undefined && Number.isFinite(headingDeg)
      ? normalizeAngleOffset(targetBearingDeg, headingDeg)
      : undefined

    // Arrival check
    if (!this.arrived && distToDestination <= ARRIVAL_RADIUS_M) {
      this.arrived = true
      announcement = {
        kind: 'arrived',
        message: `You have arrived near ${this.route.destinationName}.`,
      }
    } else if (!this.announcedStart) {
      this.announcedStart = true
      const total = formatWalkingDistance(Math.max(overall.remainingMeters, distToDestination), this.stepLengthMeters)
      const orientHint = headingOffsetDeg !== undefined && Math.abs(headingOffsetDeg) > 25
        ? ` ${capitalize(turnPhraseFromOffset(headingOffsetDeg))} to align.`
        : ''
      announcement = {
        kind: 'route-start',
        message: `Navigating to ${this.route.destinationName}, ${total}.${orientHint} ${currentStep.instruction}.`,
      }
    } else if (offRoute && !this.wasOffRoute) {
      const backHint = headingOffsetDeg !== undefined ? ` ${capitalize(turnPhraseFromOffset(headingOffsetDeg))} to rejoin.` : ''
      announcement = {
        kind: 'off-route',
        message: `Off route by ${Math.round(overall.distanceMeters)} metres.${backHint}`,
      }
    } else if (!offRoute && this.wasOffRoute) {
      announcement = {
        kind: 'back-on-route',
        message: `Back on route. ${currentStep.instruction}.`,
      }
    } else if (!offRoute && enteredStepIndex !== undefined && this.announcedNowStep < enteredStepIndex) {
      this.announcedNowStep = enteredStepIndex
      this.announcedPrepareStep = enteredStepIndex
      const lower = currentStep.instruction.toLowerCase()
      const kind: ManeuverCueKind = lower.includes('left')
        ? 'turn-left'
        : lower.includes('right')
          ? 'turn-right'
          : 'turn-now'
      announcement = {
        kind,
        message: `${currentStep.instruction} now.`,
      }
    } else if (!offRoute && nextStep) {
      const nextStepIdx = this.stepIndex + 1
      if (distanceToNextTurn <= 7 && this.announcedNowStep < nextStepIdx) {
        this.announcedNowStep = nextStepIdx
        this.announcedPrepareStep = nextStepIdx
        const lower = nextStep.instruction.toLowerCase()
        const kind: ManeuverCueKind = lower.includes('left')
          ? 'turn-left'
          : lower.includes('right')
            ? 'turn-right'
            : 'turn-now'
        announcement = {
          kind,
          message: `${nextStep.instruction} now.`,
        }
      } else if (distanceToNextTurn <= 25 && distanceToNextTurn > 8 && this.announcedPrepareStep < nextStepIdx) {
        this.announcedPrepareStep = nextStepIdx
        announcement = {
          kind: 'turn-prepare',
          message: `In ${formatWalkingDistance(distanceToNextTurn, this.stepLengthMeters)}, ${lowercaseFirst(nextStep.instruction)}.`,
        }
      }
    }

    this.wasOffRoute = offRoute

    return {
      active: !this.arrived,
      route: this.route,
      stepIndex: this.stepIndex,
      currentStep,
      nextStep,
      distanceToNextTurnMeters: distanceToNextTurn,
      remainingDistanceMeters: Math.max(overall.remainingMeters, distToDestination),
      targetBearingDeg,
      headingOffsetDeg,
      crossTrackErrorMeters: overall.distanceMeters,
      offRoute,
      arrived: this.arrived,
      announcement,
    }
  }
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value
}

function lowercaseFirst(value: string): string {
  return value ? value[0]!.toLowerCase() + value.slice(1) : value
}
