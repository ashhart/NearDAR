import type { AudioRoute, AudioRouteSnapshot } from '../../../modules/tensorfold-voice/src'

export function voiceErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined
}

export function microphoneRetryNotice(code?: string): string | undefined {
  if (code === 'E_AUDIO_SESSION' || code === 'E_MICROPHONE_UNAVAILABLE') {
    return 'The microphone is temporarily unavailable. Your answer stays in Last answer. Choose Ask by voice to try again, or type your question.'
  }
}

export function headphonesDisconnected(
  platform: string, previous: AudioRoute, current: AudioRoute, event?: AudioRouteSnapshot,
): boolean {
  if (current === 'headphones') return false
  return platform === 'ios'
    ? event?.reason === 'oldDeviceUnavailable' && (event.previousOutput ?? previous) === 'headphones'
    : previous === 'headphones'
}
