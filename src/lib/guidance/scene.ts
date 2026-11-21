import type { EngineGenerationRequest } from './native'
import type { Direction, SceneObject, SceneSnapshot } from './types'

const unsupportedClaims = /\b(safe to|path is clear|all clear|clear to cross|safe to cross|no obstacles|no hazards|nothing in front|you can go|walk forward|move forward|cross now|definitely empty|definitely free)\b/i

export function directionPhrase(direction: Direction): string {
  return {
    'ahead': 'ahead',
    'ahead-left': 'ahead to your left',
    'ahead-right': 'ahead to your right',
    'left': 'to your left',
    'right': 'to your right',
    'behind': 'behind you',
    'unknown': 'in view',
  }[direction]
}

function distancePhrase(object: SceneObject): string {
  let distance = ''
  if (typeof object.stepEstimate === 'number' && Number.isFinite(object.stepEstimate) && object.stepEstimate > 0) {
    const steps = Math.max(1, Math.round(object.stepEstimate))
    distance = `about ${steps === 1 ? 'one step' : `${steps} steps`}`
  } else if (typeof object.distanceMeters === 'number' && Number.isFinite(object.distanceMeters) && object.distanceMeters > 0) {
    distance = object.distanceMeters < 1 ? 'less than a metre' : `about ${Math.round(object.distanceMeters)} metres`
  }
  return distance
}

export function objectPhrase(object: SceneObject): string {
  const prefix = object.evidence.includes('on-device-vlm') ? 'Looks like ' : ''
  const distance = distancePhrase(object)
  return `${prefix}${object.label} ${directionPhrase(object.direction)}${distance ? `, ${distance}` : ''}`
}

export function sensorLimit(snapshot?: SceneSnapshot, allowFrozen = false): string | null {
  if (!snapshot) return 'No scene has been captured yet. Start guidance and point the camera around you.'
  if (!allowFrozen && Date.now() - snapshot.observedAt > 3_000) return 'The latest scene is stale. Capture a fresh view before relying on a description.'
  if (!snapshot.trackingReady) return 'Camera tracking is not ready. Hold still briefly, then move the camera slowly.'
  return null
}

export function cameraRecoveryHint(snapshot?: SceneSnapshot): string {
  const notes = snapshot?.notes.join(' ').toLowerCase() ?? ''
  if (notes.includes('excessive motion')) return 'The camera is moving too quickly to track. Hold the phone steady for a moment.'
  if (notes.includes('visible surface detail')) return 'The camera needs more detail to track. Point it at a well-lit object or textured surface.'
  if (notes.includes('recovering')) return 'The camera is finding its position again. Slowly turn the phone back toward what you last pointed at.'
  return 'The camera is still getting a usable view. Keep the lens uncovered and hold the phone steady.'
}

export function answerAhead(snapshot?: SceneSnapshot, allowFrozen = false, side?: 'left' | 'right'): string {
  const limit = sensorLimit(snapshot, allowFrozen)
  if (limit) return limit
  const objects = [...snapshot!.objects, ...snapshot!.freeSeats]
    .filter((object) => !side || object.direction === side || object.direction === `ahead-${side}`)
    .filter((object) => object.confidence >= 0.4 || object.evidence.includes('on-device-vlm'))
    .sort((left, right) => (left.distanceMeters ?? Infinity) - (right.distanceMeters ?? Infinity))
    .slice(0, 3)
  if (objects.length === 0) return side
    ? `I cannot confidently name anything on your ${side} in this view.`
    : 'I cannot confidently name anything in this view. Move the camera slowly for another look.'
  return objects.map(objectPhrase).join('. ') + '.'
}

export function answerMeasuredAhead(snapshot?: SceneSnapshot, now = Date.now()): string | undefined {
  if (!snapshot?.trackingReady || snapshot.depthState !== 'ready') return
  const age = now - snapshot.observedAt
  if (!Number.isFinite(age) || age < 0 || age > 750) return
  const objects = snapshot.objects.filter((object) => object.confidence >= 0.4 && object.direction !== 'unknown' &&
    object.distanceMeters !== undefined && Number.isFinite(object.distanceMeters) && object.distanceMeters > 0 &&
    !object.evidence.includes('on-device-vlm'))
  if (objects.length) return answerAhead({ ...snapshot, objects, freeSeats: [] }, true)
}

function matchedFreeSeat(snapshot: SceneSnapshot) {
  return snapshot.freeSeats
    .filter((seat) => seat.free && seat.evidence.includes('on-device-vlm'))
    .sort((first, second) => (first.distanceMeters ?? Infinity) - (second.distanceMeters ?? Infinity))[0]
}

function visibleSeat(snapshot: SceneSnapshot) {
  return snapshot.objects.find((object) => /^(chair|seat|bench|stool)$/.test(object.label))
}

