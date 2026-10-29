/**
 * Split usefulness for the two organizer layers, read from the host log.
 *
 *   node tools/organizer-stats.mjs [logPath]
 *
 * Output arrangement (planner): calls that actually changed order/dropped a
 * sentence ÷ calls. Interrupt gate (fast layer): calls that actually stopped
 * playback ÷ calls. Low rates mean the layer is costing a model round-trip
 * without changing what the listener hears.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const GATE_MIN_USEFUL = 0.15
const PLANNER_MIN_USEFUL = 0.20

const path = process.argv[2] || join(tmpdir(), 'dsh-voice-organizer.log')
const lines = (() => {
  try { return readFileSync(path, 'utf8').split('\n').filter(Boolean) }
  catch { return [] }
})()

const stats = {
  gate: { calls: 0, stops: 0, idleCalls: 0, byAction: {} },
  planner: { calls: 0, arrangements: 0, byAction: {} },
  skipped: 0,
}
for (const line of lines) {
  const match = /layer=(gate|planner)\s+(\S+)\s+.*?changed=(\d+)(?: playing=(\d))?/u.exec(line)
  if (!match) continue
  const [, layer, action, changed, playing] = match
  const bucket = stats[layer]
  bucket.calls += 1
  bucket.byAction[action] = (bucket.byAction[action] ?? 0) + 1
  if (layer === 'gate' && playing === '0') bucket.idleCalls += 1
  if (changed === '1') {
    if (layer === 'gate') bucket.stops += 1
    else bucket.arrangements += 1
  }
}

const rate = (part, whole) => (whole === 0 ? null : part / whole)
const gateRate = rate(stats.gate.stops, stats.gate.calls)
const plannerRate = rate(stats.planner.arrangements, stats.planner.calls)

const report = {
  logPath: path,
  samples: lines.length,
  outputArrangement: {
    calls: stats.planner.calls,
    changedOrderOrDropped: stats.planner.arrangements,
    usefulness: plannerRate,
    byAction: stats.planner.byAction,
    advice: plannerRate === null
      ? 'no samples yet'
      : plannerRate < PLANNER_MIN_USEFUL
        ? 'below ' + Math.round(PLANNER_MIN_USEFUL * 100) + '%: keep only the deterministic rule (先说结论/别讲背景), drop the model plan'
        : 'keep',
  },
  interruptGate: {
    calls: stats.gate.calls,
    callsWhileIdle: stats.gate.idleCalls,
    actuallyStopped: stats.gate.stops,
    usefulness: gateRate,
    byAction: stats.gate.byAction,
    advice: gateRate === null
      ? 'no samples yet'
      : gateRate < GATE_MIN_USEFUL
        ? 'below ' + Math.round(GATE_MIN_USEFUL * 100) + '%: disable the fast gate, keep the deterministic stop commands'
        : 'keep',
  },
}

console.log(JSON.stringify(report, null, 2))
