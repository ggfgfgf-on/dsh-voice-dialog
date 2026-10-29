import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

const target = process.argv[2] ?? 'D:/DSHwork/dsh-voice-dialog/lib/index.js'
console.log('target: ' + target)
const mod = await import(pathToFileURL(target).href)
const apply = mod.apply
if (typeof apply !== 'function') { console.log('FAIL: no apply export, keys=' + Object.keys(mod).join(',')); process.exit(1) }

const routes = new Map()
const handlers = new Map()
const ctx = {
  on(event, fn) { const list = handlers.get(event) ?? []; list.push(fn); handlers.set(event, list); return () => {} },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  webServer: { register(route) { routes.set(route.path, route.handler); return () => {} } },
  tools: { register() { return () => {} } },
  systemPrompt: { section() { return () => {} } },
  llm: {},
  logger: { warn() {}, info() {}, error() {} },
  get() { return undefined },
}
const config = { enabled: true, basePath: '/dsh-voice-dialog-api', voice: 'zh-CN-XiaoxiaoNeural', rate: 0, rewriteEnabled: true, fastLaneEnabled: true }
try { apply(ctx, config) } catch (error) {
  console.log('APPLY FAIL: ' + (error && error.stack ? error.stack.split('\n').slice(0, 5).join(' | ') : String(error)))
  process.exit(1)
}
console.log('apply ok, routes=' + routes.size + ' events=' + [...handlers.keys()].join(','))

function call(routePath, body) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'; req.url = routePath
    req.headers = { 'content-type': 'application/json' }
    const out = { status: 0, body: '' }
    const res = {
      writeHead(code) { out.status = code; return res },
      setHeader() { return res },
      getHeader() { return undefined },
      end(data) { if (data !== undefined) out.body += String(data); resolve(out); return res },
      write(data) { if (data !== undefined) out.body += String(data); return true },
    }
    const handler = routes.get(routePath)
    if (!handler) { resolve({ status: -1, body: 'no route ' + routePath }); return }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

const base = '/dsh-voice-dialog-api'
console.log('state:', JSON.stringify(await call(base + '/voice-state', { sessionId: 'probe-1', clientId: 'probe-c', active: true })))
console.log('speech:', JSON.stringify(await call(base + '/voice-state', { sessionId: 'probe-1', speech: 'start' })))

const tapList = handlers.get('llm/stream')
if (!tapList || tapList.length === 0) { console.log('FAIL: no llm/stream tap'); process.exit(1) }
const tap = tapList[tapList.length - 1]

async function* inner() {
  yield { type: 'text-delta', text: '第一句。' }
  yield { type: 'text-delta', text: '第二句。' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
let n = 0
try {
  const out = tap({ sessionId: 'probe-1', provider: 'p', model: 'm' }, () => inner())
  for await (const chunk of out) {
    n += 1
    if (chunk && chunk.type === 'text-delta') console.log('chunk ' + n + ': ' + JSON.stringify(chunk.text))
    if (n >= 3) break
  }
  console.log('TAP OK chunks=' + n)
} catch (error) {
  console.log('TAP FAIL: ' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : String(error)))
  process.exitCode = 1
}
// Blanket scope check: a handler that reaches an identifier it cannot see
// answers with "X is not defined". Ask every registered route, not just the tap.
const sweep = []
for (const path of routes.keys()) {
  try {
    const res = await call(path, { sessionId: 'probe-1', clientId: 'probe-c', active: true, speech: 'end', text: '你好。', blocks: [], lane: 'owner' })
    if (res.status >= 500 || /is not defined/.test(res.body)) sweep.push(path + ' -> ' + res.status + ' ' + res.body.slice(0, 120))
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    if (/is not defined/.test(message)) sweep.push(path + ' threw ' + message)
  }
}
console.log(sweep.length === 0 ? 'SWEEP OK ' + routes.size + ' routes' : 'SWEEP FAIL\n' + sweep.join('\n'))

setTimeout(() => { console.log('probe done'); process.exit(process.exitCode ?? 0) }, 1200)
