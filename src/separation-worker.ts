/** Isolated ONNX worker: sherpa-onnx already loads its own onnxruntime.dll in the host. */
import { createRequire } from 'node:module'
import { separateWithRunner } from './separation.ts'

const require = createRequire(import.meta.url)
let ort: any
let session: any
let backend = 'cpu'
let modelPath = ''

async function load(forceCpu = false): Promise<void> {
  ort = ort ?? require('onnxruntime-node')
  const providers = forceCpu ? ['cpu'] : ['dml', 'cpu']
  let lastError: unknown
  for (const provider of providers) {
    try {
      session = await ort.InferenceSession.create(modelPath, {
        executionProviders: [provider],
        graphOptimizationLevel: 'all',
        intraOpNumThreads: provider === 'cpu' ? 8 : 1,
        interOpNumThreads: 1,
      })
      backend = provider
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function run(input: Float32Array): Promise<[Float32Array, Float32Array]> {
  const tensor = new ort.Tensor('float32', input, [1, input.length])
  try {
    const output = await session.run({ mix: tensor })
    const data = output.sources.data as Float32Array
    return [
      Float32Array.from(data.subarray(0, input.length)),
      Float32Array.from(data.subarray(input.length, input.length * 2)),
    ]
  } catch (error) {
    // A DML session can initialize without a usable adapter.
    if (backend === 'dml') {
      try { await session.release?.() } catch { /* ignore */ }
      session = undefined
      await load(true)
      return run(input)
    }
    throw error
  }
}

process.on('message', (message: any) => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'init') {
    modelPath = String(message.modelPath ?? '')
    load().then(
      () => { process.send?.({ type: 'ready', backend }) },
      (error: unknown) => {
        process.send?.({ type: 'fatal', error: error instanceof Error ? error.message : String(error) }, () => {
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
        process.send?.({ type: 'error', id: message.id, error: error instanceof Error ? error.message : String(error) })
      },
    )
  }
})
