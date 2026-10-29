import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
const require=createRequire(import.meta.url); const ort=require('onnxruntime-node')
const model='C:/Users/chesand/.dsh/voice-dialog/models/mossformer2_ss_16k.onnx'
const dev=Number(process.argv[2]); const kind=process.argv[3]||'dml'
function readWav(buf){let off=12,fmt,dataOff,dataLen;while(off+8<=buf.length){const id=buf.toString('ascii',off,off+4),n=buf.readUInt32LE(off+4),body=off+8;if(id==='fmt ')fmt={channels:buf.readUInt16LE(body+2),rate:buf.readUInt32LE(body+4),bits:buf.readUInt16LE(body+14)};if(id==='data'){dataOff=body;dataLen=Math.min(n,buf.length-body);break}off=body+n+(n&1)}const count=Math.floor(dataLen/2),samples=new Float32Array(count);for(let i=0;i<count;i++)samples[i]=buf.readInt16LE(dataOff+i*2)/32768;return samples}
const samples=readWav(await readFile('D:/DSHwork/dsh-voice-dialog/test/.latency/speech2.wav')); const input=new Float32Array(64000); input.set(samples.subarray(16000,80000))
const ep=kind==='cpu'?{name:'cpu'}:{name:'dml',deviceId:dev}
console.log('creating',JSON.stringify(ep))
const t0=performance.now(); const session=await ort.InferenceSession.create(model,{executionProviders:[ep],graphOptimizationLevel:'all',intraOpNumThreads:kind==='cpu'?dev:1,interOpNumThreads:1}); console.log('loaded',Math.round(performance.now()-t0))
const tensor=new ort.Tensor('float32',input,[1,input.length]); await session.run({mix:tensor}); const times=[]
for(let i=0;i<3;i++){const t=performance.now();await session.run({mix:tensor});times.push(Math.round(performance.now()-t))}
console.log(JSON.stringify({ep:JSON.stringify(ep),times})); await session.release?.()
