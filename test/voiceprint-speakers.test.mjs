import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VoiceprintService } from '../lib/voiceprint.js'

function fakeExtractor() {
  let samples = new Float32Array(0)
  return {
    dim: 64,
    createStream() {
      return {
        acceptWaveform(input) { samples = input.samples },
      }
    },
    compute() {
      const out = new Float32Array(64)
      let sum = 0
      for (let i = 0; i < samples.length; i++) sum += samples[i]
      if (sum >= 0) out[0] = 1
      else out[1] = 1
      return out
    },
  }
}

function voice(positive) {
  return new Float32Array(16000).fill(positive ? 0.1 : -0.1)
}

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vp-speakers-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('named guests are stored, matched and survive a restart', async (t) => {
  const dir = workspace(t)
  const service = new VoiceprintService({ dataDir: dir, extractor: fakeExtractor() })
  await service.enroll(voice(true))
  const guest = await service.enrollSpeaker(voice(false), '老婆')

  assert.equal(service.status().speakerCount, 1)
  assert.equal(service.status().speakers[0].name, '老婆')

  const guestIdentity = await service.identify(voice(false), { sessionId: 's1', threshold: 0.52 })
  assert.equal(guestIdentity.owner, false)
  assert.equal(guestIdentity.label, '老婆')
  assert.equal(guestIdentity.enrolled, true)

  const ownerIdentity = await service.identify(voice(true), { sessionId: 's1', threshold: 0.52 })
  assert.equal(ownerIdentity.owner, true)
  assert.equal(ownerIdentity.label, '我')

  const restarted = new VoiceprintService({ dataDir: dir, extractor: fakeExtractor() })
  assert.equal(restarted.status().speakerCount, 1)
  assert.equal(restarted.status().speakers[0].id, guest.id)
  const afterRestart = await restarted.identify(voice(false), { sessionId: 's2', threshold: 0.52 })
  assert.equal(afterRestart.label, '老婆')
})

test('a named guest can be renamed and removed without touching the owner', async (t) => {
  const dir = workspace(t)
  const service = new VoiceprintService({ dataDir: dir, extractor: fakeExtractor() })
  await service.enroll(voice(true))
  const guest = await service.enrollSpeaker(voice(false), '老王')

  service.renameSpeaker(guest.id, '老张')
  assert.equal(service.status().speakers[0].name, '老张')
  const identity = await service.identify(voice(false), { sessionId: 's3', threshold: 0.52 })
  assert.equal(identity.label, '老张')
  assert.equal(service.status().enrolled, true)

  service.removeSpeaker(guest.id)
  assert.equal(service.status().speakerCount, 0)
  const unknown = await service.identify(voice(false), { sessionId: 's4', threshold: 0.52 })
  assert.equal(unknown.owner, false)
  assert.match(unknown.label, /^客人\d+$/)
})

test('deleting the owner template keeps the other people', async (t) => {
  const dir = workspace(t)
  const service = new VoiceprintService({ dataDir: dir, extractor: fakeExtractor() })
  await service.enroll(voice(true))
  await service.enrollSpeaker(voice(false), '老婆')
  service.forget()
  assert.equal(service.status().enrolled, false)
  assert.equal(service.status().speakerCount, 1)
  const identity = await service.identify(voice(false), { sessionId: 's5', threshold: 0.52 })
  assert.equal(identity.label, '老婆')
})

test('speaker names are unique and the owner name is reserved', async (t) => {
  const dir = workspace(t)
  const service = new VoiceprintService({ dataDir: dir, extractor: fakeExtractor() })
  await service.enrollSpeaker(voice(false), '老婆')
  await assert.rejects(() => service.enrollSpeaker(voice(true), '老婆'), /已经存在/)
  await assert.rejects(() => service.enrollSpeaker(voice(true), '我'), /不能/)
  await assert.rejects(() => service.enrollSpeaker(voice(true), '客人1'), /混淆/)
})

/**
 * Exact-vector extractor: the first sample picks the template, so a probe can
 * sit between two enrolled voices on purpose. Cosine similarities for the probe
 * (0.6, 0.95, 0) are 0.53 to the owner and 0.85 to the guest.
 */
