import { beforeEach, expect, mock, test } from 'bun:test'
import type { LocationObject } from 'expo-location'

const remove = mock(() => {})
const permission = mock(async () => ({ granted: true, canAskAgain: true }))
const requestPermission = mock(async () => ({ granted: true }))
const coordinates = { latitude: 51.5, longitude: -0.1, accuracy: 25, altitude: null, altitudeAccuracy: null, heading: null, speed: null }
let received: ((position: LocationObject) => void) | undefined
let subscriptionStarted: (() => void) | undefined
const watch = mock(async (_options: unknown, listener: (position: LocationObject) => void) => {
  received = listener
  subscriptionStarted?.()
  return { remove }
})
const geocode = mock(async (_position: unknown) => [{ street: 'High Street', district: 'The Borough', city: 'London' }])

mock.module('react-native', () => ({ Platform: { OS: 'ios' } }))
mock.module('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  getForegroundPermissionsAsync: permission,
  requestForegroundPermissionsAsync: requestPermission,
  watchPositionAsync: watch,
  reverseGeocodeAsync: geocode,
}))

const { describeCurrentLocation } = await import('../src/lib/guidance/location')

beforeEach(() => {
  received = undefined
  subscriptionStarted = undefined
  for (const fn of [remove, permission, requestPermission, watch, geocode]) fn.mockClear()
  permission.mockImplementation(async () => ({ granted: true, canAskAgain: true }))
})

async function beginLookup(request = new AbortController()) {
  const started = new Promise<void>((resolve) => { subscriptionStarted = resolve })
  const lookup = describeCurrentLocation(request.signal, () => {})
  await started
  return { lookup }
}

test('reports a nearby street from a fresh fix and stops watching before geocoding', async () => {
  const { lookup } = await beginLookup()
  received?.({ timestamp: Date.now() - 60_000, coords: coordinates })
  expect(geocode).not.toHaveBeenCalled()
  received?.({ timestamp: Date.now(), coords: coordinates })
  const answer = await lookup
  expect(answer).toBe('Your phone puts you near High Street, The Borough, London.')
  expect(remove).toHaveBeenCalledTimes(1)
})

test('does not resolve a distant fix to a precise street', async () => {
  const { lookup } = await beginLookup()
  received?.({ timestamp: Date.now(), coords: { ...coordinates, accuracy: 800 } })
  expect(await lookup).toBe('Your phone puts you near The Borough, London.')
})

test('does not request access again after the user has denied it', async () => {
  permission.mockImplementation(async () => ({ granted: false, canAskAgain: false }))
  const answer = await describeCurrentLocation(new AbortController().signal, () => {})
  expect(answer).toContain('Location access is off')
  expect(requestPermission).not.toHaveBeenCalled()
  expect(watch).not.toHaveBeenCalled()
})

test('cancels the position subscription without looking up or speaking an address', async () => {
  const request = new AbortController()
  const { lookup } = await beginLookup(request)
  request.abort()
  expect(await lookup).toBeUndefined()
  expect(remove).toHaveBeenCalledTimes(1)
  expect(geocode).not.toHaveBeenCalled()
})
