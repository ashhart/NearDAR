import { describe, expect, test } from 'bun:test'
import { parseSatnavIntent } from '../src/lib/satnav/intents'
import {
  buildConversationalVisionPrompt,
  buildFastCorridorReply,
  parseAmbientObstacleLabel,
  sanitizeSpokenVisionOutput,
  SentenceStreamSplitter,
} from '../src/lib/satnav/prompts'
import type { SceneSnapshot } from '../src/lib/guidance/types'

describe('satnav conversational intent parser', () => {
  test('parses navigation, return, place-saving, and mode commands naturally', () => {
    expect(parseSatnavIntent('Take me to Costa Coffee')).toEqual({ kind: 'navigate-to', destination: 'Costa Coffee' })
    expect(parseSatnavIntent('Guide me to the nearest pharmacy please')).toEqual({ kind: 'navigate-to', destination: 'the nearest pharmacy' })
    expect(parseSatnavIntent('Take me back to where I started')).toEqual({ kind: 'navigate-back' })
    expect(parseSatnavIntent('Save this spot as Home')).toEqual({ kind: 'save-place', name: 'Home' })
    expect(parseSatnavIntent('Stop navigation')).toEqual({ kind: 'cancel-route' })
    expect(parseSatnavIntent('How far left?')).toEqual({ kind: 'route-status' })
    expect(parseSatnavIntent('Quiet mode')).toEqual({ kind: 'set-mode', mode: 'quiet' })
    expect(parseSatnavIntent('Explore mode')).toEqual({ kind: 'set-mode', mode: 'explore' })
    expect(parseSatnavIntent('Read that sign')).toEqual({ kind: 'read-text' })
    expect(parseSatnavIntent('Which way is open?')).toEqual({ kind: 'corridor-check' })
    expect(parseSatnavIntent('Where am I?')).toEqual({ kind: 'location' })
    expect(parseSatnavIntent('Which way am I facing?')).toEqual({ kind: 'heading' })
  })

  test('routes rich visual questions directly to on-device VLM', () => {
    expect(parseSatnavIntent('Is there a doorway ahead?')).toEqual({
      kind: 'visual-question',
      question: 'Is there a doorway ahead?',
    })
    expect(parseSatnavIntent('What is blocking the pavement?')).toEqual({
      kind: 'visual-question',
      question: 'What is blocking the pavement?',
    })
  })
})

describe('streaming vision prompts and speech chunking', () => {
  test('injects live LiDAR, OCR, heading, and turn history into VLM prompt', () => {
    const snapshot: SceneSnapshot = {
      observedAt: Date.now(),
      sequence: 1,
      trackingReady: true,
      depthState: 'ready',
      validDepthFraction: 0.9,
      cameraOrientation: 'camera-forward',
      objects: [{ id: 'm1', label: 'door', confidence: 0.9, direction: 'ahead-right', distanceMeters: 2.4, evidence: [] }],
      freeSeats: [],
      recognizedText: ['ENTRANCE', 'PUSH'],
      corridor: {
        sectors: [],
        recommendedHeadingOffsetDeg: 15,
        corridorState: 'narrow',
        forwardClearanceMeters: 1.4,
        bestClearanceMeters: 3.2,
        aimState: 'level',
        pitchDegrees: -4,
        valid: true,
      },
      hazards: [{
        id: 'h1',
        kind: 'head-height',
        severity: 'caution',
        direction: 'ahead',
        bearingDegrees: 0,
        distanceMeters: 1.5,
        confidence: 0.8,
        message: 'Head-height obstacle ahead, 1.5 metres.',
        observedAt: Date.now(),
      }],
      notes: [],
    }
    const prompt = buildConversationalVisionPrompt('Where is the entrance?', {
      snapshot,
      headingDeg: 90,
      history: [{ role: 'user', text: 'What is ahead?', at: 1 }],
    })
    expect(prompt).toContain('Facing east (90 deg)')
    expect(prompt).toContain('LiDAR: path narrow, ahead clearance 1.4m (open space right)')
    expect(prompt).toContain('head-height ahead at 1.5m')
    expect(prompt).toContain('door ahead right 2.4m')
    expect(prompt).toContain('ENTRANCE | PUSH')
    expect(prompt).toContain('User: What is ahead?')
  })

  test('streams complete sentences without splitting on decimal measurements', () => {
    const splitter = new SentenceStreamSplitter()
    expect(splitter.push('There is a bin 1.')).toEqual([])
    expect(splitter.push('There is a bin 1.5 metres ahead.')).toEqual([])
    expect(splitter.push('There is a bin 1.5 metres ahead. Step ')).toEqual(['There is a bin 1.5 metres ahead.'])
    expect(splitter.push('There is a bin 1.5 metres ahead. Step slightly right to pass it.')).toEqual([])
    expect(splitter.flush('There is a bin 1.5 metres ahead. Step slightly right to pass it.')).toBe('Step slightly right to pass it.')
  })

  test('softens unsafe crossing claims while keeping natural descriptions', () => {
    const output = sanitizeSpokenVisionOutput('The zebra crossing looks empty and it is safe to cross now.')
    expect(output).not.toMatch(/safe to cross/i)
    expect(output).toContain('still listen and check')
  })

  test('parses clean ambient obstacle labels and rejects filler', () => {
    expect(parseAmbientObstacleLabel('It is a trash bin.')).toBe('trash bin')
    expect(parseAmbientObstacleLabel('parked bicycle')).toBe('parked bicycle')
    expect(parseAmbientObstacleLabel('obstacle')).toBeUndefined()
    expect(parseAmbientObstacleLabel('A very long rambling sentence describing the whole street corner')).toBeUndefined()
  })

  test('builds fast deterministic corridor replies when VLM is unavailable or unneeded', () => {
    const reply = buildFastCorridorReply({
      observedAt: Date.now(),
      sequence: 2,
      trackingReady: true,
      depthState: 'ready',
      validDepthFraction: 0.9,
      cameraOrientation: 'camera-forward',
      objects: [],
      freeSeats: [],
      recognizedText: [],
      corridor: {
        sectors: [],
        recommendedHeadingOffsetDeg: -15,
        corridorState: 'narrow',
        forwardClearanceMeters: 1.3,
        bestClearanceMeters: 3.8,
        aimState: 'too-low',
        pitchDegrees: -40,
        valid: true,
      },
      notes: [],
    }, undefined, 0.65)
    expect(reply).toContain('Tilt it slightly up')
    expect(reply).toContain('Clear corridor to your left')
  })
})
