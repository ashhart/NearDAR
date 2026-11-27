import type { GuidanceSettings, MobilityProfile, SceneWarning } from '../guidance/types'

export type LivePresenceKind = 'animal' | 'person' | 'crowd' | 'opening'

export interface MobilityProfileConfig {
  id: MobilityProfile
  label: string
  shortDescription: string
  recommendedSettings: Partial<GuidanceSettings>
  emphasizes: string[]
  suppresses: string[]
}

export const MOBILITY_PROFILE_ORDER: readonly MobilityProfile[] = [
  'standard',
  'cane',
  'guide-dog',
  'low-vision',
] as const

export const MOBILITY_PROFILES: Record<MobilityProfile, MobilityProfileConfig> = {
  standard: {
    id: 'standard',
    label: 'Balanced',
    shortDescription: 'Full hazard alerts, nearby people and pets, doorways, and proactive street narration.',
    recommendedSettings: {
      mobilityProfile: 'standard',
      ambientObstacleNaming: true,
      proactiveNarration: true,
      hapticSteering: true,
      hapticProximity: true,
      urgentHaptics: true,
      warningDistanceMeters: 2.2,
    },
    emphasizes: ['fast-mover', 'head-height', 'drop-off', 'step-down', 'step-up', 'obstacle', 'doorway', 'animals', 'people', 'landmarks'],
    suppresses: [],
  },
  cane: {
    id: 'cane',
    label: 'White Cane',
    shortDescription: 'Cuts low static ground obstacle chatter while emphasizing fast movers, overhead hazards, drop-offs, doorways, crossings, landmarks, and animals.',
    recommendedSettings: {
      mobilityProfile: 'cane',
      ambientObstacleNaming: false,
      proactiveNarration: true,
      hapticSteering: true,
      hapticProximity: true,
      urgentHaptics: true,
      warningDistanceMeters: 2.0,
    },
    emphasizes: ['fast-mover', 'head-height', 'drop-off', 'step-down', 'doorway', 'crossings', 'landmarks', 'animals'],
    suppresses: ['non-urgent ground obstacles', 'non-urgent steps up'],
  },
  'guide-dog': {
    id: 'guide-dog',
    label: 'Guide Dog Handler',
    shortDescription: 'Lets your dog route around routine static obstacles and pedestrians while prioritizing fast movers, head-height hazards, doorways, signs, crossings, and transit.',
    recommendedSettings: {
      mobilityProfile: 'guide-dog',
      ambientObstacleNaming: false,
      proactiveNarration: true,
      hapticSteering: true,
      hapticProximity: false,
      urgentHaptics: true,
      warningDistanceMeters: 2.0,
    },
    emphasizes: ['fast-mover', 'head-height', 'drop-off', 'doorway', 'signs', 'crossings', 'transit', 'animals'],
    suppresses: ['routine static obstacles', 'routine kerbs and steps', 'single pedestrians'],
  },
  'low-vision': {
    id: 'low-vision',
    label: 'Low Vision',
    shortDescription: 'Enables OLED high-contrast visuals with HUD entity chips, keeps steps, kerbs, drop-offs, and overhead alerts active, and minimizes verbal clutter.',
    recommendedSettings: {
      mobilityProfile: 'low-vision',
      oledHighContrast: true,
      ambientObstacleNaming: false,
      proactiveNarration: false,
      hapticSteering: true,
      hapticProximity: true,
      urgentHaptics: true,
      warningDistanceMeters: 2.2,
    },
    emphasizes: ['fast-mover', 'head-height', 'drop-off', 'step-down', 'step-up', 'hud-chips', 'high-contrast'],
    suppresses: ['distant static obstacle chatter', 'routine single-person and opening chatter'],
  },
}

/** Returns a fresh settings patch applying the profile and its O&M recommended defaults. */
export function applyProfilePatch(profile: MobilityProfile): Partial<GuidanceSettings> {
  return { ...MOBILITY_PROFILES[profile].recommendedSettings }
}

/**
 * O&M hazard announcement filter tailored to the user's mobility aid.
 * Never suppresses critical fast movers, head-height hazards, severe drop-offs, doorways, or sensor recovery alerts.
 */
export function shouldAnnounceHazardForProfile(
  kind: SceneWarning['kind'],
  severity: SceneWarning['severity'],
  distanceMeters: number | undefined,
  profile: MobilityProfile,
): boolean {
  // Always announce universal high-risk & orientation hazards across every mobility profile
  if (
    kind === 'fast-mover' ||
    kind === 'head-height' ||
    kind === 'drop-off' ||
    kind === 'doorway' ||
    kind === 'sensor'
  ) {
    return true
  }

  switch (profile) {
    case 'standard':
      return true

    case 'cane':
      // White cane sweeps the ground arc reliably, so suppress non-urgent static ground obstacles and steps up.
      if (kind === 'obstacle') {
        return severity === 'urgent'
      }
      if (kind === 'step-up') {
        return severity === 'urgent'
      }
      // Keep downward steps/kerbs active for early warning before cane tip drops off.
      return true

    case 'guide-dog':
      // Trained guide dogs route around routine static obstacles and stop smoothly at kerbs/steps.
      // Only warn on an imminent direct collision (<= 0.6m) or urgent step-down.
      if (kind === 'obstacle') {
        return severity === 'urgent' && distanceMeters !== undefined && distanceMeters <= 0.6
      }
      if (kind === 'step-up') {
        return false
      }
      if (kind === 'step-down') {
        return severity === 'urgent'
      }
      return true

    case 'low-vision':
      // Low-vision travelers struggle most with low-contrast depth edges (steps, kerbs, drop-offs) and head hazards.
      if (kind === 'step-up' || kind === 'step-down') {
        return true
      }
      if (kind === 'obstacle') {
        return severity === 'urgent' || (distanceMeters !== undefined && distanceMeters <= 1.2)
      }
      return true
  }
}

/**
 * O&M live presence announcement filter tailored to the user's mobility aid.
 */
export function shouldAnnouncePresenceForProfile(
  kind: LivePresenceKind,
  profile: MobilityProfile,
): boolean {
  switch (profile) {
    case 'standard':
      return true

    case 'cane':
      // Animals (easily startled/tripped over), doorways/openings, crowds, and close people are all valuable for cane users.
      return true

    case 'guide-dog':
      // Dogs route effortlessly around single pedestrians; keep animals (other dogs/cats), doorways, and dense crowds.
      return kind !== 'person'

    case 'low-vision':
      // Keep low-contrast foot-level animals and crowds; rely on HUD chips for routine people and openings to reduce verbal clutter.
      return kind === 'animal' || kind === 'crowd'
  }
}
