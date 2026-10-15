import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { z } from 'zod'
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { isIP } from 'node:net'
interface WebSocket {readyState:number;send(data:string):void;close(code?:number):void}
import type { Provider, CommandContext } from '../providers/types.js'

const ExtensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/
const Id = z.string().uuid(), Instance = z.string().min(1).max(120)
export function youtubeUrl(value: string): boolean {
  try { const u = new URL(value); return u.protocol === 'https:' && ['www.youtube.com','youtube.com','m.youtube.com'].includes(u.hostname) && !u.port && !u.username && !u.password && (u.pathname === '/watch' ? /^[\w-]{11}$/.test(u.searchParams.get('v') ?? '') : /^\/shorts\/[\w-]{11}$/.test(u.pathname)) } catch { return false }
}
const Meta = z.object({title:z.string().max(300),url:z.string().max(500).refine(youtubeUrl),currentTime:z.number().finite().min(0).max(604800),duration:z.number().finite().min(0).max(604800),paused:z.boolean(),muted:z.boolean(),volume:z.number().min(0).max(1),crop:z.object({x:z.number().min(0).max(1),y:z.number().min(0).max(1),w:z.number().min(0).max(1),h:z.number().min(0).max(1)}).nullable()})
export function localSdp(value: string): boolean {
  if (!value.startsWith('v=0') || value.length > 32000) return false
  for (const line of value.split(/\r?\n/)) {
    if (!line.startsWith('a=candidate:')) continue
    const p=line.split(/\s+/),host=p[4],kind=p[7]
    if (kind!=='host' || !host) return false
    if (/^[a-z0-9-]+\.local$/i.test(host)) continue
    if (isIP(host)===4 && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.)/.test(host)) continue
    if (isIP(host)===6 && (host==='::1'||/^(fe80:|f[cd][0-9a-f]{2}:)/i.test(host))) continue
    return false
  }
  return true
}
const Sdp=z.string().min(5).max(32000).refine(localSdp)
const Control=z.object({sessionId:Id,action:z.enum(['toggle','seek','volume','mute','show','stop']),delta:z.union([z.literal(-10),z.literal(10)]).optional(),value:z.number().min(0).max(1).optional(),instanceId:Instance}).refine(v=>v.action!=='seek'||v.delta!==undefined).refine(v=>v.action!=='volume'||v.value!==undefined)
type MetaData=z.infer<typeof Meta>
interface Receiver {id:string;instanceId:string;offer:string|null;seen:number}
interface Pair {origin:string;token:string}
const equal=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b))

