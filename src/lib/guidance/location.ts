import type { LocationObject, LocationSubscription } from 'expo-location'
import { Platform } from 'react-native'

type LocationModule = typeof import('expo-location')

function freshPosition(location: LocationModule, signal: AbortSignal): Promise<LocationObject | undefined> {
  return new Promise((resolve) => {
    let subscription: LocationSubscription | undefined
    let finished = false
    const timer = setTimeout(() => finish(), 12_000)

    function finish(position?: LocationObject) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', finishAborted)
      subscription?.remove()
      resolve(position)
    }

    function finishAborted() { finish() }

    if (signal.aborted) return finish()
    signal.addEventListener('abort', finishAborted, { once: true })
    void location.watchPositionAsync(
      { accuracy: location.Accuracy.Balanced, timeInterval: 1_000, distanceInterval: 0, mayShowUserSettingsDialog: false },
      (position) => { if (Date.now() - position.timestamp <= 15_000) finish(position) },
      finishAborted,
    ).then((watch) => {
      if (finished) watch.remove()
      else subscription = watch
    }, finishAborted)
  })
}

async function nearbyAddress(location: LocationModule, position: LocationObject, signal: AbortSignal) {
  return new Promise<string | undefined>((resolve) => {
    const timeout = setTimeout(() => finish(), 5_000)
    function finish(address?: string) {
      clearTimeout(timeout)
      signal.removeEventListener('abort', cancel)
      resolve(address)
    }
    function cancel() { finish() }
    if (signal.aborted) return cancel()
    signal.addEventListener('abort', cancel, { once: true })
    void location.reverseGeocodeAsync(position.coords).then(([place]) => {
      if (!place) return finish()
      const street = position.coords.accuracy !== null && position.coords.accuracy <= 120 ? place.street : null
      const pieces = [street, place.district || place.city || place.subregion, place.city || place.region]
        .filter((part): part is string => !!part)
      finish([...new Set(pieces)].join(', '))
    }, cancel)
  })
}

export async function describeCurrentLocation(signal: AbortSignal, permissionPending: (pending: boolean) => void): Promise<string | undefined> {
  if (Platform.OS === 'web') return 'Open NearDAR on your phone to hear your current location.'
  const location = await import('expo-location').catch(() => null)
  if (signal.aborted) return
  if (!location) return 'Update the NearDAR mobile app to look up your location.'
  const current = await location.getForegroundPermissionsAsync()
  if (signal.aborted) return
  let granted = current.granted
  if (!granted && current.canAskAgain) {
    permissionPending(true)
    try {
      granted = (await location.requestForegroundPermissionsAsync()).granted
    } finally {
      permissionPending(false)
    }
  }
  if (signal.aborted) return
  if (!granted) return 'Location access is off. You can allow it in your phone settings.'
  const position = await freshPosition(location, signal)
  if (signal.aborted) return
  if (!position) return 'I couldn’t get a current location. Try again where your phone has a clearer signal.'
  const address = await nearbyAddress(location, position, signal)
  if (signal.aborted) return
  const { latitude, longitude } = position.coords
  const coordinates = `${Math.abs(latitude).toFixed(4)} degrees ${latitude < 0 ? 'south' : 'north'}, ${Math.abs(longitude).toFixed(4)} degrees ${longitude < 0 ? 'west' : 'east'}`
  return address ? `Your phone puts you near ${address}.` : `Your approximate coordinates are ${coordinates}. I couldn’t look up the street name.`
}
