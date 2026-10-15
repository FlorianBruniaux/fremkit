import {execFile} from 'node:child_process'
import {basename} from 'node:path'
import si from 'systeminformation'
import {z} from 'zod'
import type {Provider} from './types.js'
const localEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const safe: NodeJS.ProcessEnv = {}
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME']) {
    if (env[key] !== undefined) safe[key] = env[key]
  }
  return safe
}
interface Part<T>{data:T|null;stale:boolean;error:string|null;updatedAt:number|null}
const empty=<T>():Part<T>=>({data:null,stale:false,error:null,updatedAt:null})
const fresh=<T>(data:T):Part<T>=>({data,stale:false,error:null,updatedAt:Date.now()})
const failed=<T>(part:Part<T>,error:string):Part<T>=>({...part,stale:true,error})
const text=z.string().max(2048),identifier=z.string().regex(/^[a-f0-9]{4,64}$/i)
const Container=z.object({ID:identifier,Names:text,Image:text,State:text,Status:text})
const Stats=z.object({ID:identifier,CPUPerc:text,MemUsage:text,MemPerc:text,PIDs:text,NetIO:text,BlockIO:text})
const jsonLines=(raw:string)=>{if(Buffer.byteLength(raw)>1048576)throw Error('invalid');const lines=raw.trim()?raw.trim().split(/\r?\n/):[];if(lines.length>200)throw Error('invalid');return lines.map(line=>JSON.parse(line))}
const dockerRun=(args:string[]):Promise<string>=>new Promise((resolve,reject)=>execFile('/usr/local/bin/docker',args,{env:localEnv(process.env),timeout:10000,maxBuffer:1048576,shell:false},(err,stdout)=>err?reject(Error('offline')):resolve(stdout)))
export function createDockerProvider(opts:{run?:(args:string[])=>Promise<string>}={}):Provider{
 const run=opts.run??dockerRun;let last=empty<{containers:unknown[]}>(),generation=0
 return {channel:'docker-local',intervalMs:10000,stop(){generation++},async poll(){const epoch=generation
  try{
   const host=(await run(['context','inspect','--format','{{.Endpoints.docker.Host}}'])).trim()
   if(host.length>4096||!/^unix:\/\/\/[^\0]+$/.test(host)){if(epoch===generation)last=empty();return failed(last,'remote-context')}
   const containers=jsonLines(await run(['--host',host,'ps','-a','--no-trunc','--format','{{json .}}'])).map(row=>Container.parse(row))
   const running=containers.filter(row=>row.State==='running'),stats=running.length?jsonLines(await run(['--host',host,'stats','--no-stream','--no-trunc','--format','{{json .}}',...running.map(row=>row.ID)])).map(row=>Stats.parse(row)):[]
   const data={containers:containers.map(row=>{const s=row.State==='running'?stats.find(s=>s.ID===row.ID):null;return {id:row.ID,name:row.Names,image:row.Image,state:row.State,status:row.Status,stats:s?{cpu:s.CPUPerc,memory:s.MemUsage,memoryPercent:s.MemPerc,pids:s.PIDs,netIO:s.NetIO,blockIO:s.BlockIO}:null}})}
   if(epoch===generation)last=fresh(data)
  }catch(error){if(epoch===generation)last=failed(last,error instanceof z.ZodError||error instanceof SyntaxError?'invalid':'offline')}
  return last
 }}
}
const Model=z.object({name:z.string().max(512),size:z.number().nonnegative(),size_vram:z.number().nonnegative().nullish().transform(v=>v??null),context_length:z.number().int().nonnegative().nullish().transform(v=>v??null),expires_at:z.string().max(100).nullish().transform(v=>v??null)})
interface ModelProcess {pid:number;name:string;command:string;params:string;cpu:number;mem:number;memRss:number}
export function createLocalModelsProvider(opts:{fetchFn?:typeof fetch;processes?:()=>Promise<ModelProcess[]>}={}):Provider{
 const fetchFn=opts.fetchFn??fetch,processes=opts.processes??(async()=>(await si.processes()).list)
 let installed=empty<z.infer<typeof Model>[]>(),loaded=empty<z.infer<typeof Model>[]>(),mlx=empty<unknown[]>(),generation=0
 async function models(path:string,previous:Part<z.infer<typeof Model>[]>):Promise<Part<z.infer<typeof Model>[]>>{
  try{const res=await fetchFn('http://127.0.0.1:11434/api/'+path,{signal:AbortSignal.timeout(3000),redirect:'error'});if(!res.ok){await res.body?.cancel();return failed(previous,'offline')}
   // Bound the body before parsing; a local service need not be the expected daemon.
   const reader=res.body?.getReader();if(!reader)return failed(previous,'invalid');let raw='',bytes=0;const decoder=new TextDecoder()
   try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>1048576)throw Error('invalid');raw+=decoder.decode(chunk.value,{stream:true})}raw+=decoder.decode()}finally{await reader.cancel().catch(()=>{})}
   const data=z.object({models:z.array(Model).max(200)}).parse(JSON.parse(raw));return fresh(data.models)
  }catch(error){return failed(previous,error instanceof z.ZodError||error instanceof SyntaxError?'invalid':'offline')}
 }
 return {channel:'local-models',intervalMs:15000,stop(){generation++},async poll(){const epoch=generation
  const [nextInstalled,nextLoaded,nextMlx]=await Promise.all([models('tags',installed),models('ps',loaded),(async()=>{
   try{const all=await processes();return fresh(all.filter(p=>['mlx_lm.server','omlx','mlx-server'].includes(basename(p.command))||/(?:^|\s)-m\s+mlx_lm\.server(?:\s|$)/.test(p.params)).slice(0,20).map(p=>{
    const model=p.params.match(/(?:^|\s)--model(?:=|\s+)([^\s]{1,512})/),port=p.params.match(/(?:^|\s)--port(?:=|\s+)(\d{1,5})/),number=port?Number(port[1]):null
    return {pid:p.pid,backend:basename(p.command)==='omlx'?'oMLX':'MLX',model:model?model[1]:null,port:number&&number<65536?number:null,cpu:p.cpu,memoryBytes:p.memRss*1024}
   }))}catch{return failed(mlx,'offline')}
  })()])
  if(epoch===generation){installed=nextInstalled;loaded=nextLoaded;mlx=nextMlx}
  return {installed,loaded,mlx}
 }}
}
