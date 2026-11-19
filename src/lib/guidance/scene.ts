import type { EngineGenerationRequest } from './native'
import type { Direction, SceneObject, SceneSnapshot } from './types'

const unsupportedClaims = /\b(safe to|path is clear|all clear|clear to cross|safe to cross|no obstacles|no hazards|nothing in front|you can go|walk forward|move forward|cross now|definitely empty|definitely free)\b/i

export function objectPhrase(object: SceneObject): string {
  const direction = {
    'ahead': 'ahead',
    'ahead-left': 'ahead to your left',
    'ahead-right': 'ahead to your right',
    'left': 'to your left',
    'right': 'to your right',
    'behind': 'behind you',
    'unknown': 'in view',
  }[object.direction]
  let distance = ''
  if (typeof object.stepEstimate === 'number' && Number.isFinite(object.stepEstimate) && object.stepEstimate > 0) {
    const steps = Math.max(1, Math.round(object.stepEstimate))
    distance = `, about ${steps === 1 ? 'one step' : `${steps} steps`}`
  } else if (typeof object.distanceMeters === 'number' && Number.isFinite(object.distanceMeters) && object.distanceMeters > 0) {
    distance = `, about ${object.distanceMeters < 1 ? 'less than a metre' : `${Math.round(object.distanceMeters)} metres`}`
  }
  const prefix = object.evidence.includes('on-device-vlm') ? 'Looks like ' : ''
  return `${prefix}${object.label} ${direction}${distance}`
}

export function sensorLimit(snapshot?: SceneSnapshot, allowFrozen = false): string | null {
  if (!snapshot) return 'No scene has been captured yet. Start guidance and point the camera around you.'
  if (!allowFrozen && Date.now() - snapshot.observedAt > 3_000) return 'The latest scene is stale. Capture a fresh view before relying on a description.'
  if (!snapshot.trackingReady) return 'Camera tracking is not ready. Hold still briefly, then move the camera slowly.'
  return null
}

export function answerAhead(snapshot?: SceneSnapshot, allowFrozen = false): string {
  const limit = sensorLimit(snapshot, allowFrozen)
  if (limit) return limit
  const objects = [...snapshot!.objects]
    .filter((object) => object.confidence >= 0.4 || object.evidence.includes('on-device-vlm'))
    .sort((left, right) => (left.distanceMeters ?? Infinity) - (right.distanceMeters ?? Infinity))
    .slice(0, 3)
  if (objects.length === 0) return 'I cannot confidently name anything in this view. Move the camera slowly for another look.'
  return objects.map(objectPhrase).join('. ') + '.'
}

export function answerSeats(snapshot?: SceneSnapshot, allowFrozen = false): string {
  const limit = sensorLimit(snapshot, allowFrozen)
  if (limit) return limit
  if (snapshot!.freeSeats.length === 0) {
    return 'I cannot confidently identify a free seat in this view. A seat outside the camera view or hidden behind someone may not be detected.'
  }
  return snapshot!.freeSeats.slice(0, 3).map((seat) => {
    return `${objectPhrase(seat)}, appears unoccupied from this camera view`
  }).join('. ') + '. Check locally before sitting.'
}

export function answerText(snapshot?: SceneSnapshot, allowFrozen = false): string {
  const limit = sensorLimit(snapshot, allowFrozen)
  if (limit) return limit
  if (snapshot!.recognizedText.length === 0) return 'I cannot read any clear text here. Move closer and point the camera directly at the text.'
  return snapshot!.recognizedText.join(' ').slice(0, 2_000)
}

export function answerQuestion(question: string, snapshot?: SceneSnapshot, allowFrozen = false): string {
  if (!/\b(where|find|locate|look for|is there|are there|do you see|can you see)\b/i.test(question)) return answerAhead(snapshot, allowFrozen)
  if (/\b(unoccupied|vacant|free seat|seat free|can i sit|place to sit)\b/i.test(question)) return answerSeats(snapshot, allowFrozen)
  const limit = sensorLimit(snapshot, allowFrozen)
  if (limit) return limit
  const words = new Set(question.toLowerCase().match(/[a-z]+/g) || [])
  const matches = [...snapshot!.objects, ...snapshot!.freeSeats].filter((object) => {
    if (object.confidence < 0.4 && !object.evidence.includes('on-device-vlm')) return false
    const labelWords = object.label.toLowerCase().match(/[a-z]+/g) || []
    return labelWords.length > 0 && labelWords.every((word) => words.has(word) || words.has(`${word}s`))
  })
  const unique = [...new Map(matches.map((object) => [object.id, object])).values()].slice(0, 3)
  if (unique.length === 0) return 'I cannot confidently locate the requested object in this view. Point the camera toward it and ask again.'
  return unique.map(objectPhrase).join('. ') + '.'
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
