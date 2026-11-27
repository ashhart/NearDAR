import { StyleSheet, Text, View } from 'react-native'
import type { FusedSatnavGuidance } from '../lib/navigation/fusion'
import type { CorridorSummary } from '../../modules/tensorfold-perception/src'
import type { DistanceUnit, SceneSnapshot } from '../lib/guidance/types'
import { cardinalDirection, turnPhraseFromOffset } from '../lib/navigation/geo'
import { extractLiveEntityChips, formatShortDistance } from '../lib/satnav/arbitrator'
import { Icon, useColors } from './ui'

interface Props {
  corridor?: CorridorSummary
  snapshot?: SceneSnapshot
  fused: FusedSatnavGuidance
  headingDegrees?: number
  distanceUnit?: DistanceUnit
  active: boolean
}

const DEFAULT_ANGLES = [-45, -30, -15, 0, 15, 30, 45]
/** Subtle parabolic elevation offsets (px) creating a natural forward-facing sonar arc. */
const ARC_LIFT = [14, 7, 2, 0, 2, 7, 14]

function sectorColor(clearance: number, isRecommended: boolean, accent: string): string {
  if (clearance < 0.9) return '#FF453A'
  if (clearance < 1.8) return '#FFB340'
  return isRecommended ? '#30D158' : accent
}

function shortCardinal(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8
  return dirs[idx] ?? cardinalDirection(deg).toUpperCase()
}