/** Isolated extension listener: no dashboard configuration or credential API. */
export async function createYouTubeBridge(options:{dataDir:string;port:number;now?:()=>number}) {
 const now=options.now??Date.now,app=Fastify({logger:false,bodyLimit:4096}),file=join(options.dataDir,'youtube-pairing.json')
 let pair:Pair|null=null,code:{value:string;expires:number;attempts:number}|null=null,sender:WebSocket|null=null,sessionId:string|null=null,meta:MetaData|null=null,updatedAt:number|null=null
 const receivers=new Map<string,Receiver>()
 try { const saved=JSON.parse(await readFile(file,'utf8')); if(ExtensionOrigin.test(saved.origin)&&typeof saved.token==='string'&&/^[a-f0-9]{64}$/.test(saved.token))pair=saved } catch { /* No pairing yet. */ }
 function send(value:unknown){if(sender?.readyState===1)sender.send(JSON.stringify(value))}
 function clear(){sessionId=null;meta=null;updatedAt=null;receivers.clear()}
 function connected(){return !!sender&&sender.readyState===1}
 function expire(){if(sessionId&&!connected())clear();if(updatedAt!==null&&now()-updatedAt>10000){send({type:'stop'});clear()}for(const [id,r]of receivers)if(now()-r.seen>30000){receivers.delete(id);send({type:'detach',receiverId:id})}}
 function snapshot(){expire();return {version:1,connected:connected(),state:sessionId?'sharing':'idle',sessionId,meta,updatedAt,receivers:[...receivers.values()].map(r=>({id:r.id,offer:r.offer}))}}
 const local=(ctx?:CommandContext)=>{if(!ctx?.loopback)throw new Error('Local dashboard required')}
 const provider:Provider={channel:'youtube',intervalMs:1000,poll:async()=>snapshot(),commands:{
  pair:async(payload,ctx)=>{local(ctx);z.object({instanceId:Instance}).parse(payload);code={value:String(randomInt(100000,1000000)),expires:now()+90000,attempts:0};return {ok:true,code:code.value,expiresAt:code.expires}},
  view:async(payload,ctx)=>{local(ctx);const p=z.object({sessionId:Id,receiverId:Id,instanceId:Instance}).parse(payload);expire();if(!sessionId||p.sessionId!==sessionId||!connected())return {ok:false};const r=receivers.get(p.receiverId);if(r&&r.instanceId!==p.instanceId)return {ok:false};if(!r){if(receivers.size>=4)return {ok:false};receivers.set(p.receiverId,{id:p.receiverId,instanceId:p.instanceId,offer:null,seen:now()});send({type:'view',receiverId:p.receiverId,sessionId})}else r.seen=now();return {ok:true}},
  answer:async(payload,ctx)=>{local(ctx);const p=z.object({sessionId:Id,receiverId:Id,sdp:Sdp,instanceId:Instance}).parse(payload),r=receivers.get(p.receiverId);if(p.sessionId!==sessionId||!r||r.instanceId!==p.instanceId)return {ok:false};r.seen=now();send({type:'answer',receiverId:p.receiverId,sessionId,sdp:p.sdp});return {ok:true}},
  control:async(payload,ctx)=>{local(ctx);const p=Control.parse(payload);expire();if(p.sessionId!==sessionId||!connected())return {ok:false};send({type:'control',sessionId,action:p.action,...(p.delta===undefined?{}:{delta:p.delta}),...(p.value===undefined?{}:{value:p.value})});if(p.action==='stop')clear();return {ok:true}}
 }}
 app.addHook('onRequest',async(req,reply)=>{
  if(req.headers.host!==`127.0.0.1:${options.port}`||!ExtensionOrigin.test(req.headers.origin??''))return reply.code(403).send({error:'Forbidden'})
  reply.header('access-control-allow-origin',req.headers.origin!).header('vary','Origin')
 })
 app.options('/pair',async(_req,reply)=>reply.header('access-control-allow-methods','POST').header('access-control-allow-headers','content-type').code(204).send())
 app.post('/pair',async(req,reply)=>{
  const p=z.object({code:z.string().regex(/^\d{6}$/)}).strict().safeParse(req.body)
  if(!code||now()>code.expires||code.attempts>=8||!p.success)return reply.code(403).send({error:'Pairing refused'})
  code.attempts++;if(!equal(p.data.code,code.value))return reply.code(403).send({error:'Pairing refused'})
  const next={origin:req.headers.origin!,token:randomBytes(32).toString('hex')};await mkdir(options.dataDir,{recursive:true});const tmp=file+'.'+randomBytes(8).toString('hex')+'.tmp';await writeFile(tmp,JSON.stringify(next),{mode:0o600,flag:'wx'});await rename(tmp,file)
  code=null;pair=next;sender?.close(1000);sender=null;clear();return {token:next.token,version:1}
 })
 await app.register(websocket,{options:{maxPayload:64*1024}})
 app.get('/bridge',{websocket:true},(socket,req)=>{
  const origin=req.headers.origin;let authenticated=false
  const deadline=setTimeout(()=>{if(!authenticated)socket.close(1008)},5000);deadline.unref()
  socket.on('message',raw=>{
   try{
    const data=JSON.parse(raw.toString())
    if(!authenticated){
     const hello=z.object({type:z.literal('hello'),token:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(data)
     if(!pair||!equal(hello.token,pair.token)||origin!==pair.origin){socket.close(1008);return}
     authenticated=true;clearTimeout(deadline);sender?.close(1000);sender=socket;clear();socket.send(JSON.stringify({type:'ready',version:1}));return
    }
    if(socket!==sender){socket.close(1008);return}
    if(data.type==='started'){const p=z.object({type:z.literal('started'),sessionId:Id,meta:Meta}).strict().parse(data);clear();sessionId=p.sessionId;meta=p.meta;updatedAt=now()}
    else if(data.type==='metadata'){const p=z.object({type:z.literal('metadata'),sessionId:Id,meta:Meta}).strict().parse(data);if(p.sessionId!==sessionId)throw Error('Session mismatch');meta=p.meta;updatedAt=now()}
    else if(data.type==='offer'){const p=z.object({type:z.literal('offer'),sessionId:Id,receiverId:Id,sdp:Sdp}).strict().parse(data),r=receivers.get(p.receiverId);if(p.sessionId!==sessionId||!r)throw Error('Receiver missing');r.offer=p.sdp}
    else if(data.type==='stopped'){z.object({type:z.literal('stopped')}).strict().parse(data);clear()}
    else throw Error('Unknown message')
   }catch{if(sender===socket){sender=null;clear()}socket.close(1008)}
  })
  socket.on('close',()=>{clearTimeout(deadline);if(sender===socket){sender=null;clear()}})
 })
 app.addHook('onClose',async()=>{sender?.close(1000);sender=null;clear()})
 return {app,provider,port:options.port}
}
