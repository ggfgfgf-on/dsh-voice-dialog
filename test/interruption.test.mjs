import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideBoundaryHold,
  decideInterruption,
  decideSpeechOnsetYield,
  DEFAULT_INTERRUPTION_MODE,
  isInterruptionMode,
} from '../lib/interruption.js'

const LIVE = { playing: true, cutting: false, muted: false, active: true }

test('sentence drains the audible sentence instead of clipping it', () => {
  assert.equal(decideInterruption('sentence', LIVE), 'drain')
})

test('immediate keeps the old hard cut', () => {
  assert.equal(decideInterruption('immediate', LIVE), 'cut')
})

test('never leaves the audio alone', () => {
  assert.equal(decideInterruption('never', LIVE), 'keep')
})

test('an undeclared mode behaves like the default', () => {
  assert.equal(DEFAULT_INTERRUPTION_MODE, 'sentence')
  assert.equal(decideInterruption(undefined, LIVE), 'drain')
})

test('an inactive session is never interrupted', () => {
  for (const mode of ['sentence', 'immediate', 'never']) {
    assert.equal(decideInterruption(mode, { ...LIVE, active: false }), 'keep')
  }
})

test('a muted session is never interrupted', () => {
  for (const mode of ['sentence', 'immediate', 'never']) {
    assert.equal(decideInterruption(mode, { ...LIVE, muted: true }), 'keep')
  }
})

test('a cut already fading out is not stacked on', () => {
  for (const mode of ['sentence', 'immediate', 'never']) {
    assert.equal(decideInterruption(mode, { ...LIVE, cutting: true }), 'keep')
  }
})

test('nothing audible means nothing to interrupt', () => {
  for (const mode of ['sentence', 'immediate', 'never']) {
    assert.equal(decideInterruption(mode, { ...LIVE, playing: false }), 'keep')
  }
})

test('never wins over every guard combination', () => {
  assert.equal(decideInterruption('never', { playing: false, cutting: false, muted: false, active: true }), 'keep')
  assert.equal(decideInterruption('never', { playing: true, cutting: true, muted: true, active: false }), 'keep')
})

test('sentence lets the audible sentence finish at onset', () => {
  assert.equal(decideSpeechOnsetYield('sentence', LIVE), 'atBoundary')
})

test('immediate still pauses the sentence at onset', () => {
  assert.equal(decideSpeechOnsetYield('immediate', LIVE), 'pause')
})

test('never ignores the onset entirely', () => {
  assert.equal(decideSpeechOnsetYield('never', LIVE), 'ignore')
})

test('an undeclared onset mode behaves like the default', () => {
  assert.equal(decideSpeechOnsetYield(undefined, LIVE), 'atBoundary')
})

test('onset guards ignore every mode', () => {
  const guards = [
    { ...LIVE, active: false },
    { ...LIVE, muted: true },
    { ...LIVE, cutting: true },
    { ...LIVE, playing: false },
  ]
  for (const state of guards) {
    for (const mode of ['sentence', 'immediate', 'never']) {
      assert.equal(decideSpeechOnsetYield(mode, state), 'ignore')
    }
  }
})

test('a pending sentence hold only fires on a boundary, never mid-sentence', () => {
  assert.equal(decideBoundaryHold(true, 'sentence'), 'hold')
  assert.equal(decideBoundaryHold(true, 'mid'), 'continue')
  assert.equal(decideBoundaryHold(false, 'sentence'), 'continue')
  assert.equal(decideBoundaryHold(false, 'mid'), 'continue')
})

test('mode validation accepts exactly the three declared modes', () => {
  for (const mode of ['sentence', 'immediate', 'never']) assert.equal(isInterruptionMode(mode), true)
  for (const value of ['', 'cut', 'hold', undefined, null, 0, 'Sentence']) {
    assert.equal(isInterruptionMode(value), false)
  }
})
