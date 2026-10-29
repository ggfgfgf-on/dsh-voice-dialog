import { SeparationService } from '../../lib/separation.js'
const s=new SeparationService({dataDir:'C:/Users/chesand/.dsh/voice-dialog',modelPath:'C:/Users/chesand/.dsh/voice-dialog/models/mossformer2_ss_16k.onnx',executionProviders:['dml'],dmlDeviceId:999})
const t=performance.now()
await s.warm()
console.log(JSON.stringify({coldMs:Math.round(performance.now()-t),backend:s.status().backend}))
const r=await s.separate(new Float32Array(64000).fill(0.02))
console.log(JSON.stringify({ok:true,backend:s.status().backend,elapsedMs:r.elapsedMs,sources:r.sources.length}))
await s.close()
