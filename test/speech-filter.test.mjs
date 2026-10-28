import assert from 'node:assert/strict'
import test from 'node:test'
import { isSpeakableChunk, shouldSpeak } from '../lib/speech-filter.js'

test('never speaks auxiliary calls', () => {
  assert.equal(shouldSpeak({ sessionId: 's', purpose: 'compaction' }, true), false)
  assert.equal(shouldSpeak({ sessionId: 's', purpose: 'session-title' }, true), false)
  assert.equal(shouldSpeak({ sessionId: 's', purpose: 'voice-organizer' }, true), false)
  assert.equal(shouldSpeak({ sessionId: 's' }, true), true)
  assert.equal(shouldSpeak({ sessionId: 's' }, false), false)
  assert.equal(shouldSpeak({}, true), false)
})

test('only visible assistant text is speakable', () => {
  assert.equal(isSpeakableChunk({ type: 'text-delta', text: '你好。' }), true)
  assert.equal(isSpeakableChunk({ type: 'reasoning-delta', text: '思考中' }), false)
  assert.equal(isSpeakableChunk({ type: 'tool-call-delta', argumentsDelta: '{}' }), false)
  assert.equal(isSpeakableChunk({ type: 'text-delta', text: '' }), false)
})
