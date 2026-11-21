import { describe, expect, test } from 'bun:test'
import { WarningGate } from '../src/lib/guidance/alerts'
import { parseIntent } from '../src/lib/guidance/intents'
import { answerAhead, answerMeasuredAhead, answerQuestion, answerSeats, cameraRecoveryHint, objectPhrase, seatAlignmentTarget, validatedGeneratedAnswer } from '../src/lib/guidance/scene'
import { mergeVisionEvidence } from '../src/lib/guidance/vision'
import type { SceneObject, SceneSnapshot, SceneWarning } from '../src/lib/guidance/types'

const lamppost: SceneObject = {
  id: 'track-7', label: 'lamppost', confidence: 0.88, direction: 'right', distanceMeters: 1.3, stepEstimate: 2, evidence: ['detector', 'depth'],
}
const snapshot: SceneSnapshot = {
  observedAt: Date.now(), sequence: 4, trackingReady: true, depthState: 'ready', validDepthFraction: 0.8,
  cameraOrientation: 'calibrated-forward', objects: [lamppost], freeSeats: [], recognizedText: [], notes: [],
}

describe('voice commands', () => {
  test('separates navigation and conversation commands', () => {
    expect(parseIntent('Find an empty chair')).toEqual({ kind: 'seat' })
    expect(parseIntent('Help me find a seat')).toEqual({ kind: 'seat' })
    expect(parseIntent('Stop listening')).toEqual({ kind: 'stop-listening' })
    expect(parseIntent('Stop camera')).toEqual({ kind: 'stop-session' })
    expect(parseIntent('Check again')).toEqual({ kind: 'check-again' })
    expect(parseIntent('Align to the seat.')).toEqual({ kind: 'align-seat' })
    expect(parseIntent('Stop alignment')).toEqual({ kind: 'stop-alignment' })
    expect(parseIntent('What can I ask?')).toEqual({ kind: 'voice-help' })
    expect(parseIntent('Look left')).toEqual({ kind: 'question', question: 'What is on my left?' })
    expect(parseIntent('Check to my right.')).toEqual({ kind: 'question', question: 'What is on my right?' })
    expect(parseIntent('At a restaurant, which seat should I sit at?')).toEqual({ kind: 'seat' })
    expect(parseIntent('Where can we sit?')).toEqual({ kind: 'seat' })
    expect(parseIntent('Read the menu')).toEqual({ kind: 'read' })
    expect(parseIntent('Where am I?')).toEqual({ kind: 'location' })
    expect(parseIntent('Call me Maya.')).toEqual({ kind: 'remember-name', name: 'Maya' })
    expect(parseIntent('Forget my name')).toEqual({ kind: 'forget-name' })
    expect(parseIntent('stop')).toEqual({ kind: 'stop-speech' })
    expect(parseIntent('Pause guidance')).toEqual({ kind: 'stop-session' })
    expect(parseIntent('Where is the checkout?')).toEqual({ kind: 'question', question: 'Where is the checkout?' })
  })
})

