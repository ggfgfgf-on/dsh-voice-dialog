import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildGatePrompt, gatePromptChars, GATE_MAX_TOKENS, GATE_PROMPT_LIMIT, GATE_SYSTEM_PROMPT, GATE_TIMEOUT_MS,
} from '../lib/gate-prompt.js'
import {
  buildPlannerPrompt, plannerPromptChars, PLANNER_MAX_TOKENS, PLANNER_PROMPT_LIMIT,
} from '../lib/planner.js'
import { buildOrganizerPrompt, ORGANIZER_SYSTEM_PROMPT } from '../lib/organizer-history.js'

test('gate prompt stays inside the hard bound, even with a huge line', () => {
  const input = { text: '啊'.repeat(5000), playing: true, queued: 99 }
  const chars = gatePromptChars(input)
  assert.ok(chars <= GATE_PROMPT_LIMIT, chars + ' > ' + GATE_PROMPT_LIMIT)
  assert.ok(GATE_MAX_TOKENS <= 80)
  assert.ok(GATE_TIMEOUT_MS <= 1500)
})

test('the gate sees what is being read, what is still owed, and what waits', () => {
  const text = buildGatePrompt({
    text: '这个先停一下',
    playing: true,
    queued: 2,
    playingText: '正在读的那句',
    pending: ['正在读的那句', '还没读的第二句'],
    queue: ['排队的一句', '排队的另一句'],
    previousText: '主人上一句',
  })
  assert.ok(text.includes('正在读：正在读的那句'), text)
  assert.ok(text.includes('还没读：还没读的第二句'), text)
  assert.ok(text.includes('排队：2 条'), text)
  assert.ok(text.includes('排队的一句'), text)
  assert.ok(text.includes('上一句：主人上一句'), text)
  // The judgment is about intent, so the prompt asks for meaning and forbids
  // keyword matching; a keyword table would just be the old gate again.
  assert.ok(GATE_SYSTEM_PROMPT.includes('意图'))
  assert.ok(GATE_SYSTEM_PROMPT.includes('按意思判断，不要套关键词'))
  assert.ok(GATE_SYSTEM_PROMPT.includes('"action":"interrupt|queue|ignore"'))
  assert.ok(buildGatePrompt({ text: '嗯', playing: false, queued: 0 }).includes('正在读：无，助手空闲'))
})

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

test('a huge context is clipped instead of overflowing the gate', () => {
  const chars = gatePromptChars({
    text: '新'.repeat(4000),
    playing: true,
    queued: 9,
    playingText: '读'.repeat(4000),
    pending: Array.from({ length: 10 }, () => '待'.repeat(4000)),
    queue: Array.from({ length: 10 }, () => '队'.repeat(4000)),
    previousText: '上'.repeat(4000),
  })
  assert.ok(chars <= GATE_PROMPT_LIMIT, chars + ' > ' + GATE_PROMPT_LIMIT)
})

test('the old full organizer prompt never comes back to the reply path', () => {
  // The gate carries only hearing context; history and the whole queue plan
  // stay in the slow planner layer, which is never awaited on the reply path.
  const old = ORGANIZER_SYSTEM_PROMPT.length + buildOrganizerPrompt({
    playing: true, queued: 3, ownerWeight: 1, lane: 'owner', text: '这个先停一下',
    queue: [{ lane: 'owner', text: '第一句排队的话' }, { lane: 'guest', text: '第二句排队的话' }],
    history: Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant', text: '历史对话内容'.repeat(6),
    })),
    assistantPending: ['第一句要说的话', '第二句要说的话'],
  }).length
  const now = gatePromptChars({ text: '这个先停一下', playing: true, queued: 3 })
  assert.ok(now < old, now + ' !< ' + old)
  assert.ok(now <= GATE_PROMPT_LIMIT)
})