function markerExtractor() {
  let first = 0
  const vector = (a, b) => {
    const out = new Float32Array(64)
    out[0] = a
    out[1] = b
    return out
  }
  return {
    dim: 64,
    createStream() {
      return { acceptWaveform(input) { first = input.samples[0] } }
    },
    compute() {
      if (first > 0.5) return vector(1, 0)
      if (first < -0.5) return vector(0, 1)
      // A weak owner match: 0.39 to the owner, below its 0.52 threshold.
      if (first > 0.2) return vector(0.4, 0.95)
      return vector(0.6, 0.95)
    },
  }
}

function marker(sign) {
  return new Float32Array(16000).fill(sign)
}

test('the stealing margin decides who wins a near tie', async (t) => {
  const dir = workspace(t)
  const service = new VoiceprintService({ dataDir: dir, extractor: markerExtractor() })
  await service.enroll(marker(1))
  await service.enrollSpeaker(marker(-1), '老婆')

  const tight = await service.identify(marker(0), { sessionId: 'm1', threshold: 0.52, margin: 0.3, adapt: false })
  assert.equal(tight.owner, true)
  assert.equal(tight.label, '我')

  const loose = await service.identify(marker(0), { sessionId: 'm2', threshold: 0.52, margin: 0.04, adapt: false })
  assert.equal(loose.owner, false)
  assert.equal(loose.label, '老婆')
})

test('the first utterance of a session is not turned into a guest', async (t) => {
  const dir = workspace(t)
  const service = new VoiceprintService({ dataDir: dir, extractor: markerExtractor() })
  await service.enroll(marker(1))

  // 0.39 similarity: below the 0.52 threshold, above the 0.35 "cannot be the owner" floor.
  const first = await service.identify(marker(0.3), { sessionId: 'f1', threshold: 0.52, margin: 0.12 })
  assert.equal(first.label, '我')
  assert.equal(first.owner, true)

  // The same audio twice: still the owner, and no 客人1 cluster was invented.
  const second = await service.identify(marker(0.3), { sessionId: 'f1', threshold: 0.52, margin: 0.12 })
  assert.equal(second.label, '我')
})
function decisionEntries(sessionId) {
  const log = join(tmpdir(), 'dsh-voice-voiceprint.jsonl')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.includes(`"sessionId":"${sessionId}"`))
    .map((line) => JSON.parse(line))
}

test('an unenrolled utterance never becomes the owner template or a guest', async (t) => {
  const dir = workspace(t)
  const storePath = join(dir, 'voiceprint.json')
  const service = new VoiceprintService({ dataDir: dir, extractor: fakeExtractor() })
  const sessionId = 'unenrolled-' + Date.now()

  // A guest may speak first; that must not permanently steal the owner identity.
  const first = await service.identify(voice(false), { sessionId, threshold: 0.7 })
  assert.equal(first.label, '我')
  assert.equal(first.owner, true)
  assert.equal(first.enrolled, false)
  assert.equal(service.status().enrolled, false)
  assert.equal(existsSync(storePath), false)

  const second = await service.identify(voice(false), { sessionId, threshold: 0.7 })
  assert.equal(second.label, '我')
  assert.equal(existsSync(storePath), false)
  assert.equal(service.status().speakerCount, 0)

  // The diagnostic log has to say the decision was made on degraded certainty.
  const entries = decisionEntries(sessionId)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].degraded, true)
  assert.equal(entries[0].seeded, false)
})

test('explicit enrollment creates the owner template and labels it 我', async (t) => {
  const dir = workspace(t)
  const storePath = join(dir, 'voiceprint.json')
  const service = new VoiceprintService({ dataDir: dir, extractor: fakeExtractor() })
  assert.equal(existsSync(storePath), false)

  await service.enroll(voice(true))
  assert.equal(existsSync(storePath), true)
  const stored = JSON.parse(readFileSync(storePath, 'utf8'))
  assert.equal(Array.isArray(stored.embedding), true)
  assert.equal(stored.embedding.length, 64)
  assert.equal(service.status().enrolled, true)

  const identity = await service.identify(voice(true), { sessionId: 'enrolled-' + Date.now(), threshold: 0.52 })
  assert.equal(identity.label, '我')
  assert.equal(identity.owner, true)
  assert.equal(identity.enrolled, true)
})
