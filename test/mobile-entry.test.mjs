// Phone reachability contract: the settings form must stay reachable without
// the shell's Plugins page, and the Remote contribution must not be shadowed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../src/client.tsx', import.meta.url), 'utf8')

test('the generated Remote contribution is mounted, not a local helper', () => {
  assert.match(client, /import speechRemote from '\.\/speech-remote\.js'/)
  assert.match(client, /\$mount\(speechRemote\)/)
  // The helper that resolves ctx.remote.speech at call time must own a
  // different name: a same-named declaration makes esbuild bind $mount to the
  // helper and the runtime throws "contribution.descriptors is not iterable".
  assert.doesNotMatch(client, /function speechRemote\s*\(/)
  assert.match(client, /function requireSpeech\s*\(/)
})

test('no extra icon is bolted onto the composer row', () => {
  // The owner explicitly rejected a settings gear next to the microphone.
  assert.doesNotMatch(client, /aria-label="语音设置"/)
  assert.doesNotMatch(client, /dsh-vd-gear/)
})

test('a failure is visible without a tooltip', () => {
  // Phones cannot hover: the error gets real space plus a fixed banner.
  assert.match(client, /className="dsh-vd-inlineError" role="alert"/)
  assert.match(client, /className="dsh-vd-banner" role="alert"/)
  assert.match(client, /useEffect\(\(\) => \{\s*if \(!error\) return\s*setBanner\(error\)/)
})

test('the origin is not pre-judged, only a missing API is refused', () => {
  // A browser flag or an https proxy can make getUserMedia work on an origin
  // that still reports isSecureContext=false, so the gate must not fire there.
  assert.doesNotMatch(client, /!window\.isSecureContext \|\|/)
  assert.match(client, /if \(!navigator\.mediaDevices\?\.getUserMedia\)/)
  assert.match(client, /这个浏览器没有麦克风接口/)
})
test('no extra microphone is bolted onto the page', () => {
  // The owner rejected both the settings gear and the floating mic: the
  // composer row is the only microphone surface.
  assert.doesNotMatch(client, /shell\.overlay/)
  assert.doesNotMatch(client, /MobileMicFab/)
  assert.doesNotMatch(client, /micBridge/)
  assert.doesNotMatch(client, /dsh-vd-fab/)
})

test('no phone-only branch exists in the client', () => {
  // The owner asked for one behaviour on both screens: no media query, no
  // long-press, no separate settings sheet, no floating entry point.
  assert.doesNotMatch(client, /max-width: (600|420)px/)
  assert.doesNotMatch(client, /matchMedia\(/)
  assert.doesNotMatch(client, /longPress|suppressClick/)
  assert.doesNotMatch(client, /VoiceSettingsSheet|setSheetOpen/)
  assert.doesNotMatch(client, /dsh-vd-fab|shell\.overlay|micBridge/)
})
