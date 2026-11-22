import { expect, test } from 'bun:test'
import { headphonesDisconnected, microphoneRetryNotice, voiceErrorCode } from '../src/lib/guidance/voiceFeedback'
import type { AudioRouteSnapshot } from '../modules/tensorfold-voice/src'

const event = {
  inputs: [], outputs: [], communicationDevice: null, bluetoothMicrophoneAvailable: false, timestamp: 0,
} satisfies Omit<AudioRouteSnapshot, 'reason'>

test('iOS category changes do not look like an unplugged headset', () => {
  expect(headphonesDisconnected('ios', 'headphones', 'speaker', { ...event, reason: 'categoryChange' })).toBe(false)
  expect(headphonesDisconnected('ios', 'speaker', 'speaker', {
    ...event, reason: 'oldDeviceUnavailable', previousOutput: 'headphones',
  })).toBe(true)
  expect(headphonesDisconnected('ios', 'headphones', 'headphones', { ...event, reason: 'oldDeviceUnavailable' })).toBe(false)
  expect(headphonesDisconnected('android', 'headphones', 'speaker')).toBe(true)
})

test('microphone setup failures retain the answer and offer a retry and typed input', () => {
  const code = voiceErrorCode(Object.assign(new Error('System audio activation failed'), { code: 'E_AUDIO_SESSION' }))
  expect(microphoneRetryNotice(code)).toContain('Last answer')
  expect(microphoneRetryNotice(code)).toContain('Ask by voice')
  expect(microphoneRetryNotice(code)).toContain('type your question')
  expect(microphoneRetryNotice('E_MICROPHONE_PERMISSION')).toBeUndefined()
})
