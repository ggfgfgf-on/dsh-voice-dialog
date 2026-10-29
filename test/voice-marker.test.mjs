import test from 'node:test'
import assert from 'node:assert/strict'
import { VisibleVoiceFilter } from '../lib/voice-marker.js'

test('complete voice directives are removed from visible text', () => {
  const filter = new VisibleVoiceFilter()
  assert.equal(filter.push('先说结论 [[voice: 轻一点]] 再继续'), '先说结论  再继续')
  assert.equal(filter.push('[[VOICE：stop]]'), '')
  assert.equal(filter.push('普通方括号 [[不是指令]] 保留'), '普通方括号 [[不是指令]] 保留')
})

test('a directive split across chunks never leaks', () => {
  const filter = new VisibleVoiceFilter()
  assert.equal(filter.push('先说结论 [[vo'), '先说结论 ')
  assert.equal(filter.push('ice: 慢一点]] 再继续'), ' 再继续')

  const fullwidth = new VisibleVoiceFilter()
  assert.equal(fullwidth.push('甲[[voice'), '甲')
  assert.equal(fullwidth.push('：停]]乙'), '乙')
})

test('ordinary double brackets are delayed only while they could become a directive', () => {
  const filter = new VisibleVoiceFilter()
  assert.equal(filter.push('普通 [['), '普通 ')
  assert.equal(filter.push(' 文本'), '[[ 文本')

  const prose = new VisibleVoiceFilter()
  assert.equal(prose.push('看这个 [[voice'), '看这个 ')
  assert.equal(prose.push(' 不是指令'), '[[voice 不是指令')
})

test('an unfinished directive is dropped at stream end', () => {
  const filter = new VisibleVoiceFilter()
  assert.equal(filter.push('结尾 [[voice: 未闭合'), '结尾 ')
  assert.equal(filter.finish(), '')
})