export function RadarHud({ corridor, snapshot, fused, headingDegrees, distanceUnit = 'metric', active }: Props) {
  const colors = useColors()
  const sectors =
    !fused.standby && corridor?.valid && corridor.sectors.length === 7
      ? corridor.sectors
      : DEFAULT_ANGLES.map((deg, index) => ({
          index,
          centerDegrees: deg,
          label: '',
          clearanceMeters: 0,
          sampleCount: 0,
          confidence: 0,
        }))

  const baseChips = extractLiveEntityChips(snapshot, distanceUnit)
  const extraChips: typeof baseChips = []
  if (snapshot?.lightingState === 'dark') {
    extraChips.push({
      id: 'dark-light',
      label: snapshot.depthSource === 'lidar' ? 'Night · LiDAR' : 'Low light',
      tone: 'warn',
    })
  }
  if (snapshot?.thermalState === 'serious' || snapshot?.thermalState === 'critical') {
    extraChips.push({ id: 'thermal', label: 'Cooling', tone: 'warn' })
  }
  if (snapshot?.depthSource === 'feature-points') {
    extraChips.push({ id: 'depth-fallback', label: 'Camera depth', tone: 'accent' })
  }
  const entityChips = [...baseChips, ...extraChips].slice(0, 4)
  const offset = fused.steeringOffsetDeg

  const hazardActive = Boolean(
    !fused.standby &&
      fused.primaryHazard &&
      (fused.primaryHazard.severity === 'urgent' ||
        fused.primaryHazard.kind === 'fast-mover' ||
        fused.primaryHazard.kind === 'head-height' ||
        fused.primaryHazard.kind === 'drop-off' ||
        fused.primaryHazard.kind === 'step-down'),
  )

  const steerTitle = fused.standby
    ? fused.aimState === 'covered'
      ? 'Lens Covered'
      : 'Standby Mode'
    : hazardActive && fused.primaryHazard
      ? fused.primaryHazard.kind === 'fast-mover'
        ? 'Hold Still'
        : fused.primaryHazard.kind === 'head-height'
          ? 'Head Hazard'
          : fused.primaryHazard.kind === 'drop-off' || fused.primaryHazard.kind === 'step-down'
            ? 'Drop-Off Ahead'
            : 'Stop Ahead'
      : offset !== undefined
        ? turnPhraseFromOffset(offset).replace(/^./, (c) => c.toUpperCase())
        : active
          ? 'Scanning Path'
          : 'Paused'

  const steerSub = fused.standby
    ? 'Route & compass active'
    : hazardActive && fused.primaryHazard
      ? fused.primaryHazard.kind === 'fast-mover'
        ? 'Fast movement approaching'
        : `${formatShortDistance(fused.primaryHazard.distanceMeters, distanceUnit)} · ${fused.primaryHazard.direction.replace('-', ' ')}`
      : fused.forwardClearanceMeters !== undefined
        ? fused.forwardClearanceMeters >= 4.5
          ? distanceUnit === 'imperial'
            ? '15 ft+ open ahead'
            : '4.5 m+ open ahead'
          : `${formatShortDistance(fused.forwardClearanceMeters, distanceUnit)} clearance ahead`
        : 'Warming depth sensor…'

  const arrowIcon = hazardActive
    ? 'warning'
    : fused.standby
      ? 'moon'
      : offset === undefined
        ? 'radio-outline'
        : Math.abs(offset) <= 15
          ? 'arrow-up'
          : offset < -125 || offset > 125
            ? 'return-down-back'
            : offset < 0
              ? 'arrow-back'
              : 'arrow-forward'

  const compassText =
    headingDegrees !== undefined
      ? `${shortCardinal(headingDegrees)} ${Math.round(headingDegrees)}°`
      : 'Compass'

  const distanceBadge = fused.standby
    ? 'GPS Only'
    : fused.forwardClearanceMeters !== undefined
      ? fused.forwardClearanceMeters >= 4.5
        ? distanceUnit === 'imperial'
          ? '15ft+'
          : '4.5m+'
        : formatShortDistance(fused.forwardClearanceMeters, distanceUnit)
      : '—'

  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={styles.root}
    >
      {/* Minimal telemetry strip */}
      <View style={styles.metaRow}>
        <View style={[styles.metaPill, { backgroundColor: colors.raised }]}>
          <Icon name="compass-outline" size={14} color={colors.muted} />
          <Text style={[styles.metaText, { color: colors.text }]}>{compassText}</Text>
        </View>
        <View
          style={[
            styles.metaPill,
            { backgroundColor: hazardActive ? colors.stopSurface : colors.raised },
          ]}
        >
          <Text style={[styles.metaText, { color: hazardActive ? colors.stop : colors.text }]}>
            {distanceBadge}
          </Text>
        </View>
      </View>

      {/* Arced 7-sector spatial LiDAR sonar visualizer */}
      <View style={styles.sonarField}>
        <View style={styles.arcRow}>
          {sectors.map((sector, idx) => {
            const valid = !fused.standby && corridor?.valid
            const ratio = valid ? Math.max(0.14, Math.min(1, sector.clearanceMeters / 4.5)) : 0.18
            const isBest = valid && offset !== undefined && Math.abs(sector.centerDegrees - offset) <= 10
            const fill = valid ? sectorColor(sector.clearanceMeters, Boolean(isBest), colors.accent) : colors.border
            const lift = ARC_LIFT[idx] ?? 0
            return (
              <View key={sector.index} style={[styles.rayCol, { paddingTop: lift }]}>
                <View style={[styles.rayTrack, { backgroundColor: colors.raised }]}>
                  <View
                    style={[
                      styles.rayFill,
                      {
                        height: `${Math.round(ratio * 100)}%`,
                        backgroundColor: fill,
                        opacity: isBest ? 1 : 0.82,
                      },
                    ]}
                  />
                </View>
                <View
                  style={[
                    styles.rayBeacon,
                    { backgroundColor: isBest ? fill : 'transparent' },
                  ]}
                />
              </View>
            )
          })}
        </View>
      </View>

      {/* Hero steering indicator */}
      <View style={styles.heroRow}>
        <View
          style={[
            styles.heroOrb,
            {
              backgroundColor: hazardActive ? colors.stop : colors.accent,
            },
          ]}
        >
          <Icon name={arrowIcon} size={26} color={hazardActive ? '#FFFFFF' : colors.ink} />
        </View>
        <View style={styles.heroCopy}>
          <Text
            numberOfLines={1}
            style={[styles.heroTitle, { color: hazardActive ? colors.stop : colors.text }]}
          >
            {steerTitle}
          </Text>
          <Text numberOfLines={1} style={[styles.heroSub, { color: colors.muted }]}>
            {steerSub}
          </Text>
        </View>
      </View>

      {/* Subtle borderless tinted entity chips */}
      {entityChips.length > 0 && (
        <View style={styles.chipRow}>
          {entityChips.map((chip) => {
            const chipColor =
              chip.tone === 'danger'
                ? colors.stop
                : chip.tone === 'warn'
                  ? colors.warning
                  : chip.tone === 'clear'
                    ? colors.ready
                    : colors.accent
            const chipBg =
              chip.tone === 'danger'
                ? colors.stopSurface
                : chip.tone === 'warn'
                  ? colors.warningSurface
                  : chip.tone === 'clear'
                    ? colors.readySurface
                    : colors.accentSoft
            return (
              <View key={chip.id} style={[styles.chip, { backgroundColor: chipBg }]}>
                <View style={[styles.chipDot, { backgroundColor: chipColor }]} />
                <Text style={[styles.chipText, { color: chipColor }]}>{chip.label}</Text>
              </View>
            )
          })}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    gap: 16,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metaPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  metaText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.4,
    fontVariant: ['tabular-nums'],
  },
  sonarField: {
    paddingVertical: 4,
  },
  arcRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    height: 82,
    gap: 10,
    paddingHorizontal: 6,
  },
  rayCol: {
    flex: 1,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
  },
  rayTrack: {
    width: '100%',
    maxWidth: 26,
    flex: 1,
    borderRadius: 999,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  rayFill: {
    width: '100%',
    borderRadius: 999,
  },
  rayBeacon: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  heroOrb: {
    width: 48,
    height: 48,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroCopy: {
    flex: 1,
    gap: 2,
  },
  heroTitle: {
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  heroSub: {
    fontSize: 14,
    fontWeight: '600',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
  },
  chipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: -0.1,
  },
})
