import { requireOptionalNativeModule } from 'expo'
import { Platform } from 'react-native'

export type HapticDirection = 'ahead' | 'ahead-left' | 'ahead-right' | 'left' | 'right' | 'behind' | 'unknown'
export type HapticSeverity = 'info' | 'caution' | 'urgent'
export type HapticCue =
  | 'mic-open'
  | 'mic-close'
  | 'thinking-tick'
  | 'turn-approaching'
  | 'turn-left'
  | 'turn-right'
  | 'off-route'
  | 'head-hazard'
  | 'drop-off'
  | 'fast-mover'
  | 'animal'
  | 'opening'
  | 'standby'
  | 'arrived'
  | 'paused'
  | 'resumed'

export interface HapticRequest {
  direction: HapticDirection
  severity: HapticSeverity
  /**
   * Optional sensor measurement. Only the close band, 1.5 meters or less,
   * changes intensity. The pattern never encodes an exact distance.
   */
  distanceMeters?: number
}

export interface GuidanceHapticState {
  active: boolean
  steeringEnabled?: boolean
  proximityEnabled?: boolean
  /** Bearing error in degrees (-180..180): 0 means aligned with target heading / clear corridor. */
  headingOffsetDeg?: number
  /** Forward corridor clearance in meters (0..5). */
  forwardClearanceMeters?: number
  muted?: boolean
}

export interface HapticCapabilities {
  platform: 'ios' | 'android' | 'unknown'
  available: boolean
  customPatterns: boolean
  amplitudeControl: boolean
  continuousGuidance?: boolean
  reason: string | null
}

export interface HapticPlayResult {
  status: 'played' | 'unavailable' | 'active' | 'stopped'
  reason?: string
  /** Present after Android playback so callers can tell whether intensity was applied. */
  amplitudeControl?: boolean
}

interface TensorFoldHapticsNativeModule {
  getCapabilities(): Promise<HapticCapabilities>
  play(request: HapticRequest): Promise<HapticPlayResult>
  playCue?(cue: HapticCue): Promise<HapticPlayResult>
  updateGuidance?(state: GuidanceHapticState): Promise<HapticPlayResult>
  stopGuidance?(): Promise<void>
  stop(): Promise<void>
}

const nativeModule = requireOptionalNativeModule<TensorFoldHapticsNativeModule>('TensorFoldHaptics')
const missingModuleReason = 'TensorFoldHaptics is not installed in this build. Rebuild the app with the native module.'

export async function getCapabilities(): Promise<HapticCapabilities> {
  if (!nativeModule) {
    return {
      platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'unknown',
      available: false,
      customPatterns: false,
      amplitudeControl: false,
      continuousGuidance: false,
      reason: missingModuleReason,
    }
  }
  return nativeModule.getCapabilities()
}

/** Plays one finite, learned rhythm. It never produces speech or a continuous vibration. */
export async function play(request: HapticRequest): Promise<HapticPlayResult> {
  if (!nativeModule) {
    return { status: 'unavailable', reason: missingModuleReason }
  }
  return nativeModule.play(request)
}

/** Plays a distinct tactile satnav cue (turn, drop-off, head-hazard, mic-open, arrived, etc.). */
export async function playCue(cue: HapticCue): Promise<HapticPlayResult> {
  if (!nativeModule) {
    return { status: 'unavailable', reason: missingModuleReason }
  }
  if (nativeModule.playCue) {
    return nativeModule.playCue(cue)
  }
  // Android fallback using finite legacy patterns
  const fallback: Record<HapticCue, HapticRequest> = {
    'mic-open': { direction: 'ahead', severity: 'info' },
    'mic-close': { direction: 'ahead', severity: 'info' },
    'thinking-tick': { direction: 'ahead', severity: 'info' },
    'turn-approaching': { direction: 'ahead', severity: 'caution' },
    'turn-left': { direction: 'left', severity: 'caution' },
    'turn-right': { direction: 'right', severity: 'caution' },
    'off-route': { direction: 'behind', severity: 'caution' },
    'head-hazard': { direction: 'ahead', severity: 'urgent', distanceMeters: 0.9 },
    'drop-off': { direction: 'ahead', severity: 'urgent', distanceMeters: 0.8 },
    'fast-mover': { direction: 'ahead', severity: 'urgent', distanceMeters: 0.7 },
    animal: { direction: 'ahead', severity: 'info' },
    opening: { direction: 'ahead', severity: 'info' },
    standby: { direction: 'ahead', severity: 'info' },
    arrived: { direction: 'ahead', severity: 'info' },
    paused: { direction: 'ahead', severity: 'info' },
    resumed: { direction: 'ahead', severity: 'info' },
  }
  return nativeModule.play(fallback[cue])
}

/** Updates the continuous native compass-lock + proximity radar loop. */
export async function updateGuidance(state: GuidanceHapticState): Promise<HapticPlayResult> {
  if (!nativeModule?.updateGuidance) {
    return { status: 'unavailable', reason: missingModuleReason }
  }
  return nativeModule.updateGuidance(state)
}

/** Stops the continuous haptic guidance loop. */
export async function stopGuidance(): Promise<void> {
  await nativeModule?.stopGuidance?.()
}

/** Cancels all patterns, stops guidance loop, and stops the native haptic engine. */
export async function stop(): Promise<void> {
  await nativeModule?.stop()
}
