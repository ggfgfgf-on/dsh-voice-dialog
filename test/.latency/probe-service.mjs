import { SeparationService } from '../../lib/separation.js'
const s=new SeparationService({dataDir:'C:/Users/chesand/.dsh/voice-dialog',modelPath:'C:/Users/chesand/.dsh/voice-dialog/models/mossformer2_ss_16k.onnx'})
const t=performance.now()
await s.warm()
console.log(JSON.stringify({coldMs:Math.round(performance.now()-t),status:s.status()}))
await s.close()
