import type { SceneWarning } from './types'

export class WarningGate {
  private spoken = new Map<string, { at: number; distance?: number }>()

  accept(warning: SceneWarning, now = Date.now()): boolean {
    if (now - warning.observedAt > 3_000) return false
    const previous = this.spoken.get(warning.id)
    if (!previous) {
      this.spoken.set(warning.id, { at: now, distance: warning.distanceMeters })
      return true
    }
    const closer = previous.distance !== undefined && warning.distanceMeters !== undefined && warning.distanceMeters < previous.distance * 0.75
    const cooldown = warning.severity === 'urgent' ? 2_000 : 8_000
    if (!closer && now - previous.at < cooldown) return false
    this.spoken.set(warning.id, { at: now, distance: warning.distanceMeters })
    return true
  }

  reset() {
    this.spoken.clear()
  }
}
