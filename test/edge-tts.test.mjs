import assert from 'node:assert/strict'
import test from 'node:test'
import { bypassProxy, resolveProxyUrl } from '../lib/tts-queue.js'

test('resolves HTTPS_PROXY and honors an explicit DSH override', () => {
  assert.equal(resolveProxyUrl({ HTTPS_PROXY: 'http://127.0.0.1:7890' }), 'http://127.0.0.1:7890')
  assert.equal(resolveProxyUrl({ HTTPS_PROXY: 'http://a:1', DSH_VOICE_TTS_PROXY: 'http://b:2' }), 'http://b:2')
  assert.equal(resolveProxyUrl({ HTTPS_PROXY: 'socks5://127.0.0.1:7890' }), undefined)
  assert.equal(resolveProxyUrl({}), undefined)
})

test('NO_PROXY can exempt the Edge endpoint', () => {
  assert.equal(bypassProxy('speech.platform.bing.com', { NO_PROXY: 'localhost,127.0.0.1' }), false)
  assert.equal(bypassProxy('speech.platform.bing.com', { NO_PROXY: '.platform.bing.com' }), true)
  assert.equal(bypassProxy('speech.platform.bing.com', { NO_PROXY: '*' }), true)
  assert.equal(bypassProxy('SPEECH.PLATFORM.BING.COM', { NO_PROXY: 'speech.platform.bing.com:443' }), true)
})