describe('grounded scene speech', () => {
  test('explains how to recover when camera tracking is slow or limited', () => {
    expect(cameraRecoveryHint({ ...snapshot, notes: ['Tracking is limited by excessive motion.'] })).toContain('Hold the phone steady')
    expect(cameraRecoveryHint({ ...snapshot, notes: ['Tracking needs more visible surface detail.'] })).toContain('well-lit object')
    expect(cameraRecoveryHint(undefined)).toContain('Keep the lens uncovered')
  })

  test('answers a typed question about one side using only objects on that side', () => {
    const leftObject: SceneObject = { ...lamppost, id: 'vision-left', label: 'chair', direction: 'ahead-left', distanceMeters: undefined, stepEstimate: undefined, evidence: ['on-device-vlm'] }
    const view = { ...snapshot, objects: [lamppost, leftObject] }
    expect(answerQuestion('What’s on my left?', view)).toBe('Looks like chair ahead to your left.')
    expect(answerQuestion('Is there a lamppost to my left?', view)).not.toContain('lamppost')
  })

  test('speaks the supplied obstacle direction and coarse step estimate', () => {
    expect(objectPhrase(lamppost)).toBe('lamppost to your right, about 2 steps')
    expect(answerAhead(snapshot)).toContain('lamppost to your right')
  })

  test('answers immediately from recent measured depth without relying on appearance', () => {
    const visualOnly: SceneObject = { ...lamppost, id: 'vision-8', label: 'chair', evidence: ['on-device-vlm'] }
    const recent: SceneSnapshot = { ...snapshot, observedAt: 1_000, objects: [lamppost, visualOnly] }
    expect(answerMeasuredAhead(recent, 1_250)).toBe('lamppost to your right, about 2 steps.')
    expect(answerMeasuredAhead(recent, 1_751)).toBeUndefined()
    expect(answerMeasuredAhead(recent, 999)).toBeUndefined()
    expect(answerMeasuredAhead({ ...recent, trackingReady: false }, 1_250)).toBeUndefined()
    expect(answerMeasuredAhead({ ...recent, depthState: 'limited' }, 1_250)).toBeUndefined()
    expect(answerMeasuredAhead({ ...recent, objects: [visualOnly] }, 1_250)).toBeUndefined()
  })

  test('does not invent a free seat or a clear scene', () => {
    expect(answerSeats(snapshot)).toContain('cannot confidently identify a free seat')
    expect(answerSeats(snapshot)).not.toContain('safe')
    expect(answerAhead({ ...snapshot, objects: [] })).toContain('cannot confidently name anything')
  })

  test('aligns only to the measured seat that the answer refers to', () => {
    const left: SceneObject = { ...lamppost, id: 'mesh-left-seat', label: 'seat', direction: 'left' }
    const right: SceneObject = { ...left, id: 'mesh-right-seat', direction: 'right' }
    const captured = { ...snapshot, objects: [left, right] }
    const merged = {
      ...captured, objects: [left],
      freeSeats: [{ ...right, id: `candidate-${right.id}`, free: true, evidence: ['on-device-vlm'] }],
    }
    expect(seatAlignmentTarget(merged, captured)).toEqual({ id: right.id, observedAt: captured.observedAt })
    expect(seatAlignmentTarget({ ...merged, depthState: 'stale' }, captured)).toBeUndefined()
    const visualOnly = { ...snapshot, objects: [{ ...left, id: 'vision-1' }] }
    expect(seatAlignmentTarget(visualOnly, visualOnly)).toBeUndefined()
  })

  test('rejects unsupported evidence, invented measurements, and safe-path claims', () => {
    expect(validatedGeneratedAnswer('{"answer":"A lamppost is at 7 metres.","evidenceIds":["track-7"]}', snapshot)).toBeNull()
    expect(validatedGeneratedAnswer('{"answer":"The path is clear.","evidenceIds":["track-7"]}', snapshot)).toBeNull()
    expect(validatedGeneratedAnswer('{"answer":"A lamppost is to your right.","evidenceIds":["other"]}', snapshot)).toBeNull()
    expect(validatedGeneratedAnswer('{"answer":"A dog is to your right.","evidenceIds":["track-7"]}', snapshot)).toBeNull()
    expect(validatedGeneratedAnswer('{"answer":"A lamppost is to your left.","evidenceIds":["track-7"]}', snapshot)).toBeNull()
    expect(validatedGeneratedAnswer('{"answer":"A lamppost is to your right, about 1.3 metres.","evidenceIds":["track-7"]}', snapshot)).toBe('A lamppost is to your right, about 1.3 metres.')
  })

  test('binds generated directions and measurements to the named object and unit', () => {
    const chair: SceneObject = { id: 'chair-1', label: 'chair', confidence: 0.8, direction: 'left', distanceMeters: 7, stepEstimate: 11, evidence: ['detector', 'depth'] }
    const twoObjects = { ...snapshot, objects: [lamppost, chair] }
    expect(validatedGeneratedAnswer('{"answer":"A lamppost is to your left.","evidenceIds":["track-7","chair-1"]}', twoObjects)).toBeNull()
    expect(validatedGeneratedAnswer('{"answer":"A lamppost is about 7 metres away.","evidenceIds":["track-7"]}', twoObjects)).toBeNull()
    expect(validatedGeneratedAnswer('{"answer":"A lamppost is about 1.3 steps away.","evidenceIds":["track-7"]}', snapshot)).toBeNull()
    expect(validatedGeneratedAnswer('{"answer":"A lamppost is about 2 metres away.","evidenceIds":["track-7"]}', snapshot)).toBeNull()
  })

  test('accepts only spelled measurements from the named object', () => {
    expect(validatedGeneratedAnswer('{"answer":"A lamppost is about two metres away.","evidenceIds":["track-7"]}', snapshot)).toBeNull()
    expect(validatedGeneratedAnswer('{"answer":"A lamppost is about two steps away.","evidenceIds":["track-7"]}', snapshot)).toBe('A lamppost is about two steps away.')
  })

  test('rejects generated occupancy claims without a validated free-seat candidate', () => {
    const occupied: SceneObject = { id: 'chair-1', label: 'chair', confidence: 0.8, direction: 'left', evidence: ['detector', 'depth'], occupied: true }
    expect(validatedGeneratedAnswer('{"answer":"The chair is unoccupied.","evidenceIds":["chair-1"]}', { ...snapshot, objects: [occupied] })).toBeNull()

    const chair: SceneObject = { id: 'chair-1', label: 'chair', confidence: 0.8, direction: 'left', evidence: ['detector', 'depth'], occupied: false }
    const enriched = mergeVisionEvidence('{"objects":[{"label":"chair","direction":"left"}],"unoccupiedSeats":[{"label":"chair","direction":"left"}],"uncertainty":"Seat fully visible"}', { ...snapshot, objects: [chair] })
    expect(validatedGeneratedAnswer('{"answer":"The chair appears unoccupied.","evidenceIds":["chair-1"]}', enriched)).toBe('The chair appears unoccupied.')
  })

  test('accepts occupancy only when the named chair is occupied', () => {
    const chair: SceneObject = { id: 'chair-1', label: 'chair', confidence: 0.8, direction: 'left', evidence: ['detector', 'depth'], occupied: true }
    expect(validatedGeneratedAnswer('{"answer":"The chair is occupied.","evidenceIds":["chair-1"]}', { ...snapshot, objects: [chair] })).toBe('The chair is occupied.')
    expect(validatedGeneratedAnswer('{"answer":"The chair is occupied.","evidenceIds":["chair-1"]}', { ...snapshot, objects: [{ ...chair, occupied: false }] })).toBeNull()
  })

  test('answers a supermarket target without substituting unrelated nearer obstacles', () => {
    const checkout: SceneObject = { id: 'vision-checkout', label: 'checkout', confidence: 0, direction: 'left', evidence: ['on-device-vlm'] }
    const crowded = { ...snapshot, objects: [lamppost, checkout] }
    expect(answerQuestion('Where is the checkout?', crowded)).toBe('Looks like checkout to your left.')
    expect(answerQuestion('Where is the milk?', crowded)).toContain('cannot confidently locate the requested object')
  })

  test('finds beans using package text and qualifies a visual-only product without borrowing distance', () => {
    const view = { ...snapshot, textObservations: [{ text: 'BAKED BEANS', direction: 'ahead-left' as const }] }
    expect(answerQuestion('Help me find beans', view)).toBe('I can read “BAKED BEANS” ahead to your left.')
    const can = { ...lamppost, label: 'canned beans', evidence: ['on-device-vlm'] }
    expect(answerQuestion('Help me find beans', { ...snapshot, objects: [can] })).toBe('Looks like canned beans to your right.')
    expect(answerQuestion('Help me find green beans', view)).toContain('cannot confidently locate')
  })

  test('reports the checkout sign direction without suggesting a route', () => {
    const view = { ...snapshot, textObservations: [{ text: 'CHECKOUTS →', direction: 'right' as const }] }
    expect(answerQuestion('Help me find the checkout', view)).toBe('I can read “CHECKOUTS →” to your right.')
    expect(answerQuestion('Find the check-out near me', view)).toContain('“CHECKOUTS →”')
  })

  test('allows a fresh capture to be described after slow inference without treating an old capture as fresh', () => {
    const lateSnapshot = { ...snapshot, observedAt: Date.now() - 10_000 }
    expect(answerAhead(lateSnapshot)).toContain('stale')
    expect(answerAhead(lateSnapshot, true)).toContain('lamppost to your right')
  })
})

