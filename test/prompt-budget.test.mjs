import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPlannerPrompt, plannerPromptChars, PLANNER_MAX_TOKENS, PLANNER_PROMPT_LIMIT,
} from '../lib/planner.js'

// The gate prompt tests that used to live here are gone with the module: the
// input gate is decided locally by plan.ts (L3), and the /organize route that
// built a model prompt for it has been deleted.

test('planner prompt stays inside the hard 1600 character bound', () => {
  const input = {
    text: '新'.repeat(4000), lane: 'owner', playing: true, queued: 9,
    queue: Array.from({ length: 9 }, (_, index) => ({ id: index, lane: 'guest', text: '队列'.repeat(200) })),
    assistantPending: Array.from({ length: 20 }, () => '待说'.repeat(300)),
    history: Array.from({ length: 12 }, () => ({ role: 'user', text: '历史'.repeat(300) })),
  }
  const chars = plannerPromptChars(input)
  assert.ok(chars <= PLANNER_PROMPT_LIMIT, chars + ' > ' + PLANNER_PROMPT_LIMIT)
  assert.ok(PLANNER_MAX_TOKENS <= 200)
  assert.ok(buildPlannerPrompt(input).includes('新话：'))
})
