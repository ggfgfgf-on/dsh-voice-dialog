import assert from 'node:assert/strict'
import test from 'node:test'
import {
  declaredAck, firstBlockShape, innerPauseFor, warmOpenDeclared,
} from '../lib/stream-profile.js'

test('first-block shape reads through the reader, never a snapshot', () => {
  let profile = { firstBlockChars: 5, firstBlockDeadlineMs: 700 }
  const read = () => profile
  assert.deepEqual(firstBlockShape(read), { chars: 5, deadlineMs: 700 })
  // A later declaration must be seen by the next read.
  profile = { firstBlockChars: 12, firstBlockDeadlineMs: 0 }
  assert.deepEqual(firstBlockShape(read), { chars: 12, deadlineMs: 0 })
})

test('an unsaid declaration keeps the historical first-block shape', () => {
  assert.deepEqual(firstBlockShape(() => ({})), { chars: 8, deadlineMs: 0 })
  assert.equal(innerPauseFor(() => ({})), 0)
  assert.equal(warmOpenDeclared(() => ({})), false)
})

test('the acknowledgement carries the model wording and the optional timing', () => {
  assert.deepEqual(declaredAck(() => ({ backchannel: ' 我在想 ', backchannelAfterMs: 1200 })), {
    text: ' 我在想 ', afterMs: 1200,
  })
  // No declared time means the wait decides, which the lanes read as 0.
  assert.deepEqual(declaredAck(() => ({ backchannel: '我在想' })), { text: '我在想', afterMs: 0 })
  assert.deepEqual(declaredAck(() => ({})), { text: '', afterMs: 0 })
})

test('a reader that changes between calls is read again each time', () => {
  let n = 0
  const read = () => { n += 1; return n > 1 ? { innerPauseMs: 120 } : {} }
  assert.equal(innerPauseFor(read), 0)
  assert.equal(innerPauseFor(read), 120)
  assert.equal(n, 2)
})
