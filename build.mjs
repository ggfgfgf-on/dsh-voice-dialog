// dsh-voice-dialog build: host ESM + client __ModuleLoader__ closure.
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

const PKG_ID = 'dsh-voice-dialog'
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

mkdirSync('lib', { recursive: true })

// Host: msedge-tts is bundled because dsh's CJS router breaks on its
// browser-polyfill specifiers; axios also needs a dynamic require shim.
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-llm',
    'sherpa-onnx-node',
    'node:*',
  ],
  banner: {
    js:
      "import { createRequire as __dshCreateRequire } from 'node:module';\n" +
      'const require = __dshCreateRequire(import.meta.url);',
  },
  logLevel: 'info',
})

// Client: the loader requires this exact CJS closure shape.
await build({
  entryPoints: ['src/client.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  external: PLATFORM_EXTERNALS,
  banner: {
    js:
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_ID)}, factory: (require) => {\n` +
      'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'info',
})

// Test surface for plain-node tests.
await build({
  entryPoints: ['src/segmenter.ts'],
  outfile: 'lib/segmenter.js',
  bundle: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})

await build({
  entryPoints: ['src/tts-queue.ts'],
  outfile: 'lib/tts-queue.js',
  bundle: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})

await build({
  entryPoints: ['src/voice-protocol.ts'],
  outfile: 'lib/voice-protocol.js',
  bundle: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})

await build({
  entryPoints: ['src/scheduler.ts'],
  outfile: 'lib/scheduler.js',
  bundle: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})

await build({
  entryPoints: ['src/queue-control.ts'],
  outfile: 'lib/queue-control.js',
  bundle: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})

await build({
  entryPoints: ['src/speaker-policy.ts'],
  outfile: 'lib/speaker-policy.js',
  bundle: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})

await build({
  entryPoints: ['src/speech-filter.ts'],
  outfile: 'lib/speech-filter.js',
  bundle: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})

await build({
  entryPoints: ['src/wav.ts'],
  outfile: 'lib/wav.js',
  bundle: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})

await build({
  entryPoints: ['src/voiceprint.ts'],
  outfile: 'lib/voiceprint.js',
  bundle: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})

console.log('[dsh-voice-dialog] build done')
