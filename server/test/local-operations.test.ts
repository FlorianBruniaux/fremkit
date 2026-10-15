import {describe,it,expect} from 'vitest'
import {createDockerProvider,createLocalModelsProvider} from '../src/providers/local-operations.js'
describe('Docker observation',()=>{
 it('joins container state with its own stats by ID, omitting commands and env',async()=>{
  const calls:string[][]=[]
  const p=createDockerProvider({run:async args=>{calls.push(args);if(args[0]==='context')return 'unix:///path/to/docker.sock';if(args.includes('ps'))return JSON.stringify({ID:'abcd',Names:'example',Image:'example:latest',State:'running',Status:'Up',Command:'PRIVATE'});return JSON.stringify({ID:'abcd',CPUPerc:'2.3%',MemUsage:'12MiB / 2GiB',MemPerc:'1%',PIDs:'3',NetIO:'1kB / 2kB',BlockIO:'0B / 0B'})}})
  const s:any=await p.poll!();expect(s.data.containers[0]).toMatchObject({id:'abcd',name:'example',state:'running',stats:{cpu:'2.3%',memory:'12MiB / 2GiB'}});expect(JSON.stringify(s)).not.toContain('PRIVATE');expect(calls.filter(a=>a.includes('ps')||a.includes('stats')).every(a=>a[0]==='--host'&&a[1]==='unix:///path/to/docker.sock')).toBe(true);expect(calls.every(a=>!a.includes('start')&&!a.includes('inspect-env'))).toBe(true)
 })
 it('refuses a remote context before querying its containers',async()=>{
  const calls:string[][]=[];const p=createDockerProvider({run:async args=>{calls.push(args);return 'ssh://example.com'}});expect(await p.poll!()).toMatchObject({data:null,error:'remote-context'});expect(calls).toHaveLength(1)
 })
 it('keeps stopped containers without inventing usage and marks retained data stale',async()=>{
  let offline=false;const p=createDockerProvider({run:async args=>{if(offline)throw Error('PRIVATE');if(args[0]==='context')return 'unix:///example.sock';if(args.includes('ps'))return JSON.stringify({ID:'abcd',Names:'example',Image:'example:latest',State:'exited',Status:'Exited'});throw Error('stats must not run')}})
  const s:any=await p.poll!();expect(s.data.containers[0].stats).toBeNull();offline=true;expect(await p.poll!()).toMatchObject({data:s.data,stale:true,error:'offline'})
 })
})
describe('Local model observation',()=>{
 it('separates installed Ollama models, memory-loaded models and MLX processes',async()=>{
  const urls:string[]=[];const p=createLocalModelsProvider({fetchFn:(async url=>{urls.push(String(url));return new Response(JSON.stringify({models:[{name:'example-model',size:100,size_vram:80,context_length:4096}]}))}) as typeof fetch,processes:async()=>[{pid:12,name:'python',command:'python',params:'-m mlx_lm.server --model example/model --port 8080 --api-key PRIVATE',cpu:3,mem:2,memRss:1024}]})
  const s:any=await p.poll!();expect(s.installed.data[0].name).toBe('example-model');expect(s.loaded.data[0].size_vram).toBe(80);expect(s.mlx.data[0]).toMatchObject({model:'example/model',port:8080,cpu:3});expect(JSON.stringify(s)).not.toContain('PRIVATE');expect(urls).toEqual(['http://127.0.0.1:11434/api/tags','http://127.0.0.1:11434/api/ps'])
 })
 it('keeps MLX independent when Ollama is offline, and labels it as process evidence only',async()=>{
  const p=createLocalModelsProvider({fetchFn:(async()=>{throw Error('PRIVATE')}) as typeof fetch,processes:async()=>[]});const s:any=await p.poll!();expect(s.loaded).toMatchObject({data:null,error:'offline'});expect(s.mlx).toMatchObject({data:[],stale:false});expect(JSON.stringify(s)).not.toContain('PRIVATE')
 })
})
