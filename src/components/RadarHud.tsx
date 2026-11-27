import { StyleSheet, Text, View } from 'react-native'
import type { FusedSatnavGuidance } from '../lib/navigation/fusion'
import type { CorridorSummary } from '../../modules/tensorfold-perception/src'
import type { SceneSnapshot } from '../lib/guidance/types'
import { cardinalDirection, turnPhraseFromOffset } from '../lib/navigation/geo'
import { extractLiveEntityChips } from '../lib/satnav/arbitrator'
import { Icon, useColors } from './ui'

interface Props {
  corridor?: CorridorSummary
  snapshot?: SceneSnapshot
  fused: FusedSatnavGuidance
  headingDegrees?: number
  active: boolean
}

const DEFAULT_ANGLES = [-45, -30, -15, 0, 15, 30, 45]

function sectorColor(clearance: number, isRecommended: boolean): string {
  if (clearance < 0.9) return '#EF4444'
  if (clearance < 1.8) return '#F59E0B'
  return isRecommended ? '#10B981' : '#38BDF8'
}

export function RadarHud({ corridor, snapshot, fused, headingDegrees, active }: Props) {
  const colors = useColors()
  const sectors = !fused.standby && corridor?.valid && corridor.sectors.length === 7
    ? corridor.sectors
    : DEFAULT_ANGLES.map((deg, index) => ({
        index,
        centerDegrees: deg,
        label: '',
        clearanceMeters: 0,
        sampleCount: 0,
        confidence: 0,
      }))

  const entityChips = extractLiveEntityChips(snapshot)
  const offset = fused.steeringOffsetDeg
  const steerLabel = fused.standby
    ? (fused.aimState === 'covered' ? 'CAMERA COVERED' : 'STANDBY · ROUTE ACTIVE')
    : fused.primaryHazard && (fused.primaryHazard.severity === 'urgent' || fused.primaryHazard.kind !== 'obstacle')
      ? fused.primaryHazard.kind === 'fast-mover'
        ? 'FAST MOVEMENT · HOLD STILL'
        : fused.primaryHazard.kind === 'head-height'
          ? 'HEAD HAZARD'
          : fused.primaryHazard.kind === 'drop-off' || fused.primaryHazard.kind === 'step-down'
            ? 'DROP-OFF AHEAD'
            : 'STOP · OBSTACLE'
      : offset !== undefined
        ? turnPhraseFromOffset(offset).toUpperCase()
        : active
          ? 'SCANNING PATH'
          : 'PAUSED'

  const hazardActive = Boolean(
    !fused.standby &&
    fused.primaryHazard &&
    (fused.primaryHazard.severity === 'urgent' ||
      fused.primaryHazard.kind === 'fast-mover' ||
      fused.primaryHazard.kind === 'head-height' ||
      fused.primaryHazard.kind === 'drop-off' ||
      fused.primaryHazard.kind === 'step-down'),
  )

  const arrowIcon = hazardActive
    ? 'warning'
    : fused.standby
      ? 'moon-outline'
      : offset === undefined
        ? 'radio-outline'
        : Math.abs(offset) <= 15
          ? 'arrow-up'
          : offset < -125 || offset > 125
            ? 'return-down-back'
            : offset < 0
              ? 'arrow-back'
              : 'arrow-forward'

  const clearanceText = fused.standby
    ? 'Compass & GPS on'
    : fused.forwardClearanceMeters !== undefined
      ? fused.forwardClearanceMeters >= 4.5
        ? '4.5m+ ahead'
        : `${fused.forwardClearanceMeters.toFixed(1)}m ahead`
      : 'Depth warming…'

  const compassText = headingDegrees !== undefined
    ? `${cardinalDirection(headingDegrees).toUpperCase()} · ${Math.round(headingDegrees)}°`
    : 'Compass ready'

  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.container,
        {
          backgroundColor: hazardActive ? colors.stopSurface : colors.panel,
          borderColor: hazardActive ? colors.stop : colors.divider,
        },
      ]}
    >
      <View style={styles.topMeta}>
        <Text style={[styles.metaText, { color: colors.muted }]}>{compassText}</Text>
        <Text style={[styles.metaText, { color: hazardActive ? colors.stop : colors.text }]}>{clearanceText}</Text>
      </View>

      <View style={styles.barsRow}>
        {sectors.map((sector) => {
          const valid = !fused.standby && corridor?.valid
          const ratio = valid ? Math.max(0.12, Math.min(1, sector.clearanceMeters / 4.5)) : 0.14
          const isBest = valid && offset !== undefined && Math.abs(sector.centerDegrees - offset) <= 10
          const fill = valid ? sectorColor(sector.clearanceMeters, Boolean(isBest)) : colors.border
          return (
            <View key={sector.index} style={styles.barColumn}>
              <View style={[styles.barTrack, { backgroundColor: colors.raised }]}>
                <View style={[styles.barFill, { height: `${Math.round(ratio * 100)}%`, backgroundColor: fill }]} />
              </View>
              <View style={[styles.sectorDot, { backgroundColor: isBest ? fill : 'transparent' }]} />
            </View>
          )
        })}
      </View>

      <View style={styles.steerRow}>
        <View style={[styles.arrowBadge, { backgroundColor: hazardActive ? colors.stop : colors.accent }]}>
          <Icon name={arrowIcon} size={22} color={colors.ink} />
        </View>
        <Text numberOfLines={1} style={[styles.steerText, { color: hazardActive ? colors.stop : colors.text }]}>
          {steerLabel}
        </Text>
      </View>

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
                  : colors.raised
            return (
              <View key={chip.id} style={[styles.chip, { backgroundColor: chipBg, borderColor: chipColor }]}>
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
  container: {
    borderRadius: 20,
    borderWidth: 1.5,
    padding: 14,
    gap: 12,
  },
  topMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metaText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  barsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    height: 58,
    gap: 8,
  },
  barColumn: {
    flex: 1,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
  },
  barTrack: {
    width: '100%',
    flex: 1,
    borderRadius: 8,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  barFill: {
    width: '100%',
    borderRadius: 8,
  },
  sectorDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  steerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  arrowBadge: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  steerText: {
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: 0.5,
    flex: 1,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
    borderWidth: 1.5,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '800',
  },
})
