import assert from 'node:assert/strict'
import test from 'node:test'
import { createRecordStream } from '../lib/record-stream.js'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('record stream: append keeps order and stamps seq/at', () => {
  const stream = createRecordStream({ now: () => 1000 })
  const first = stream.append('transcript', { text: '你好', lane: 'owner' })
  const second = stream.append('voiceprint', { label: '我' })
  assert.equal(first.seq, 1)
  assert.equal(second.seq, 2)
  assert.equal(first.at, 1000)
  assert.equal(first.kind, 'transcript')
  assert.equal(first.text, '你好', 'the payload survives untouched')
  assert.equal(stream.lastSeq(), 2)
  assert.equal(stream.size(), 2)
})

test('record stream: the caller cannot forge seq/at/kind', () => {
  const stream = createRecordStream({ now: () => 5 })
  const event = stream.append('playback', { seq: 99, at: 1, kind: 'transcript', state: 'playing' })
  assert.equal(event.seq, 1)
  assert.equal(event.at, 5)
  assert.equal(event.kind, 'playback')
  assert.equal(event.state, 'playing')
})

test('record stream: subscribe tails live events and unsubscribes cleanly', () => {
  const stream = createRecordStream({ now: () => 0 })
  const seen = []
  const off = stream.subscribe((event) => seen.push(event.seq))
  stream.append('transcript', { text: 'a' })
  stream.append('barge-in', { action: 'queue' })
  off()
  stream.append('transcript', { text: 'b' })
  assert.deepEqual(seen, [1, 2])
})

test('record stream: one broken subscriber does not stop the stream', () => {
  const stream = createRecordStream({ now: () => 0 })
  const seen = []
  stream.subscribe(() => { throw new Error('boom') })
  stream.subscribe((event) => seen.push(event.seq))
  assert.doesNotThrow(() => stream.append('transcript', { text: 'a' }))
  assert.deepEqual(seen, [1])
})

test('record stream: the ring keeps the newest events and replay reads them in order', () => {
  const stream = createRecordStream({ capacity: 3, now: () => 0 })
  for (let index = 1; index <= 5; index += 1) stream.append('transcript', { text: String(index) })
  assert.equal(stream.size(), 3)
  assert.deepEqual(stream.tail(2).map((event) => event.seq), [4, 5])
  assert.deepEqual(stream.replay().map((event) => event.seq), [3, 4, 5])
  assert.deepEqual(stream.replay(4).map((event) => event.seq), [4, 5])
})

test('record stream: persistence is batched, and a failing sink never reaches the caller', async () => {
  const batches = []
  const errors = []
  const stream = createRecordStream({
    now: () => 0,
    flushMs: 5,
    batchMax: 2,
    sink: (lines) => {
      batches.push(lines.length)
      if (batches.length === 1) throw new Error('disk full')
    },
    onError: (error) => errors.push(String(error)),
  })
  assert.doesNotThrow(() => stream.append('transcript', { text: 'a' }))
  assert.doesNotThrow(() => stream.append('transcript', { text: 'b' }))
  assert.deepEqual(batches, [2], 'batchMax flushes at once')
  assert.equal(errors.length, 1)
  await wait(20)
  stream.append('transcript', { text: 'c' })
  await wait(20)
  assert.deepEqual(batches, [2, 1], 'the timer flushes the rest')
  stream.dispose()
})

test('record stream: dispose stops the timer and clears subscribers', async () => {
  let flushes = 0
  const stream = createRecordStream({ now: () => 0, flushMs: 5, sink: () => { flushes += 1 } })
  const seen = []
  stream.subscribe((event) => seen.push(event.seq))
  stream.append('transcript', { text: 'a' })
  stream.dispose()
  assert.equal(flushes, 1, 'dispose flushes what is buffered')
  stream.append('transcript', { text: 'b' })
  assert.deepEqual(seen, [1], 'a disposed stream no longer notifies')
})
