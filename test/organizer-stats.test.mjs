import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const script = new URL('../tools/organizer-stats.mjs', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/u, '')

function run(logText) {
  const file = join(mkdtempSync(join(tmpdir(), 'orgstats-')), 'log.txt')
  writeFileSync(file, logText, 'utf8')
  const raw = execFileSync(process.execPath, [script, file], { encoding: 'utf8' })
  return JSON.parse(raw)
}

test('usefulness is split: gate counts stops, planner counts changed arrangements', () => {
  const log = [
    't layer=gate interrupt 正在播 playing=1 promptChars=300 maxTokens=24 ms=210 changed=1 playing=1 text=6 preview=x',
    't layer=gate queue 保留 playing=1 promptChars=300 maxTokens=24 ms=190 changed=0 playing=1 text=6 preview=x',
    't layer=gate queue 保留 playing=1 promptChars=300 maxTokens=24 ms=200 changed=0 playing=1 text=6 preview=x',
    't layer=gate queue 保留 playing=1 promptChars=300 maxTokens=24 ms=180 changed=0 playing=1 text=6 preview=x',
    't layer=planner plan 先说结论 playing=1 promptChars=900 maxTokens=200 ms=420 changed=1 playing=1 text=8 preview=x',
    't layer=planner unchanged 不变 playing=1 promptChars=900 maxTokens=200 ms=380 changed=0 playing=1 text=8 preview=x',
    't layer=planner rule 先说结论 playing=0 promptChars=900 maxTokens=200 ms=5 changed=1 playing=0 text=8 preview=x',
  ].join('\n')
  const report = run(log)
  assert.equal(report.interruptGate.calls, 4)
  assert.equal(report.interruptGate.actuallyStopped, 1)
  assert.equal(report.interruptGate.usefulness, 0.25)
  assert.equal(report.outputArrangement.calls, 3)
  assert.equal(report.outputArrangement.changedOrderOrDropped, 2)
  assert.equal(Number(report.outputArrangement.usefulness.toFixed(2)), 0.67)
  assert.match(report.interruptGate.advice, /keep/u)
})

test('an empty log reports no samples instead of dividing by zero', () => {
  const report = run('')
  assert.equal(report.interruptGate.usefulness, null)
  assert.equal(report.outputArrangement.usefulness, null)
  assert.match(report.interruptGate.advice, /no samples/u)
})