export function seatAlignmentTarget(snapshot: SceneSnapshot, captured: SceneSnapshot) {
  if (!snapshot.trackingReady || snapshot.depthState !== 'ready') return
  const matched = matchedFreeSeat(snapshot)
  const seat = matched ? captured.objects.find(({ id }) => matched.id === id || matched.id === `candidate-${id}`) : visibleSeat(snapshot)
  if (!seat?.id.startsWith('mesh-') || seat.distanceMeters === undefined || seat.distanceMeters < 0.5 || seat.distanceMeters > 5) return
  return { id: seat.id, observedAt: snapshot.observedAt }
}

export function answerSeats(snapshot?: SceneSnapshot, allowFrozen = false, guided = false): string {
  const limit = sensorLimit(snapshot, allowFrozen)
  if (limit) return limit
  const matched = matchedFreeSeat(snapshot!)
  if (matched) {
    const distance = distancePhrase(matched)
    return `A ${matched.label} ${directionPhrase(matched.direction)}${distance ? `, ${distance} away,` : ''} appears unoccupied. Check before sitting.`
  }
  const visible = visibleSeat(snapshot!)
  if (visible) {
    const next = guided ? 'Point the camera at the whole seat and say “check again”.' : 'Ask someone nearby to confirm.'
    return `There appears to be a ${visible.label} ${directionPhrase(visible.direction)}. I can’t tell if it’s free. ${next}`
  }
  return guided ? 'I can’t confirm a free seat in this view. Aim the camera across the seating area and say “check again”.'
    : 'I cannot confidently identify a free seat in this view. Point the camera toward the seating, or ask someone nearby.'
}

export function answerText(snapshot?: SceneSnapshot, allowFrozen = false): string {
  const limit = sensorLimit(snapshot, allowFrozen)
  if (limit) return limit
  if (snapshot!.recognizedText.length === 0) return 'I cannot read any clear text here. Move closer and point the camera directly at the text.'
  return snapshot!.recognizedText.join(' ').slice(0, 2_000)
}

export function wordTokens(value: string): string[] {
  const words = value.toLowerCase()
    .replace(/\bcheck[- ]?outs?\b|\bcash registers?\b/g, 'checkout')
    .match(/[a-z0-9]+/g) ?? []
  return words.map((word) => {
    if (word.length < 4) return word
    if (/ies$/.test(word)) return word.slice(0, -3) + 'y'
    if (/(?:oes|ses|xes|ches|shes|zes)$/.test(word)) return word.slice(0, -2)
    return /[^s]s$/.test(word) ? word.slice(0, -1) : word
  })
}

