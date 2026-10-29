// dsh-voice-dialog build: host ESM + client __ModuleLoader__ closure.
import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'

const PKG_ID = 'dsh-voice-dialog'
const LIB = 'lib'
const REQUIRE_BANNER = [
  "import { createRequire as __dshCreateRequire } from 'node:module';",
  'const require = __dshCreateRequire(import.meta.url);',
].join('\n')
const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

// Plain-node modules imported directly by test/*.test.mjs. They share one
// transpile-only build because bundling each module separately is unnecessary
// and makes it easy to forget a new surface.
const TEST_SURFACES = [
  'arrange',
  'audio-transport',
  'barge-in',
  'continuous-separation',
  'expression',
  'fast-lane',
  'frame-order',
  'gate-prompt',
  'gates',
  'input-gate',
  'interruption',
  'latency',
  'organizer',
  'organizer-compact',
  'organizer-history',
  'planner',
  'queue-control',
  'rewriter',
  'routing',
  'scheduler',
  'segmenter',
  'separation',
  'separation-align',
  'separation-gate',
  'separation-worker',
  'speaker',
  'speaker-policy',
  'speech-filter',
  'speech-profile',
  'tts-queue',
  'utterance-coalescer',
  'voice-marker',
  'voice-protocol',
  'voiceprint',
  'volume-gain',
  'volume-log',
  'volume-report',
  'wav',
  'yield',
]

// These have runtime-only peers or are forked as standalone workers, so they
// keep their own bundle options.
const SPECIAL_SURFACES = [
  {
    entry: 'attention',
    options: {
      target: 'node22',
      bundle: true,
      external: ['node:*', '@deepseek-ai/*', 'msedge-tts'],
      logLevel: 'warning',
    },
  },
  {
    entry: 'continuous-separation',
    options: { bundle: true, logLevel: 'silent' },
  },
  {
    entry: 'separation-worker',
    options: {
      bundle: true,
      external: ['onnxruntime-node', 'node:*'],
      banner: { js: REQUIRE_BANNER },
      logLevel: 'silent',
    },
  },
]

mkdirSync(LIB, { recursive: true })

async function runBuild(options) {
  await build(options)
}

// Host: msedge-tts is bundled because dsh's CJS router breaks on its
// browser-polyfill specifiers; axios also needs a dynamic require shim.
await runBuild({
  entryPoints: ['src/index.ts'],
  outfile: LIB + '/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-llm',
    'sherpa-onnx-node',
    'onnxruntime-node',
    'node:*',
  ],
  banner: { js: REQUIRE_BANNER },
  logLevel: 'info',
})

// Client: the loader requires this exact CJS closure shape.
await runBuild({
  entryPoints: ['src/client.tsx'],
  outfile: LIB + '/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  external: PLATFORM_EXTERNALS,
  banner: {
    js:
      'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PKG_ID) + ', factory: (require) => {\n' +
      'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'info',
})

// All dependency-free test surfaces in one call.
await runBuild({
  entryPoints: TEST_SURFACES.map((name) => 'src/' + name + '.ts'),
  outdir: LIB,
  bundle: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})

for (const surface of SPECIAL_SURFACES) {
  await runBuild({
    entryPoints: ['src/' + surface.entry + '.ts'],
    outfile: LIB + '/' + surface.entry + '.js',
    format: 'esm',
    platform: 'node',
    ...surface.options,
  })
}

const expected = [
  'index.js',
  'client.js',
  ...TEST_SURFACES.map((name) => name + '.js'),
  ...SPECIAL_SURFACES.map((surface) => surface.entry + '.js'),
]
const missing = expected.filter((name) => !existsSync(LIB + '/' + name))
const empty = expected.filter((name) => {
  try { return statSync(LIB + '/' + name).size === 0 } catch { return false }
})
if (missing.length > 0) throw new Error('missing build artifacts: ' + missing.join(', '))
if (empty.length > 0) throw new Error('empty build artifacts: ' + empty.join(', '))

const client = readFileSync(LIB + '/client.js', 'utf8')
if (!client.includes('__ModuleLoader__.load')) {
  throw new Error('client bundle is missing the module-loader closure')
}
const host = readFileSync(LIB + '/index.js', 'utf8')
if (!host.includes('export')) throw new Error('host bundle is not an ESM module')

console.log(
  '[dsh-voice-dialog] build done: ' + expected.length + ' artifacts, '
  + TEST_SURFACES.length + ' test surfaces',
)
