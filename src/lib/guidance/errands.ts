import type { GuidanceIntent } from './intents'
import { answerSeats, directionPhrase, objectMatches, requestedObjectName, requestedSide, sensorLimit, wordTokens } from './scene'
import type { SceneSnapshot } from './types'

export type Errand =
  | { kind: 'seat' }
  | { kind: 'checkout' }
  | { kind: 'item'; name: string; qualifiers: string[]; verify: boolean }

const checkout = /\b(?:check[ -]?outs?|cash registers?|pay here)\b/i
const thisOne = /^(?:is (?:this|that) (?:it|the right one)|check (?:the |this )?label|verify (?:this|that)(?: one)?|what about (?:this|that) one)$/

function speechText(text: string): string {
  return text.toLowerCase().replace(/’/g, "'").trim().replace(/[.!?]+$/, '').replace(/\s+/g, ' ')
}

export function findErrand(question: string, intent: GuidanceIntent, previous?: Errand): Errand | undefined {
  if (intent.kind === 'seat') return { kind: 'seat' }
  if (intent.kind !== 'question') return
  const value = speechText(question)
  const target = requestedObjectName(value)
  const askingWhereToQueue = /^(?:where does|where do|where should i|where can i)\b.*\b(?:queue|line up)\b/.test(value)
  if (checkout.test(target ?? '') || (askingWhereToQueue && checkout.test(value))) {
    return { kind: 'checkout' }
  }
  if (previous?.kind === 'seat' && /^is (?:this|that)(?: one| seat| chair)? (?:free|empty|available|taken)$/.test(value)) return previous
  if (previous?.kind === 'item') {
    if (thisOne.test(value)) return { ...previous, verify: true }
    const qualifier = /^(?:no[ ,]+)?(?:the |a )(.+?) one$/.exec(value)?.[1] ??
      /^is (?:this|that) (?:the |a )?(.+?) (?:tin|can|pack|packet|box|one)$/.exec(value)?.[1]
    if (qualifier) {
      const isProduct = labelWords(previous.name) === labelWords(qualifier)
      const existing = /^no[ ,]+/.test(value) ? [] : previous.qualifiers.filter((old) => !(/^\d/.test(qualifier) && /^\d/.test(old)))
      return { ...previous, verify: true, qualifiers: isProduct ? existing : [...new Set([...existing, qualifier])].slice(-3) }
    }
  }
  if (thisOne.test(value) && previous) return previous
  if (target && wordTokens(target).length && !requestedSide(value)) return { kind: 'item', name: target, qualifiers: [], verify: false }
}

function labelWords(value: string): string {
  const units = { k: 'kg', g: 'g', m: 'ml', l: 'l' }
  return wordTokens(value
    .replace(/\b(\d+(?:[.,]\d+)?)\s*[- ]?\s*(kilograms?|kg|grams?|g|millilit(?:re|er)s?|ml|lit(?:re|er)s?|l)\b/gi, (_, number: string, unit: string) => {
      const key = unit[0]!.toLowerCase() as keyof typeof units
      return ` amount${number.replace('.', 'dot').replace(',', 'comma')}${units[key]} `
    })).join(' ')
}

function hasLabelWords(text: string, target: string): boolean {
  const label = labelWords(target)
  return label.length > 0 && ` ${labelWords(text)} `.includes(` ${label} `)
}

function textInView(view: SceneSnapshot) {
  return view.textObservations ?? view.recognizedText.map((text) => ({ text, direction: 'unknown' as const }))
}

function itemLabel(errand: Extract<Errand, { kind: 'item' }>, view: SceneSnapshot) {
  return textInView(view).find(({ text }) =>
    hasLabelWords(text, errand.name) && errand.qualifiers.every((value) => hasLabelWords(text, value)))
}

export function errandHasLabel(errand: Errand | undefined, view: SceneSnapshot): boolean {
  return errand?.kind === 'item' && !!itemLabel(errand, view)
}

export function answerErrand(errand: Errand, view: SceneSnapshot, allowFrozen: boolean): string {
  const limit = sensorLimit(view, allowFrozen)
  if (limit) return limit
  if (errand.kind === 'seat') return answerSeats(view, allowFrozen, true)

  const observations = textInView(view)
  if (errand.kind === 'checkout') {
    const sign = observations.find(({ text }) => checkout.test(text))
    return sign
      ? `I can read “${sign.text.trim().slice(0, 110)}” ${directionPhrase(sign.direction)}. I can’t tell where the queue starts.`
      : 'I can’t see a checkout sign in this view. Sweep the camera slowly across the signs and say “check again”.'
  }

  const label = itemLabel(errand, view)
  if (label) {
    const text = label.text.trim().slice(0, 110)
    return errand.verify ? `I can read “${text}”. The visible text matches what you asked for.`
      : `I can read “${text}” ${directionPhrase(label.direction)}. Hold one label close to the camera and say “check the label” to verify it.`
  }
  if (errand.verify) {
    const observed = observations.find(({ text }) => hasLabelWords(text, errand.name))?.text.trim().slice(0, 110)
    return `${observed ? `I can read “${observed}”. ` : ''}I can’t confirm ${[...errand.qualifiers, errand.name].join(' ')} from this label. Aim at one label and say “check again”.`
  }
  const tokens = wordTokens(errand.name)
  const appearance = view.objects.find((object) => objectMatches(object, tokens))
  return appearance
    ? `I can see what looks like ${appearance.label}. Hold one label close and say “check the label” to verify it.`
    : `I can’t confirm ${errand.name} in this view. Sweep the camera across the area and say “check again”.`
}

export type ShoppingCommand =
  | { kind: 'list'; items: string[] }
  | { kind: 'read' | 'next' | 'check-off' | 'clear' }

export function shoppingCommand(question: string): ShoppingCommand | undefined {
  const value = speechText(question)
  const newList = /^(?:my shopping list is|shopping list\s*:?|i need(?: to buy)?)\s+(.+)$/.exec(value)
  if (newList) {
    const list = newList[1]!
    const segments = list.includes(',') ? list.split(/\s*,\s*(?:and\s+)?/) : list.split(/\s+and\s+/)
    const items = [...new Set(segments.map((item) => item.replace(/^(?:a|an|the|some)\s+/, '').trim()).filter(Boolean))].slice(0, 12)
    if (items.length > 1 || /shopping list/.test(value)) return { kind: 'list', items }
  }
  if (/^(?:read|what's on|what is on) (?:my|the) (?:shopping )?list$/.test(value)) return { kind: 'read' }
  if (/^(?:next item|what's next on (?:my|the) list)$/.test(value)) return { kind: 'next' }
  if (/^(?:cross|check|tick) (?:that|it|this) off$|^mark (?:that|it|this) done$/.test(value)) return { kind: 'check-off' }
  if (/^clear (?:my|the) (?:shopping )?list$/.test(value)) return { kind: 'clear' }
}