export function requestedObjectName(question: string): string | undefined {
  const target = /\b(?:find|locate|look for|where(?:['’]s| (?:is|are))|is there|are there|do you see|can you see)\s+(.+)/i.exec(question)?.[1]
  return target
    ?.trim()
    .replace(/^(?:me )?(?:a |an |the |some |my |our |any )?/i, '')
    .replace(/\b(?:on|to) (?:my|the|your) (?:left|right)\b|\b(?:near me|in this view|for me|please)\b/gi, '')
    .replace(/\b(?:is|are)\s*[?!.]*$/i, '')
    .replace(/[?!.]+$/, '')
    .trim()
}

export function requestedObject(question: string): string[] {
  return wordTokens(requestedObjectName(question) ?? '')
}

export function requestedSide(question: string): 'left' | 'right' | undefined {
  const side = /\b(?:on|to) (?:my|the|your) (left|right)\b/i.exec(question)?.[1]?.toLowerCase()
  return side === 'left' || side === 'right' ? side : undefined
}

export function wordsMatch(text: string, target: string[]): boolean {
  const words = new Set(wordTokens(text))
  return target.every((word) => words.has(word))
}

export function objectMatches(object: SceneObject, target: string[]): boolean {
  return (object.confidence >= 0.4 || object.evidence.includes('on-device-vlm')) && wordsMatch(object.label, target)
}

export function answerQuestion(question: string, snapshot?: SceneSnapshot, allowFrozen = false): string {
  const side = requestedSide(question)
  const target = requestedObject(question)
  if (!target.length) {
    return answerAhead(snapshot, allowFrozen, side)
  }
  if (/\b(unoccupied|vacant|free seat|seat free|can i sit|place to sit)\b/i.test(question)) return answerSeats(snapshot, allowFrozen)
  const limit = sensorLimit(snapshot, allowFrozen)
  if (limit) return limit
  const matchesSide = (direction: Direction) => !side || direction === side || direction === `ahead-${side}`
  const text = (snapshot!.textObservations ?? snapshot!.recognizedText.map((text) => ({ text, direction: 'unknown' as const })))
    .find((observation) => matchesSide(observation.direction) && wordsMatch(observation.text, target))
  if (text) return `I can read “${text.text.trim().slice(0, 110)}” ${directionPhrase(text.direction)}.`

  const matches = [...snapshot!.objects, ...snapshot!.freeSeats].filter((object) =>
    matchesSide(object.direction) && objectMatches(object, target))
  const unique = [...new Map(matches.map((object) => [object.id, object])).values()].slice(0, 3)
  if (unique.length === 0) return 'I cannot confidently locate the requested object in this view. Point the camera toward it and ask again.'
  return unique.map((object) => object.evidence.includes('on-device-vlm') ? objectPhrase({ ...object, distanceMeters: undefined, stepEstimate: undefined }) : objectPhrase(object)).join('. ') + '.'
}

export function buildGenerationRequest(question: string, snapshot: SceneSnapshot, requestId: string): EngineGenerationRequest {
  const facts = {
    observedAt: snapshot.observedAt,
    depthState: snapshot.depthState,
    validDepthFraction: snapshot.validDepthFraction,
    cameraOrientation: snapshot.cameraOrientation,
    objects: snapshot.objects,
    freeSeats: snapshot.freeSeats,
    recognizedText: snapshot.recognizedText,
    notes: snapshot.notes,
  }
  return {
    requestId,
    question,
    temperature: 0,
    maxTokens: 160,
    system: `You provide brief spoken assistance using only measured scene facts. Never claim a route is safe, clear, or empty. Never identify people or infer sensitive traits. Never invent objects, distances, directions, or text. Say what is uncertain. Use at most two short sentences. Return JSON only with keys answer and evidenceIds. evidenceIds must contain only supplied object IDs used by the answer.`,
    prompt: `Question: ${question}\n\nCurrent scene facts:\n${JSON.stringify(facts)}`,
    imageBase64: snapshot.imageBase64,
    temporaryImagePath: snapshot.temporaryImagePath,
  }
}

const numberWords: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 }

export function validatedGeneratedAnswer(raw: string, snapshot: SceneSnapshot): string | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(raw.slice(start, end + 1)) as { answer?: unknown; evidenceIds?: unknown }
    if (typeof value.answer !== 'string' || !Array.isArray(value.evidenceIds)) return null
    const evidenceIds = value.evidenceIds
    const answer = value.answer.trim()
    if (!answer || answer.length > 500 || unsupportedClaims.test(answer)) return null
    const allObjects = [...snapshot.objects, ...snapshot.freeSeats]
    const ids = new Set(allObjects.map((object) => object.id))
    if (evidenceIds.some((id) => typeof id !== 'string' || !ids.has(id))) return null
    const evidence = allObjects.filter((object) => evidenceIds.includes(object.id))
    const answerLower = answer.toLowerCase()
    const supportedTexts = snapshot.recognizedText.filter((text) => text.trim() && answerLower.includes(text.toLowerCase()))
    const supportedText = supportedTexts.join(' ').toLowerCase()
    const mentions = allObjects.filter((object) => object.label.trim() && answerLower.includes(object.label.toLowerCase()))
    if (mentions.length > 1 || (!supportedText && mentions.length !== 1)) return null
    const subject = mentions[0]
    if ((subject && !evidence.some((object) => object.id === subject.id)) || (!subject && evidence.length > 0)) return null

    if (/\b(unoccupied|vacant|available seat|seat is available|chair is available|seat is free|chair is free|free chair|free seat|open seat|seat is open|chair is open)\b/i.test(answer)) {
      const candidate = subject && snapshot.freeSeats.find((seat) => seat.id === subject.id && seat.free)
      if (!candidate || !candidate.evidence.some((item) => item === 'depth' || item === 'mesh' || item === 'depth-or-tracked-seat')) return null
    }
    if (/\boccupied\b/i.test(answer) && subject?.occupied !== true) return null

    if (subject) {
      const spokenDirections = answerLower.match(/ahead-left|ahead-right|to your left|to your right|ahead|behind|\bleft\b|\bright\b/g) || []
      const expectedDirection: Record<string, Direction> = { 'ahead-left': 'ahead-left', 'ahead-right': 'ahead-right', 'to your left': 'left', 'to your right': 'right', ahead: 'ahead', behind: 'behind', left: 'left', right: 'right' }
      if (spokenDirections.some((phrase) => subject.direction !== expectedDirection[phrase])) return null
    }

    for (const match of answer.matchAll(/\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(steps?|metres?|meters?|o['’]?clock)?\b/gi)) {
      const spokenNumber = match[1]!.toLowerCase()
      if (supportedText && supportedText.includes(match[0].toLowerCase())) continue
      if (!subject) return null
      const value = numberWords[spokenNumber] ?? Number(spokenNumber)
      const unit = match[2]?.toLowerCase()
      if (unit?.startsWith('step')) {
        if (!subject.stepEstimate || value !== Math.round(subject.stepEstimate)) return null
      } else if (unit?.startsWith('metre') || unit?.startsWith('meter')) {
        if (!subject.distanceMeters || (value !== subject.distanceMeters && value !== Math.round(subject.distanceMeters))) return null
      } else if (unit?.startsWith('o')) {
        if (!subject.clockSector || value !== Math.round(subject.clockSector)) return null
      } else {
        return null
      }
    }
    return answer
  } catch {
    return null
  }
}
