import test from 'node:test'
import assert from 'node:assert/strict'
import { SpeakerPolicyStore } from '../lib/speaker-policy.js'

test('renames a guest and resolves the name in both directions', () => {
  const store = new SpeakerPolicyStore()
  assert.equal(store.apply('s', { speaker: '客人1', name: '老婆' }), true)
  assert.equal(store.display('s', '客人1'), '老婆')
  assert.equal(store.display('s', '老婆'), '老婆')
  assert.equal(store.resolve('s', '老婆'), '客人1')
  assert.equal(store.hasCustomization('s'), true)
})

test('policy set by the new name applies to the canonical guest', () => {
  const store = new SpeakerPolicyStore()
  store.apply('s', { speaker: '客人1', name: '老婆' })
  store.apply('s', { speaker: '老婆', policy: 'ignore' })
  assert.equal(store.effective('s', '客人1', 'queue'), 'ignore')
  assert.equal(store.effective('s', '老婆', 'queue'), 'ignore')
})

test('one call can rename and set a policy', () => {
  const store = new SpeakerPolicyStore()
  store.apply('s', { speaker: '客人1', name: '老王', policy: 'steer' })
  assert.equal(store.display('s', '客人1'), '老王')
  assert.equal(store.effective('s', '老王', 'queue'), 'steer')
})

test('specific guest policy wins over the * fallback', () => {
  const store = new SpeakerPolicyStore()
  store.apply('s', { speaker: '*', policy: 'ignore' })
  assert.equal(store.effective('s', '客人2', 'queue'), 'ignore')
  store.apply('s', { speaker: '客人1', policy: 'queue' })
  assert.equal(store.effective('s', '客人1', 'queue'), 'queue')
  assert.equal(store.effective('s', '客人2', 'queue'), 'ignore')
})

test('default restores one guest or every guest', () => {
  const store = new SpeakerPolicyStore()
  store.apply('s', { speaker: '客人1', policy: 'ignore' })
  store.apply('s', { speaker: '客人2', policy: 'ignore' })
  store.apply('s', { speaker: '客人1', policy: 'default' })
  assert.equal(store.effective('s', '客人1', 'queue'), 'queue')
  assert.equal(store.effective('s', '客人2', 'queue'), 'ignore')
  store.apply('s', { speaker: '*', policy: 'default' })
  assert.equal(store.effective('s', '客人2', 'queue'), 'queue')
})

test('owner and invalid names are rejected', () => {
  const store = new SpeakerPolicyStore()
  assert.equal(store.apply('s', { speaker: '我', name: '老板' }), false)
  assert.equal(store.apply('s', { speaker: '我', policy: 'ignore' }), false)
  assert.equal(store.apply('s', { speaker: '客人1', name: '*' }), false)
  assert.equal(store.apply('s', { speaker: '客人1', name: '[x]' }), false)
  assert.equal(store.apply('s', { speaker: '客人1', name: 'x'.repeat(25) }), false)
  assert.equal(store.hasCustomization('s'), false)
})

test('clear removes names and policies for one session only', () => {
  const store = new SpeakerPolicyStore()
  store.apply('a', { speaker: '客人1', name: '老婆', policy: 'ignore' })
  store.apply('b', { speaker: '客人1', name: '老王', policy: 'queue' })
  store.clear('a')
  assert.equal(store.display('a', '客人1'), '客人1')
  assert.equal(store.effective('a', '客人1', 'queue'), 'queue')
  assert.equal(store.display('b', '客人1'), '老王')
})
