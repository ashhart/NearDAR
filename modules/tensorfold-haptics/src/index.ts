import { requireOptionalNativeModule } from 'expo'
import { Platform } from 'react-native'

export type HapticDirection = 'ahead' | 'ahead-left' | 'ahead-right' | 'left' | 'right' | 'behind' | 'unknown'
export type HapticSeverity = 'info' | 'caution' | 'urgent'

export interface HapticRequest {
  direction: HapticDirection
  severity: HapticSeverity
  /**
   * Optional sensor measurement. Only the close band, 1.5 meters or less,
   * changes intensity. The pattern never encodes an exact distance.
   */
  distanceMeters?: number
}

export interface HapticCapabilities {
  platform: 'ios' | 'android' | 'unknown'
  available: boolean
  customPatterns: boolean
  amplitudeControl: boolean
  reason: string | null
}

export interface HapticPlayResult {
  status: 'played' | 'unavailable'
  reason?: string
  /** Present after Android playback so callers can tell whether intensity was applied. */
  amplitudeControl?: boolean
}

interface TensorFoldHapticsNativeModule {
  getCapabilities(): Promise<HapticCapabilities>
  play(request: HapticRequest): Promise<HapticPlayResult>
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

/** Cancels the current pattern and stops the native haptic engine. Safe without hardware. */
export async function stop(): Promise<void> {
  await nativeModule?.stop()
}
