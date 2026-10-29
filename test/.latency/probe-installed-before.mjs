import { readFile } from 'node:fs/promises'
import { SeparationService } from 'file:///D:/deepseek-harness-dsh-v0.2.1rc2/.dsh-home/profiles/web/local-packages/dsh-voice-dialog-0.8.1/lib/separation.js'
function wav(buf){let off=12,f,d,dl;while(off+8<=buf.length){const id=buf.toString('ascii',off,off+4),n=buf.readUInt32LE(off+4),b=off+8;if(id==='fmt ')f={c:buf.readUInt16LE(b+2),r:buf.readUInt32LE(b+4),bits:buf.readUInt16LE(b+14)};if(id==='data'){d=b;dl=Math.min(n,buf.length-b);break}off=b+n+(n&1)}const s=new Float32Array(Math.floor(dl/2));for(let i=0;i<s.length;i++)s[i]=buf.readInt16LE(d+i*2)/32768;return s}
const all=wav(await readFile('D:/DSHwork/dsh-voice-dialog/test/.latency/speech3.wav'))
const starts=[0,Math.floor((all.length-64000)/2),all.length-64000]
const svc=new SeparationService({dataDir:'C:/Users/chesand/.dsh/voice-dialog',modelPath:'C:/Users/chesand/.dsh/voice-dialog/models/mossformer2_ss_16k.onnx'})
const t0=performance.now(); await svc.warm(); console.log('COLD',Math.round(performance.now()-t0),'BACKEND',svc.status().backend)
await svc.separate(all.slice(starts[0],starts[0]+64000))
for(let i=0;i<3;i++){const t=performance.now();const r=await svc.separate(all.slice(starts[i],starts[i]+64000));console.log('RUN',i+1,'wall',Math.round(performance.now()-t),'infer',r.elapsedMs,'src',r.sources.length)}
await svc.close()
