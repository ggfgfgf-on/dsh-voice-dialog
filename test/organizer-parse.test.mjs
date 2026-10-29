import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOrganizerResponse } from '../lib/organizer.js'

test('accepts a clean JSON decision', () => {
  assert.deepEqual(parseOrganizerResponse('{"action":"interrupt","reason":"更急"}')?.action, 'interrupt')
})

test('accepts fenced JSON', () => {
  assert.equal(parseOrganizerResponse('\u0060\u0060\u0060json\n{"action":"ignore"}\n\u0060\u0060\u0060')?.action, 'ignore')
})

test('recovers the action from JSON truncated by the token budget', () => {
  assert.equal(parseOrganizerResponse('{"action":"interrupt","reason":"用户插话')?.action, 'interrupt')
})

test('recovers the action from prose that mentions the key', () => {
  assert.equal(parseOrganizerResponse('action: queue')?.action, 'queue')
})

test('refuses text with no decision at all', () => {
  assert.equal(parseOrganizerResponse('让我想想。'), null)
  assert.equal(parseOrganizerResponse(''), null)
})
