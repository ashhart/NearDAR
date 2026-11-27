import type { GeoPoint } from '../../../modules/tensorfold-navigation/src'
import type { DirectionStyle, SatnavMode, SceneSnapshot, SceneWarning } from '../guidance/types'
import { formatWalkingDistance, haversineMeters, normalizeAngleOffset } from '../navigation/geo'
import type { RouteProgress } from '../navigation/tracker'
import { formatDirectionLabel } from './arbitrator'
import {
  buildAmbientObstaclePrompt,
  DARK_LIGHTING_TELEMETRY_NOTE,
  parseAmbientObstacleLabel,
  resolveLightingState,
  sanitizeSpokenVisionOutput,
  type LightingState,
  type MobilityProfile,
} from './prompts'

export type { LightingState, MobilityProfile }

export type NarrationTaskKind = 'hazard-classify' | 'crossing-lookahead' | 'street-explore'

export interface NarrationTask {
  kind: NarrationTaskKind
  system: string
  prompt: string
  maxImageTokens: number
  maxTokens: number
  temperature: number
  category: string
  cooldownMs: number
  /** Optional metadata used when formatting concise spoken output. */
  warning?: SceneWarning
}

export interface NarrationPlannerInput {
  mode: SatnavMode
  proactiveNarration: boolean
  ambientObstacleNaming: boolean
  engineReady: boolean
  busy: boolean
  listening: boolean
  standby: boolean
  snapshot?: SceneSnapshot
  route?: RouteProgress
  location?: GeoPoint
  headingDeg?: number
  directionStyle: DirectionStyle
  stepLengthMeters?: number
  lastCriticalAt: number
  now: number
  lightingState?: LightingState
  proactiveVlmAllowed?: boolean
  mobilityProfile?: MobilityProfile
}

export type HazardClassificationInput = Pick<
  NarrationPlannerInput,
  'ambientObstacleNaming' | 'engineReady' | 'busy' | 'listening' | 'standby' | 'now'
> & {
  lightingState?: LightingState
  proactiveVlmAllowed?: boolean
  mobilityProfile?: MobilityProfile
  corridorState?: 'clear' | 'narrow' | 'blocked' | 'unknown'
  snapshot?: SceneSnapshot
}

function isProactiveVlmAllowed(explicit?: boolean, snapshot?: SceneSnapshot): boolean {
  if (explicit !== undefined) return explicit
  const fromSnap = (snapshot as { proactiveVlmAllowed?: boolean } | undefined)?.proactiveVlmAllowed
  return fromSnap !== false
}

const CROSSING_SYSTEM =
  'You are NearDar, a concise walking mobility narrator for a blind pedestrian approaching a kerb or junction. ' +
  'Respond in ONE short spoken sentence (under 18 words). Mention crossings, tactile paving, kerbs, roadworks, parked vehicles, cyclists, or traffic lights only if clearly visible. ' +
  'Never say it is safe to cross.'

const EXPLORE_SYSTEM =
  'You are NearDar, a calm street narrator giving a blind walker rich spatial awareness as they walk. ' +
  'Respond in ONE short spoken sentence (under 18 words) naming the most useful passing feature: storefront, cafe, bus stop, doorway, park, roadworks, cyclist, dog, or street layout. ' +
  'If nothing notable is visible, reply ONLY with: NONE.'

/**
 * Coordinates proactive, non-blocking background TensorFold Mobile vision checks:
 * 1. Unnamed blocking obstacle classification (roadworks, pushbike, bin, bollard, A-board, car, branch).
 * 2. Crossing / turn lookahead when approaching within 16m of a turn.
 * 3. Passing street-scene & landmark narration when moving (never repeating while stationary).
 */
export class StreetNarrator {
  private lastHazardAt = 0
  private lastCrossingStepIndex = -1
  private lastCrossingAt = 0
  private lastExploreAt = 0
  private lastExploreLocation?: GeoPoint
  private lastExploreHeading?: number

