#!/usr/bin/env node
/**
 * Summarize the voice latency JSONL: per-stage medians, the four-wait split and
 * a "does the split add up" check. Usage: node tools/latency-summary.mjs [file] [limit]
 * Default file: %TEMP%/dsh-voice-latency.jsonl. Prints one block, no raw rows.
 */
import fs from 'node:fs'
import path from 'node:path'

const file = process.argv[2] ?? path.join(process.env.TEMP ?? '.', 'dsh-voice-latency.jsonl')
const limit = Number(process.argv[3] ?? 400)
const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(-limit)
const records = []
for (const line of lines) {
  try { records.push(JSON.parse(line)) } catch { /* torn line */ }
}
const utterances = records.filter((r) => r.kind === 'utterance')
const numbers = (values) => values.filter((v) => typeof v === 'number' && Number.isFinite(v))
const median = (values) => { const v = numbers(values).sort((a, b) => a - b); return v.length === 0 ? null : v[Math.floor(v.length / 2)] }
const mean = (values) => { const v = numbers(values); return v.length === 0 ? null : Math.round(v.reduce((a, b) => a + b, 0) / v.length) }
const stdev = (values) => {
  const v = numbers(values)
  if (v.length < 2) return null
  const m = v.reduce((a, b) => a + b, 0) / v.length
  return Math.round(Math.sqrt(v.reduce((sum, x) => sum + (x - m) ** 2, 0) / (v.length - 1)))
}
const row = (label, values) => {
  const n = numbers(values).length
  console.log(label.padEnd(22), 'n=' + String(n).padEnd(4), 'median=' + String(median(values) ?? '-').padEnd(8),
    'mean=' + String(mean(values) ?? '-').padEnd(8), 'sd=' + String(stdev(values) ?? '-'))
}

console.log('file:', file)
console.log('records:', records.length, 'utterances:', utterances.length)
if (utterances.length === 0) process.exit(0)
row('totalMs', utterances.map((r) => r.totalMs))
for (const stage of ['utterance_end', 'separation_done', 'asr_start', 'asr_done', 'organize_start', 'organize_done', 'enqueue', 'first_token', 'play_start']) {
  row('stage ' + stage, utterances.map((r) => r.stagesMs?.[stage]))
}
console.log('--- four-wait split')
for (const key of ['endpointWaitMs', 'separationWaitMs', 'asrQueueMs', 'asrTransportMs', 'asrInferMs', 'asrWallMs', 'decomposedMs', 'residualMs']) {
  row(key, utterances.map((r) => r[key]))
}
console.log('--- separation composition')
for (const key of ['separationQueueMs', 'separationModelMs', 'separationWallMs', 'separationPrewarmWaitMs', 'separationWindowMs', 'separationModelCalls', 'separationSelfSimilarity', 'separationOwnerSimilarity']) {
  row(key, utterances.map((r) => r[key]))
}
const modes = ['fast', 'continuous', 'fallback']
console.log('mode:', modes.map((mode) => mode + '=' + utterances.filter((r) => r.separationMode === mode).length).join(' '),
  '| prewarm:', ['hit', 'miss', 'discarded'].map((value) => value + '=' + utterances.filter((r) => r.separationPrewarm === value).length).join(' '))
const gates = [...new Set(utterances.map((r) => r.separationGate).filter(Boolean))]
if (gates.length > 0) console.log('gate:', gates.map((gate) => gate + '=' + utterances.filter((r) => r.separationGate === gate).length).join(' '))
const explicit = utterances.filter((r) => typeof r.decomposedMs === 'number')
const clean = explicit.filter((r) => Math.abs(r.residualMs ?? 0) <= 30)
if (explicit.length > 0) {
  console.log('--- decomposition check')
  console.log('utterances with a full split:', explicit.length + '/' + utterances.length)
  console.log('split within +/-30 ms of the measured total:', clean.length + '/' + explicit.length)
  console.log('worst residual:', Math.max(...explicit.map((r) => Math.abs(r.residualMs ?? 0))) + ' ms')
}