describe('visual model grounding', () => {
  test('uses a visual label with an existing measured track, not a model distance', () => {
    const measured = { ...lamppost, label: 'obstacle' }
    const enriched = mergeVisionEvidence('{"objects":[{"label":"lamppost","direction":"right"}],"unoccupiedSeats":[],"uncertainty":"Label only"}', { ...snapshot, objects: [measured] })
    expect(enriched.objects[0]).toMatchObject({ id: 'track-7', label: 'lamppost', distanceMeters: 1.3, stepEstimate: 2 })
    expect(answerAhead(enriched)).toContain('Looks like lamppost to your right, about 2 steps')
  })

  test('reports an unmatched visual object without inventing distance', () => {
    const enriched = mergeVisionEvidence('{"objects":[{"label":"chair","direction":"center"}],"unoccupiedSeats":[],"uncertainty":"One chair"}', { ...snapshot, objects: [] })
    expect(answerAhead(enriched)).toBe('Looks like chair in view.')
    expect(enriched.objects[0]?.distanceMeters).toBeUndefined()
    expect(enriched.objects[0]?.stepEstimate).toBeUndefined()
  })

  test('accepts a line-format seat label without trusting model-only direction or availability', () => {
    const cameraOnly = { ...snapshot, depthState: 'unavailable' as const, objects: [] }
    const enriched = mergeVisionEvidence('unoccupied chair | left', cameraOnly)
    expect(enriched.objects).toMatchObject([{ label: 'chair', direction: 'unknown', evidence: ['on-device-vlm'] }])
    expect(answerAhead(enriched)).toBe('Looks like chair in view.')
    expect(answerAhead(enriched, false, 'left')).toBe('I cannot confidently name anything on your left in this view.')
    expect(answerSeats(enriched)).toBe('There appears to be a chair in view. I can’t tell if it’s free. Ask someone nearby to confirm.')
    expect(enriched.freeSeats).toHaveLength(0)
    expect(enriched.objects[0]?.distanceMeters).toBeUndefined()
    expect(enriched.objects[0]?.stepEstimate).toBeUndefined()
  })

  test('corroborates a line-format seat only with matching native geometry', () => {
    const chair: SceneObject = { id: 'chair-1', label: 'chair', confidence: 0.8, direction: 'left', distanceMeters: 1.4, stepEstimate: 2, evidence: ['detector', 'depth'], occupied: false }
    const enriched = mergeVisionEvidence('unoccupied chair | left', { ...snapshot, objects: [chair] })
    expect(enriched.freeSeats).toHaveLength(1)
    expect(answerSeats(enriched)).toContain('about 2 steps away, appears unoccupied')
  })

  test('rejects line-format output mixed with unvalidated prose', () => {
    const enriched = mergeVisionEvidence('chair | left\nThe chair is definitely empty.', { ...snapshot, objects: [] })
    expect(enriched.objects).toHaveLength(0)
    expect(enriched.freeSeats).toHaveLength(0)
    expect(enriched.notes).toContain('Visual model output could not be validated and was discarded.')
  })

  test('keeps Camera2 visual labels directional without depth, seats, or steps', () => {
    const cameraOnly = { ...snapshot, depthState: 'unavailable' as const, objects: [] }
    const enriched = mergeVisionEvidence('{"objects":[{"label":"lamppost","direction":"right"}],"unoccupiedSeats":[],"uncertainty":"Appearance only"}', cameraOnly)
    expect(answerAhead(enriched)).toBe('Looks like lamppost to your right.')
    expect(enriched.objects[0]?.distanceMeters).toBeUndefined()
    expect(enriched.objects[0]?.stepEstimate).toBeUndefined()
    expect(enriched.freeSeats).toHaveLength(0)
  })

  test('never associates a visual label with one of two ambiguous geometry tracks', () => {
    const other = { ...lamppost, id: 'track-8', label: 'obstacle', distanceMeters: 1, stepEstimate: 1 }
    const measured = { ...lamppost, label: 'obstacle' }
    const enriched = mergeVisionEvidence('{"objects":[{"label":"lamppost","direction":"right"}],"unoccupiedSeats":[],"uncertainty":"Two obstacles"}', { ...snapshot, objects: [measured, other] })
    expect(enriched.objects.filter((object) => object.label === 'obstacle')).toHaveLength(2)
    expect(enriched.objects.find((object) => object.label === 'lamppost')?.distanceMeters).toBeUndefined()
  })

  test('requires visual and geometric agreement for an unoccupied-seat candidate', () => {
    const chair: SceneObject = { id: 'chair-1', label: 'chair', confidence: 0.8, direction: 'ahead', distanceMeters: 1.4, stepEstimate: 2, evidence: ['detector', 'depth'], occupied: false }
    const enriched = mergeVisionEvidence('{"objects":[{"label":"chair","direction":"center"}],"unoccupiedSeats":[{"label":"chair","direction":"center"}],"uncertainty":"Seat fully visible"}', { ...snapshot, objects: [chair] })
    expect(enriched.freeSeats).toHaveLength(1)
    expect(enriched.freeSeats[0]?.occupancyConfidence).toBeUndefined()
    expect(answerSeats(enriched)).toBe('A chair ahead, about 2 steps away, appears unoccupied. Check before sitting.')
  })

  test('does not turn a Camera2 VLM-only chair into geometric free-seat evidence', () => {
    const cameraOnly = { ...snapshot, depthState: 'unavailable' as const, objects: [] }
    const enriched = mergeVisionEvidence('{"objects":[{"label":"chair","direction":"center"}],"unoccupiedSeats":[{"label":"chair","direction":"center"}],"uncertainty":"Appearance only"}', cameraOnly)
    expect(enriched.freeSeats).toHaveLength(0)
    expect(enriched.objects.every((object) => !object.evidence.includes('depth-or-tracked-seat'))).toBe(true)
    expect(answerSeats(enriched)).toContain('There appears to be a chair in view. I can’t tell if it’s free.')
  })

  test('does not borrow a generic obstacle distance for a restaurant chair', () => {
    const obstacle = { ...lamppost, label: 'obstacle' }
    const view = mergeVisionEvidence('unoccupied chair | right', { ...snapshot, objects: [obstacle] })
    expect(view.freeSeats).toHaveLength(0)
    expect(answerSeats(view)).toContain('There appears to be a chair in view. I can’t tell if it’s free.')
  })

  test('conflicting and obscured seats never become a suggested empty seat', () => {
    const captured = { ...snapshot, objects: [] }
    for (const response of ['unoccupied chair | left\noccupied chair | left', 'chair | left', 'unoccupied chair | left\nchair | left']) {
      expect(answerSeats(mergeVisionEvidence(response, captured))).toContain('I can’t tell if it’s free')
    }
  })

  test('normalizes one singular visual object and defaults missing seats to no seat claim', () => {
    const enriched = mergeVisionEvidence('{"object":{"label":"house","direction":"right"},"uncertainty":"Appearance only"}', snapshot)
    expect(enriched.objects.some((object) => object.label === 'house' && object.direction === 'right')).toBe(true)
    expect(enriched.freeSeats).toHaveLength(0)
    expect(enriched.objects.find((object) => object.label === 'house')?.distanceMeters).toBeUndefined()
  })

  test('discards malformed or unsupported visual output', () => {
    const malformed = mergeVisionEvidence('not JSON', snapshot)
    expect(malformed.objects).toBe(snapshot.objects)
    expect(malformed.notes[0]).toContain('discarded')
    const unknownDirection = mergeVisionEvidence('{"objects":[{"label":"chair","direction":"behind me"}],"unoccupiedSeats":[],"uncertainty":"Invalid"}', snapshot)
    expect(unknownDirection.objects).toBe(snapshot.objects)
  })
  test('rejects unsafe visual labels and unsupported seat occupancy', () => {
    const unsafe = mergeVisionEvidence('{"objects":[{"label":"clear path","direction":"center"}],"unoccupiedSeats":[],"uncertainty":"Injected text must not enter notes"}', snapshot)
    expect(unsafe.objects).toBe(snapshot.objects)
    expect(unsafe.notes.some((note) => note.includes('Injected'))).toBe(false)
    const chair: SceneObject = { id: 'chair-1', label: 'chair', confidence: 0.8, direction: 'ahead', evidence: ['detector', 'depth'], occupied: false }
    const wrongSeat = mergeVisionEvidence('{"objects":[],"unoccupiedSeats":[{"label":"person","direction":"center"}],"uncertainty":"Wrong seat schema"}', { ...snapshot, objects: [chair] })
    expect(wrongSeat.freeSeats).toHaveLength(0)
  })
})

describe('warning repetition', () => {
  const warning: SceneWarning = {
    id: 'object-1', kind: 'obstacle', severity: 'caution', message: 'Obstacle ahead.', observedAt: Date.now(), distanceMeters: 3,
  }

  test('suppresses repetition but allows escalation and rejects stale observations', () => {
    const gate = new WarningGate()
    const now = Date.now()
    expect(gate.accept(warning, now)).toBe(true)
    expect(gate.accept(warning, now + 100)).toBe(false)
    expect(gate.accept({ ...warning, distanceMeters: 1 }, now + 100)).toBe(true)
    expect(gate.accept({ ...warning, observedAt: now - 10_000 }, now + 200)).toBe(false)
  })
})