  reset() {
    this.lastHazardAt = 0
    this.lastCrossingStepIndex = -1
    this.lastCrossingAt = 0
    this.lastExploreAt = 0
    this.lastExploreLocation = undefined
    this.lastExploreHeading = undefined
  }

  /** Triggered reactively when an unnamed LiDAR obstacle is blocking or narrowing the path. */
  planHazardClassification(
    warning: SceneWarning,
    input: HazardClassificationInput,
  ): NarrationTask | undefined {
    if (!input.ambientObstacleNaming || !input.engineReady || input.busy || input.listening || input.standby) {
      return undefined
    }
    if (!isProactiveVlmAllowed(input.proactiveVlmAllowed, input.snapshot)) {
      return undefined
    }
    const lighting = resolveLightingState(input.lightingState, input.snapshot)
    if (lighting === 'dark') {
      return undefined
    }
    if (warning.kind !== 'obstacle' || warning.label) return undefined
    if (warning.distanceMeters !== undefined && warning.distanceMeters > 2.6) return undefined

    // Guide dogs smoothly route around routine static obstacles; only classify when the path is genuinely blocked.
    if (input.mobilityProfile === 'guide-dog') {
      const corridorState = input.corridorState ?? input.snapshot?.corridor?.corridorState
      if (corridorState !== 'blocked') {
        return undefined
      }
    }

    if (input.now - this.lastHazardAt < 7_500) return undefined

    this.lastHazardAt = input.now
    return {
      kind: 'hazard-classify',
      system: 'Identify the blocking street or indoor obstacle in 1 to 3 words only.',
      prompt: buildAmbientObstaclePrompt(warning.direction ?? 'ahead', warning.distanceMeters ?? 1.6),
      maxImageTokens: 96,
      maxTokens: 16,
      temperature: 0,
      category: `narrator:hazard:${warning.direction ?? 'ahead'}`,
      cooldownMs: 7_500,
      warning,
    }
  }

  /** Polled gently on snapshot/location updates to decide whether a crossing lookahead or passing landmark check is warranted. */
  planProactive(input: NarrationPlannerInput): NarrationTask | undefined {
    if (!input.engineReady || input.busy || input.listening || input.standby) return undefined
    if (input.mode === 'quiet') return undefined
    if (!isProactiveVlmAllowed(input.proactiveVlmAllowed, input.snapshot)) return undefined
    if (!input.snapshot?.trackingReady || input.snapshot.aimState !== 'level') return undefined
    // Never launch ambient narration right after an urgent hazard
    if (input.now - input.lastCriticalAt < 5_000) return undefined

    const lighting = resolveLightingState(input.lightingState, input.snapshot)

    // 1. Turn / Crossing lookahead when approaching a route maneuver (3m..16m away)
    if (
      input.proactiveNarration &&
      input.route?.active &&
      !input.route.arrived &&
      input.route.nextStep &&
      input.route.distanceToNextTurnMeters <= 16 &&
      input.route.distanceToNextTurnMeters >= 3 &&
      input.route.stepIndex !== this.lastCrossingStepIndex &&
      input.now - this.lastCrossingAt >= 18_000
    ) {
      this.lastCrossingStepIndex = input.route.stepIndex
      this.lastCrossingAt = input.now
      const turnHint = input.route.nextStep.instruction
      const dist = formatWalkingDistance(input.route.distanceToNextTurnMeters, input.stepLengthMeters)
      const dirHint = input.directionStyle === 'clock' ? ' Use clock-face directions.' : ''
      const darkNote = lighting === 'dark' ? ` ${DARK_LIGHTING_TELEMETRY_NOTE}` : ''
      return {
        kind: 'crossing-lookahead',
        system: CROSSING_SYSTEM,
        prompt:
          `Upcoming navigation step in ${dist}: "${turnHint}". ` +
          `Describe the kerb, crossing, roadworks, cyclists, or doorway ahead in one short sentence.${dirHint}${darkNote}`,
        maxImageTokens: 128,
        maxTokens: 48,
        temperature: 0.1,
        category: 'narrator:crossing',
        cooldownMs: 18_000,
      }
    }

    // 2. Passing street-scene & landmark narration (only when user has moved or turned!)
    if (!input.proactiveNarration) return undefined
    // Pause non-essential visual street exploration when camera view is dark; LiDAR depth remains active.
    if (lighting === 'dark') return undefined
    const minIntervalMs = input.mode === 'explore' ? 16_000 : 28_000
    if (input.now - this.lastExploreAt < minIntervalMs) return undefined

    const movedEnough =
      this.lastExploreLocation && input.location
        ? haversineMeters(this.lastExploreLocation, input.location) >= 10
        : false
    const turnedEnough =
      this.lastExploreHeading !== undefined && input.headingDeg !== undefined
        ? Math.abs(normalizeAngleOffset(input.headingDeg, this.lastExploreHeading)) >= 50
        : false
    const isFirstExplore = this.lastExploreAt === 0 && input.mode === 'explore'

    if (!isFirstExplore && !movedEnough && !turnedEnough) {
      return undefined
    }

    this.lastExploreAt = input.now
    if (input.location) this.lastExploreLocation = { ...input.location }
    if (input.headingDeg !== undefined) this.lastExploreHeading = input.headingDeg

    const ocr = (input.snapshot.recognizedText ?? []).filter(Boolean).slice(0, 4)
    const ocrNote = ocr.length > 0 ? ` Visible signs: "${ocr.join(', ').slice(0, 120)}".` : ''
    const dirHint = input.directionStyle === 'clock' ? ' Use clock-face directions.' : ''
    const dimNote = lighting === 'dim' ? ' Lighting is dim; report only clearly visible features.' : ''
    const focusLine =
      input.mobilityProfile === 'guide-dog'
        ? 'Prioritize crossings, doorways, shopfront signs, bus stops, or transit entrances ahead rather than routine static obstacles.'
        : 'Name the single most helpful landmark, shopfront, entrance, cyclist, animal, or street hazard visible ahead.'

    return {
      kind: 'street-explore',
      system: EXPLORE_SYSTEM,
      prompt: `${focusLine}${ocrNote}${dirHint}${dimNote}`,
      maxImageTokens: 128,
      maxTokens: 44,
      temperature: 0.15,
      category: 'narrator:explore',
      cooldownMs: minIntervalMs,
    }
  }
}

