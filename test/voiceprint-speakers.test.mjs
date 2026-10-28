import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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
