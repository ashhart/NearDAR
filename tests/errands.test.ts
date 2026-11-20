import { describe, expect, test } from 'bun:test'
import { answerErrand, errandHasLabel, findErrand, shoppingCommand, type Errand } from '../src/lib/guidance/errands'
import { parseIntent } from '../src/lib/guidance/intents'
import type { SceneSnapshot } from '../src/lib/guidance/types'

const view: SceneSnapshot = {
  observedAt: Date.now(), sequence: 1, trackingReady: true, depthState: 'unavailable',
  validDepthFraction: 0, cameraOrientation: 'camera-forward', recognizedText: [], notes: [],
  objects: [], freeSeats: [],
}
const find = (question: string, previous?: Errand) => findErrand(question, parseIntent(question), previous)
const observation = (text: string) => ({ text, direction: 'ahead-right' as const })

describe('camera errands', () => {
  test('coaches a second seat scan without lending certainty to a model-only chair', () => {
    const seat = find('Help me find a seat')!
    expect(find('Is this one free?', seat)).toEqual(seat)
    const answer = answerErrand(seat, { ...view, objects: [{
      id: 'chair', label: 'chair', direction: 'unknown', confidence: 0, evidence: ['on-device-vlm'],
    }] }, true)
    expect(answer).toContain('I can’t tell if it’s free')
    expect(answer).toContain('Point the camera at the whole seat')
  })

  test('answers checkout from visible sign text without following its arrow or identifying the queue', () => {
    const errand = find('Where does the checkout queue start?')!
    expect(errand.kind).toBe('checkout')
    expect(answerErrand(errand, { ...view, textObservations: [observation('CHECKOUTS ←')] }, true))
      .toBe('I can read “CHECKOUTS ←” ahead to your right. I can’t tell where the queue starts.')
    expect(answerErrand(errand, view, true)).toContain('I can’t see a checkout sign')
  })

  test('asks for a close-up after finding an item from visible text', () => {
    const item = find('Help me find baked beans')!
    const beans = { ...view, textObservations: [observation('BAKED BEANS IN TOMATO SAUCE')] }
    expect(errandHasLabel(item, beans)).toBe(true)
    expect(answerErrand(item, beans, true)).toContain('Hold one label close')
  })

  test('retains the item and requested variant through a fresh size check', () => {
    const item = find('Help me find baked beans')!
    const lowSalt = find('No, the low-salt one', item)!
    const verify = find('Is this the 400-gram tin?', lowSalt)!
    expect(find('Check the label', verify)).toEqual(verify)
    expect(answerErrand(verify, { ...view, textObservations: [observation('LOW SALT BAKED BEANS 400G')] }, true))
      .toContain('The visible text matches')
    expect(answerErrand(verify, { ...view, textObservations: [observation('LOW SALT BAKED BEANS 40G')] }, true))
      .toContain('I can’t confirm')
    expect(answerErrand(verify, { ...view, textObservations: [observation('LOW SALT BAKED BEANS 0.400 G')] }, true))
      .toContain('I can’t confirm')
  })

  test('does not combine the size from one observation with a different product', () => {
    const verify = find('Is this the 400 gram tin?', find('Find baked beans'))!
    const observations = [observation('BAKED BEANS 200 G'), observation('CHICKPEAS 400 G')]
    expect(answerErrand(verify, { ...view, textObservations: observations }, true)).toContain('I can’t confirm')
  })

  test('does not verify an item using model output alone', () => {
    const verify = find('Is this it?', find('Find beans'))!
    const beans = { ...view, objects: [{
      id: 'beans', label: 'baked beans', direction: 'right' as const, confidence: 0, evidence: ['on-device-vlm'],
    }] }
    expect(answerErrand(verify, beans, true)).toContain('I can’t confirm')
  })

  test('parses a spoken shopping list and follow-up commands', () => {
    expect(shoppingCommand('I need some baked beans, mac and cheese, and milk.')).toEqual({
      kind: 'list', items: ['baked beans', 'mac and cheese', 'milk'],
    })
    expect(shoppingCommand('Cross that off')).toEqual({ kind: 'check-off' })
    expect(shoppingCommand('Next item')).toEqual({ kind: 'next' })
    expect(shoppingCommand('I need to find the checkout')).toBeUndefined()
  })
})
