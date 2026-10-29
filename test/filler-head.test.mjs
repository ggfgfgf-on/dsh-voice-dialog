import assert from 'node:assert/strict'
import test from 'node:test'
import { stripFillerHead } from '../lib/segmenter.js'

test('a filler opener is dropped when a real sentence survives', () => {
  assert.equal(stripFillerHead('好，我们先把队列修了'), '我们先把队列修了')
  assert.equal(stripFillerHead('那么现在，我们重跑测试'), '我们重跑测试')
  assert.equal(stripFillerHead('其实日志里已经写了原因'), '日志里已经写了原因')
})

test('process preambles are dropped, not spoken', () => {
  assert.equal(stripFillerHead('我先确认一下，构建是通过的'), '构建是通过的')
  assert.equal(stripFillerHead('稍等，我先看一下日志里写了什么'), '日志里写了什么')
  assert.equal(stripFillerHead('让我想想，应该先修队列'), '应该先修队列')
})

test('filler leads are dropped', () => {
  assert.equal(stripFillerHead('总的来说，延迟已经降下来了'), '延迟已经降下来了')
  assert.equal(stripFillerHead('需要注意的是，这个开关默认开着'), '开关默认开着')
})

test('a standalone confirmation is content, not filler', () => {
  assert.equal(stripFillerHead('对'), '对')
  assert.equal(stripFillerHead('对。'), '对。')
})

test('nothing is dropped when the remainder is too short', () => {
  assert.equal(stripFillerHead('对，可以'), '对，可以')
  assert.equal(stripFillerHead('现在'), '现在')
})
