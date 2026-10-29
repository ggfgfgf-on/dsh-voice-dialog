/** Isolated ONNX worker: sherpa-onnx already loads its own onnxruntime.dll in the host. */
import { createRequire } from 'node:module'
import { separateWithRunner } from './separation.ts'

const require = createRequire(import.meta.url)
const DEFAULT_EXECUTION_PROVIDERS = ['dml']
const DEFAULT_DML_DEVICE_ID = 0
let ort: any
let session: any
let backend = ''
let modelPath = ''
let preferredProviders = [...DEFAULT_EXECUTION_PROVIDERS]
let dmlDeviceId = DEFAULT_DML_DEVICE_ID

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeProviders(value: unknown): string[] {
  const source = Array.isArray(value) ? value : []
  const unique = [...new Set(
    source
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  )]
  return unique.length > 0 ? unique : [...DEFAULT_EXECUTION_PROVIDERS]
}

function withCpuFallback(providers: string[]): string[] {
  return providers.includes('cpu') ? providers : [...providers, 'cpu']
}

function providerOption(provider: string): unknown {
  if (provider === 'dml') return { name: 'dml', deviceId: dmlDeviceId }
  return provider
}

function publishBackend(note?: string): void {
  // stderr is captured by the parent and printed on fatal startup errors.
  console.error(
    '[separation-worker] backend=' + backend
    + ' dmlDeviceId=' + dmlDeviceId
    + (note ? ' (' + note + ')' : ''),
  )
  try { process.send?.({ type: 'backend', backend }) } catch { /* parent may be gone */ }
}

async function activate(provider: string, note?: string): Promise<void> {
  session = await ort.InferenceSession.create(modelPath, {
    executionProviders: [providerOption(provider)],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: provider === 'cpu' ? 8 : 1,
    interOpNumThreads: 1,
  })
  backend = provider
  publishBackend(note)
}

async function load(): Promise<void> {
  ort = ort ?? require('onnxruntime-node')
  const providers = withCpuFallback(preferredProviders)
  const failures: string[] = []
  console.error(
    '[separation-worker] requested providers=' + providers.join(',')
    + ' dmlDeviceId=' + dmlDeviceId,
  )
  for (const provider of providers) {
    try {
      await activate(provider)
      return
    } catch (error) {
      const detail = errorText(error)
      failures.push(provider + ': ' + detail)
      console.error('[separation-worker] provider ' + provider + ' unavailable: ' + detail)
    }
  }
  throw new Error('没有可用的 ONNX execution provider（' + failures.join(' | ') + '）')
}

async function runOnce(input: Float32Array): Promise<[Float32Array, Float32Array]> {
  const tensor = new ort.Tensor('float32', input, [1, input.length])
  const output = await session.run({ mix: tensor })
  const data = output.sources.data as Float32Array
  return [
    Float32Array.from(data.subarray(0, input.length)),
    Float32Array.from(data.subarray(input.length, input.length * 2)),
  ]
}

async function run(input: Float32Array): Promise<[Float32Array, Float32Array]> {
  try {
    return await runOnce(input)
  } catch (error) {
    // A DML session can initialize without a usable adapter.
    if (backend !== 'cpu') {
      const failed = backend || 'unknown'
      console.error(
        '[separation-worker] ' + failed + ' inference failed; retrying on CPU: ' + errorText(error),
      )
      try { await session.release?.() } catch { /* ignore */ }
      session = undefined
      backend = ''
      await activate('cpu', 'inference fallback')
      return runOnce(input)
    }
    throw error
  }
}

process.on('message', (message: any) => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'init') {
    modelPath = String(message.modelPath ?? '')
    preferredProviders = normalizeProviders(message.executionProviders)
    dmlDeviceId = Number.isInteger(message.dmlDeviceId) && message.dmlDeviceId >= 0
      ? message.dmlDeviceId
      : DEFAULT_DML_DEVICE_ID
    load().then(
      () => { process.send?.({ type: 'ready', backend }) },
      (error: unknown) => {
        process.send?.({ type: 'fatal', error: errorText(error) }, () => {
          process.exit(1)
        })
        setTimeout(() => process.exit(1), 500)
      },
    )
    return
  }
  if (message.type === 'separate') {
    const samples = Float32Array.from(message.samples as Float32Array)
    separateWithRunner(samples, run).then(
      (result) => { process.send?.({ type: 'result', id: message.id, ...result }) },
      (error: unknown) => {
        process.send?.({ type: 'error', id: message.id, error: errorText(error) })
      },
    )
  }
})