/** Formats raw TensorFold narrator output into crisp, safe spoken guidance (or undefined if not useful). */
export function formatNarrationOutput(
  task: NarrationTask,
  rawOutput: string,
  options: {
    directionStyle: DirectionStyle
    stepLengthMeters?: number
    recommendedHeadingOffsetDeg?: number
    corridorState?: 'clear' | 'narrow' | 'blocked' | 'unknown'
  },
): string | undefined {
  if (task.kind === 'hazard-classify') {
    const label = parseAmbientObstacleLabel(rawOutput)
    if (!label) return undefined
    const dir = formatDirectionLabel(task.warning?.direction ?? 'ahead', options.directionStyle)
    const dist = task.warning?.distanceMeters !== undefined
      ? formatWalkingDistance(task.warning.distanceMeters, options.stepLengthMeters)
      : ''
    const isMoving = /\b(cyclist|bicycle|pushbike|bike|scooter|e-scooter|runner|skateboard)\b/i.test(label)
    const steer = isMoving
      ? ' — hold still'
      : options.corridorState === 'narrow' &&
          options.recommendedHeadingOffsetDeg !== undefined &&
          Math.abs(options.recommendedHeadingOffsetDeg) >= 15
        ? ` — pass ${options.recommendedHeadingOffsetDeg < 0 ? 'left' : 'right'}`
        : ''
    const titled = label[0]!.toUpperCase() + label.slice(1)
    return `${titled}, ${dir}${dist ? `, ${dist}` : ''}${steer}.`
  }

  const cleaned = sanitizeSpokenVisionOutput(rawOutput)
  if (!cleaned || cleaned.length < 6) return undefined
  if (/^(?:none|nothing|nothing notable|no notable|unclear|cannot tell)\.?$/i.test(cleaned)) {
    return undefined
  }
  return cleaned
}
