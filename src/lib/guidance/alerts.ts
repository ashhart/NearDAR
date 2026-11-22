import type { SceneWarning } from './types'

const urgency = { info: 0, caution: 1, urgent: 2 }

export function warningIsCurrent(warning: SceneWarning, now = Date.now()): boolean {
  const age = now - warning.observedAt
  return age >= -1_000 && age <= 3_000
}

export class WarningGate {
  private spoken = new Map<string, { warning: SceneWarning; seenAt: number; distance?: number }>()

  accept(warning: SceneWarning, now = Date.now()): boolean {
    if (!warningIsCurrent(warning, now)) return false
    // Depth sensors can assign a new snapshot ID to an otherwise unchanged warning.
    const key = warning.kind === 'obstacle'
      ? warning.id === 'ios-live-obstacle' ? warning.id : `obstacle:${warning.direction ?? 'unknown'}`
      : warning.id
    const previous = this.spoken.get(key)
    if (previous && warning.observedAt < previous.seenAt) return false

    const last = previous?.warning
    const distance = warning.distanceMeters
    const reference = previous?.distance
    const closer = reference !== undefined && distance !== undefined
      && reference - distance >= Math.max(0.2, reference * 0.25)
    const returned = previous && warning.observedAt - previous.seenAt > 2_000
    const escalated = last && urgency[warning.severity] > urgency[last.severity]
    const newName = !!warning.label && warning.label !== last?.label
    if (!last || returned || closer || escalated || warning.direction !== last.direction || newName) {
      this.spoken.set(key, { warning, seenAt: warning.observedAt, distance })
      return true
    }
    previous.seenAt = warning.observedAt
    previous.distance = distance === undefined ? reference : Math.max(distance, reference ?? distance)
    return false
  }

  reset() {
    this.spoken.clear()
  }
}
