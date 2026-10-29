import { createRequire } from 'node:module'
const require=createRequire(import.meta.url)
const ort=require('onnxruntime-node')
const model='C:/Users/chesand/.dsh/voice-dialog/models/mossformer2_ss_16k.onnx'
let session
for (const provider of ['cpu']) {
  try {
    const t=performance.now()
    session=await ort.InferenceSession.create(model,{executionProviders:[provider],graphOptimizationLevel:'all',intraOpNumThreads:provider==='cpu'?8:1,interOpNumThreads:1})
    console.log('load',provider,(performance.now()-t).toFixed(1));break
  } catch(e){console.log('load fail',provider,e.message.slice(0,200))}
}
if(!session) process.exit(1)
for(const n of [64000]){
  const input=new Float32Array(n)
  for(let i=0;i<n;i++) input[i]=0.01*Math.sin(i*0.02)
  try{
    for(let k=0;k<4;k++){
      const t=performance.now()
      const out=await session.run({mix:new ort.Tensor('float32',input,[1,n])})
      const names=Object.keys(out)
      console.log('n',n,'run',k,(performance.now()-t).toFixed(1),'outs',names.map(x=>x+':'+out[x].dims.join('x')).join(','))
    }
  }catch(e){console.log('n',n,'FAIL',e.message.slice(0,300))}
}
await session.release?.()
