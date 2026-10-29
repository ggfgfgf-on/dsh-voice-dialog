import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
const require=createRequire(import.meta.url); const ort=require('onnxruntime-node')
const model='C:/Users/chesand/.dsh/voice-dialog/models/mossformer2_ss_16k.onnx'
function readWav(buf){let off=12,fmt,dataOff,dataLen;while(off+8<=buf.length){const id=buf.toString('ascii',off,off+4),n=buf.readUInt32LE(off+4),body=off+8;if(id==='fmt ')fmt={channels:buf.readUInt16LE(body+2),rate:buf.readUInt32LE(body+4),bits:buf.readUInt16LE(body+14)};if(id==='data'){dataOff=body;dataLen=Math.min(n,buf.length-body);break}off=body+n+(n&1)}const count=Math.floor(dataLen/2),samples=new Float32Array(count);for(let i=0;i<count;i++)samples[i]=buf.readInt16LE(dataOff+i*2)/32768;return samples}
const samples=readWav(await readFile('D:/DSHwork/dsh-voice-dialog/test/.latency/speech2.wav')); const input=new Float32Array(64000); input.set(samples.subarray(16000,80000))
const configs=[{ep:'cpu',threads:1},{ep:'cpu',threads:2},{ep:'cpu',threads:4},{ep:'cpu',threads:8},{ep:{name:'dml',deviceId:0}},{ep:{name:'dml',deviceId:1}}]
for(const cfg of configs){
  const label=typeof cfg.ep==='string'?cfg.ep+':'+cfg.threads:'dml:'+cfg.ep.deviceId
  try{
    const t0=performance.now(); const session=await ort.InferenceSession.create(model,{executionProviders:[cfg.ep],graphOptimizationLevel:'all',intraOpNumThreads:cfg.ep==='cpu'?cfg.threads:1,interOpNumThreads:1}); const load=performance.now()-t0
    const tensor=new ort.Tensor('float32',input,[1,input.length]); await session.run({mix:tensor}); const times=[]
    for(let i=0;i<3;i++){const t=performance.now();await session.run({mix:tensor});times.push(Math.round(performance.now()-t))}
    console.log(JSON.stringify({label,load:Math.round(load),times})); await session.release?.()
  }catch(e){console.log(JSON.stringify({label,error:String(e).slice(0,500)}))}
}
