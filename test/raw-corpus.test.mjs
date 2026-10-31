import test from 'node:test'
import assert from 'node:assert/strict'
import { createUtteranceCoalescer, UTTERANCE_COALESCE_WINDOW_MS } from '../lib/utterance-coalescer.js'
import { chunkRawSegments } from '../lib/chunker.js'
import { dedupeTranscript } from '../lib/continuous-separation.js'

function fakeTime() {
  let clock = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => clock,
    setTimer(callback, delayMs) {
      const id = nextId++
      timers.set(id, { at: clock + delayMs, callback })
      return id
    },
    clearTimer(id) { timers.delete(id) },
    advance(ms) {
      clock += ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= clock)
          .sort((left, right) => left[1].at - right[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        due[1].callback()
      }
    },
  }
}

function harness() {
  const clock = fakeTime()
  const batches = []
  const coalescer = createUtteranceCoalescer({
    windowMs: UTTERANCE_COALESCE_WINDOW_MS,
    dedupeTranscript,
    submit: (batch) => batches.push(batch),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  return { clock, batches, coalescer }
}

test('L2 cuts the real corpus: pieces feed the chunker, not one merged line', async () => {
  const { clock, batches, coalescer } = harness()
  coalescer.append({ lane: 'owner', canonical: '我', text: '我今天', meta: {}, at: 0 })
  coalescer.append({ lane: 'owner', canonical: '我', text: '有点累', meta: {}, at: 400 })
  coalescer.append({ lane: 'owner', canonical: '我', text: '想早点睡', meta: {}, at: 800 })
  clock.advance(UTTERANCE_COALESCE_WINDOW_MS)

  assert.equal(batches.length, 1)
  const batch = batches[0]
  const pieces = await batch.pieces
  assert.equal(pieces.length, 3, 'one piece per entry, not one merged line')
  assert.deepEqual(pieces.map((piece) => piece.text), ['我今天', '有点累', '想早点睡'])
  assert.deepEqual(pieces.map((piece) => piece.at), [0, 400, 800])

  const chunks = chunkRawSegments(pieces, { pauseMs: UTTERANCE_COALESCE_WINDOW_MS })
  assert.equal(chunks.length, 1, 'same speaker inside the window is one chunk')
  assert.equal(chunks[0].text, await batch.text, 'the chunk equals the deduped batch')
  assert.equal(chunks[0].segments, 3)
})

test('L2 keeps a speaker change as a boundary even inside one coalesced batch', async () => {
  const { clock, batches, coalescer } = harness()
  coalescer.append({ lane: 'owner', canonical: '我', text: '你先说', meta: {}, at: 0 })
  coalescer.append({ lane: 'guest', canonical: '客人1', text: '好，那我说', meta: {}, at: 300 })
  clock.advance(UTTERANCE_COALESCE_WINDOW_MS)

  assert.equal(batches.length, 2, 'the coalescer already flushes on a real speaker change')
  const ownerPieces = await batches[0].pieces
  const guestPieces = await batches[1].pieces
  assert.deepEqual(ownerPieces.map((piece) => piece.canonical), ['我'])
  assert.deepEqual(guestPieces.map((piece) => piece.canonical), ['客人1'])
  assert.equal(chunkRawSegments(ownerPieces)[0].text, '你先说')
  assert.equal(chunkRawSegments(guestPieces)[0].text, '好，那我说')
})

test('L2 cuts when the corpus passes the declared cap', async () => {
  const { clock, batches, coalescer } = harness()
  coalescer.append({ lane: 'owner', canonical: '我', text: '第一句话。', meta: {}, at: 0 })
  coalescer.append({ lane: 'owner', canonical: '我', text: '第二句话。', meta: {}, at: 300 })
  coalescer.append({ lane: 'owner', canonical: '我', text: '第三句话。', meta: {}, at: 600 })
  clock.advance(UTTERANCE_COALESCE_WINDOW_MS)

  const pieces = await batches[0].pieces
  const capped = chunkRawSegments(pieces, { maxChars: 6, splitOnPunctuation: true })
  assert.ok(capped.length > 1, 'the cap must actually cut')
  assert.equal(capped.map((chunk) => chunk.text).join(''), await batches[0].text)
  // Without a cap the same corpus is one chunk: the default stays unchanged.
  assert.equal(chunkRawSegments(pieces).length, 1)
})

test('L2 pieces are already deduped, so the chunker never repeats a phrase', async () => {
  const { clock, batches, coalescer } = harness()
  // The second ASR window overlaps the first; dedupe keeps only the new tail.
  coalescer.append({ lane: 'owner', canonical: '我', text: '我今天真的有点累了', meta: {}, at: 0 })
  coalescer.append({ lane: 'owner', canonical: '我', text: '我今天真的有点累了想早睡', meta: {}, at: 300 })
  clock.advance(UTTERANCE_COALESCE_WINDOW_MS)

  const batch = batches[0]
  const pieces = await batch.pieces
  const text = await batch.text
  assert.deepEqual(pieces.map((piece) => piece.text), ['我今天真的有点累了', '想早睡'])
  assert.equal(pieces.map((piece) => piece.text).join(''), text)
  assert.equal(chunkRawSegments(pieces)[0].text, text)
  assert.equal(text, '我今天真的有点累了想早睡', 'the overlap is gone before the chunker sees it')
})
