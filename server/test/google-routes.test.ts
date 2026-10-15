import { afterEach, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore } from '../src/config/store.js'
import { ConnectionManager } from '../src/connections/manager.js'
import { ConnectionTypeRegistry } from '../src/connections/registry.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import { createGoogleType } from '../src/connections/types/google.js'
import { googleOAuthRoutes } from '../src/connections/google-routes.js'
import { GOOGLE_SCOPES } from '../src/connections/google-client.js'
const cleanup: Array<()=>Promise<unknown>> = []
afterEach(async()=>{for(const f of cleanup.splice(0).reverse()) await f()})
async function setup(timeoutMs = 5000) {
  const dir=await mkdtemp(join(tmpdir(),'google-routes-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}))
  const store = new ConfigStore(join(dir,'config.json')); await store.load()
  const connection={id:'account-a',type:'google',name:'A',fields:{clientId:'test.apps.googleusercontent.com',services:'["gmail"]'}}
  await store.update(c=>({...c,connections:[connection]}))
  const values=new Map<string,string>()
  const secrets={get:async(k:string)=>values.get(k)??null,set:async(k:string,v:string)=>{values.set(k,v)},delete:async(k:string)=>{values.delete(k)}}
  const activated: Array<string | undefined>=[]
  const types=new ConnectionTypeRegistry([createGoogleType([{id:'gmail',channelPrefix:'gmail',createProvider:ctx=>{activated.push(ctx.secrets.credentials);return {channel:ctx.channel}}}])])
  const registry=new ProviderRegistry(()=>{});const manager=new ConnectionManager({registry,types,secrets});await manager.sync(store.get().connections)
  let subject='account-a'
  let auth='';const app:FastifyInstance=Fastify({logger:false});cleanup.push(()=>app.close())
  await app.register(googleOAuthRoutes,{store,types,manager,secrets,oauth:{timeoutMs,openBrowser:async u=>{auth=u},fetch:async u=>String(u).endsWith('/token')?Response.json({access_token:'fake-access',refresh_token:'fake-refresh',expires_in:3600,token_type:'Bearer',scope:GOOGLE_SCOPES.gmail.join(' ')}):Response.json({sub:subject,email:'a@example.com',email_verified:true})}})
  return {app,store,values,manager,secrets,connection,activated,types,dir,setSubject:(value:string)=>{subject=value},callback:()=>{const u=new URL(auth);const cb=new URL(u.searchParams.get('redirect_uri')!);cb.searchParams.set('state',u.searchParams.get('state')!);cb.searchParams.set('code','fake');return cb.href}}
}
const url='/api/connections/account-a/google'
it('connects, exposes only identity/grants, persists secret only and locally disconnects',async()=>{
  const s=await setup()
  expect((await s.app.inject({method:'POST',url:url+'/connect',payload:{clientSecret:'fake-client-secret'}})).statusCode).toBe(200)
  await fetch(s.callback())
  await expect.poll(async()=> (await s.app.inject({method:'GET',url})).json().state).toBe('connected')
  const status=await s.app.inject({method:'GET',url})
  expect(status.json()).toMatchObject({state:'connected',email:'a@example.com',services:['gmail']})
  expect(status.body).not.toMatch(/fake-access|fake-refresh|fake-client-secret/)
  expect(JSON.stringify(s.store.get())).not.toMatch(/fake-access|fake-refresh|fake-client-secret/)
  expect((await s.app.inject({method:'POST',url:url+'/disconnect',payload:{}})).statusCode).toBe(200)
  expect(JSON.parse(s.values.get('account-a/credentials')!)).toEqual({version:1,disconnected:true,clientId:s.connection.fields.clientId,subject:'account-a',email:'a@example.com'});expect(s.store.get().connections).toHaveLength(1)
})
it('rejects cross-site control requests',async()=>{
  const s=await setup()
  expect((await s.app.inject({method:'POST',url:url+'/connect',headers:{origin:'https://evil.example'},payload:{}})).statusCode).toBe(403)
  expect((await s.app.inject({method:'GET',url,headers:{'sec-fetch-site':'cross-site'}})).statusCode).toBe(403)
})
it('invalidates A-B-A config edits before callback',async()=>{
  const s=await setup();await s.app.inject({method:'POST',url:url+'/connect',payload:{}});const callback=s.callback()
  await s.store.update(c=>({...c,connections:[{...s.connection,fields:{...s.connection.fields,services:'["calendar"]'}}]}))
  await s.store.update(c=>({...c,connections:[s.connection]}))
  await expect(fetch(callback)).rejects.toThrow()
  expect((await s.app.inject({method:'GET',url})).json().error).toBe('replaced');expect(s.values.size).toBe(0)
})

it('keeps pending status available during the durable credential quarantine',async()=>{
  const s=await setup()
  let release!:()=>void
  let started!:()=>void
  const gate=new Promise<void>(r=>{release=r})
  const entered=new Promise<void>(r=>{started=r})
  s.secrets.set=async(k,v)=>{started();await gate;s.values.set(k,v)}
  await s.app.inject({method:'POST',url:url+'/connect',payload:{}})
  await fetch(s.callback());await entered
  const status=await s.app.inject({method:'GET',url})
  release()
  await expect.poll(async()=> (await s.app.inject({method:'GET',url})).json().state).toBe('connected')
  expect(status.statusCode).toBe(200)
  expect(status.json().state).toBe('pending')
})

it('retains account binding after local disconnect, rejects another subject, deletes fully on removal',async()=>{
  const s=await setup()
  await s.app.inject({method:'POST',url:url+'/connect',payload:{}});await fetch(s.callback())
  await expect.poll(async()=> (await s.app.inject({method:'GET',url})).json().state).toBe('connected')
  await s.app.inject({method:'POST',url:url+'/disconnect',payload:{}})
  const disconnected=await s.app.inject({method:'GET',url});expect(disconnected.json()).toMatchObject({state:'disconnected',email:'a@example.com'})
  s.setSubject('other-account')
  await s.app.inject({method:'POST',url:url+'/connect',payload:{}});await fetch(s.callback())
  await expect.poll(async()=> (await s.app.inject({method:'GET',url})).json().error).toBe('accountMismatch')
  expect(s.values.get('account-a/credentials')).not.toContain('fake-access')
  await s.manager.removeConnection(async()=>{await s.store.update(c=>({...c,connections:[]}));return s.connection},()=>s.store.get().connections)
  expect(s.values.size).toBe(0);expect(s.store.get().connections).toEqual([])
})

function deferred() {
  let resolve!:()=>void
  const promise=new Promise<void>(r=>{resolve=r})
  return {promise,resolve}
}

it.each(['replacement','timeout','cancel','success'] as const)('guards a queued callback against %s',async(kind)=>{
  const s=await setup(kind==='timeout'?150:5000)
  const other={...s.connection,id:'account-b',name:'B'}
  await s.store.update(c=>({...c,connections:[s.connection,other]}));await s.manager.sync(s.store.get().connections)
  const blockerEntered=deferred(),release=deferred(),queued=deferred()
  const get=s.secrets.get
  let block=true
  s.secrets.get=async key=>{if(key==='account-b/credentials' && block){block=false;blockerEntered.resolve();await release.promise}return get(key)}
  const guarded=s.manager.updateSecretsIfCurrent.bind(s.manager)
  s.manager.updateSecretsIfCurrent=(...args)=>{queued.resolve();return guarded(...args)}
  await s.app.inject({method:'POST',url:url+'/connect',payload:{}})
  const blocker=s.manager.updateSecrets(other,{credentials:'synthetic-blocker'})
  try {
    await blockerEntered.promise;await fetch(s.callback());await queued.promise
    if(kind==='replacement') expect((await s.app.inject({method:'POST',url:url+'/connect',payload:{}})).json().state).toBe('pending')
    if(kind==='cancel') expect((await s.app.inject({method:'POST',url:url+'/cancel',payload:{}})).json().error).toBe('cancelled')
    if(kind==='timeout') await expect.poll(async()=> (await s.app.inject({method:'GET',url})).json().error).toBe('timeout')
  } finally {release.resolve();await blocker}
  // close waits for the real broker exchange, including queued commit and final manager sync.
  if(kind==='success') await expect.poll(async()=> (await s.app.inject({method:'GET',url})).json().state).toBe('connected')
  await s.app.close()
  expect(s.values.has('account-a/credentials')).toBe(kind==='success')
  expect(s.activated.some(value=>value?.includes('fake-access'))).toBe(kind==='success')
  expect(s.store.get().connections.map(c=>c.id).sort()).toEqual(['account-a','account-b'])
  expect(s.manager.captureGeneration('account-a').aborted).toBe(false)
})

it.each([['quarantine','timeout'],['secret write','timeout'],['commit','timeout'],['quarantine','cancel'],['secret write','cancel'],['commit','cancel']] as const)('rolls back during awaited %s on %s',async(stage,reason)=>{
  const s=await setup(reason==='timeout'?150:5000),entered=deferred(),release=deferred()
  const original=JSON.stringify({version:1,disconnected:true,clientId:s.connection.fields.clientId,subject:'account-a',email:'a@example.com'})
  s.values.set('account-a/credentials',original);await s.manager.sync(s.store.get().connections)
  let blocked=false
  if(stage!=='secret write') {
    const update=s.store.update.bind(s.store)
    s.store.update=async fn=>{const result=await update(fn);if(!blocked && (stage==='quarantine' ? !result.connections.length : result.connections.length>0)){blocked=true;entered.resolve();await release.promise}return result}
  } else {
    const set=s.secrets.set
    s.secrets.set=async(k,v)=>{if(!blocked){blocked=true;entered.resolve();await release.promise}await set(k,v)}
  }
  await s.app.inject({method:'POST',url:url+'/connect',payload:{}});await fetch(s.callback());await entered.promise
  try {
    if(reason==='cancel') expect((await s.app.inject({method:'POST',url:url+'/cancel',payload:{}})).json().error).toBe('cancelled')
    else await expect.poll(async()=> (await s.app.inject({method:'GET',url})).json().error).toBe('timeout')
  } finally {release.resolve()}
  await s.app.close()
  expect(s.values.get('account-a/credentials')).toBe(original)
  expect(s.activated.some(value=>value?.includes('fake-access'))).toBe(false)
  expect(s.store.get().connections).toEqual([s.connection])
  expect(s.manager.captureGeneration('account-a').aborted).toBe(false)
})

it.each(['deletion','replacement'] as const)('does not resurrect the quarantined config after external %s',async(change)=>{
  const s=await setup(),entered=deferred(),release=deferred()
  const update=s.store.update.bind(s.store)
  let blocked=false
  s.store.update=async fn=>{const result=await update(fn);if(!blocked && !result.connections.length){blocked=true;entered.resolve();await release.promise}return result}
  await s.app.inject({method:'POST',url:url+'/connect',payload:{}});await fetch(s.callback());await entered.promise
  const replacement={...s.connection,name:'Externally replaced'}
  try {await s.store.update(c=>({...c,connections:change==='deletion'?[]:[replacement]}))} finally {release.resolve()}
  await s.app.close()
  expect(s.store.get().connections).toEqual(change==='deletion'?[]:[replacement])
  expect(s.values.has('account-a/credentials')).toBe(false)
  expect(s.activated.some(value=>value?.includes('fake-access'))).toBe(false)
})


it.each([['replacement',false],['deletion',false],['replacement',true],['deletion',true]] as const)('retires rejected credentials across restart after external %s during write (rollback fails: %s)',async(change,rollbackFails)=>{
  const s=await setup(),entered=deferred(),release=deferred()
  const set=s.secrets.set,remove=s.secrets.delete
  s.secrets.set=async(k,v)=>{entered.resolve();await release.promise;await set(k,v)}
  s.secrets.delete=async k=>{if(rollbackFails) throw new Error('synthetic rollback failure');await remove(k)}
  await s.app.inject({method:'POST',url:url+'/connect',payload:{}});await fetch(s.callback());await entered.promise
  const replacement={...s.connection,name:'External edit retained'}
  try {await s.store.update(c=>({...c,connections:change==='replacement'?[replacement]:[]}))} finally {release.resolve()}
  await s.app.close()
  const expected=change==='replacement' && !rollbackFails?[replacement]:[]
  const freshStore=new ConfigStore(join(s.dir,'config.json'));await freshStore.load()
  expect(freshStore.get().connections).toEqual(expected)
  if(!rollbackFails) expect(s.values.has('account-a/credentials')).toBe(false)
  else {
    const backup=new ConfigStore(join(s.dir,'config.json.bak'));await backup.load()
    expect(backup.get().connections).toEqual([])
  }
  const fresh=new ConnectionManager({registry:new ProviderRegistry(()=>{}),types:s.types,secrets:s.secrets})
  await fresh.sync(freshStore.get().connections)
  expect(s.activated.some(value=>value?.includes('fake-access'))).toBe(false)
})


it.each(['deletion','replacement','ABA'] as const)('preserves a further external %s while rollback is awaiting the secret store',async(change)=>{
  const s=await setup(),entered=deferred(),release=deferred(),cleanupEntered=deferred(),cleanupRelease=deferred()
  const set=s.secrets.set,remove=s.secrets.delete
  s.secrets.set=async(k,v)=>{entered.resolve();await release.promise;await set(k,v)}
  s.secrets.delete=async k=>{cleanupEntered.resolve();await cleanupRelease.promise;await remove(k)}
  await s.app.inject({method:'POST',url:url+'/connect',payload:{}});await fetch(s.callback());await entered.promise
  const first={...s.connection,name:'First external edit'},latest={...s.connection,name:'Latest external edit'}
  await s.store.update(c=>({...c,connections:[first]}));release.resolve();await cleanupEntered.promise
  const disk=new ConfigStore(join(s.dir,'config.json'));await disk.load()
  const backup=new ConfigStore(join(s.dir,'config.json.bak'));await backup.load()
  let expected=change==='replacement'?[latest]:[]
  try {
    expect(disk.get().connections).toEqual([]);expect(backup.get().connections).toEqual([])
    if(change==='ABA') {await s.store.update(c=>({...c,connections:[first]}));expected=[]}
    await s.store.update(c=>({...c,connections:expected}))
  } finally {cleanupRelease.resolve()}
  await s.app.close()
  const freshStore=new ConfigStore(join(s.dir,'config.json'));await freshStore.load()
  expect(freshStore.get().connections).toEqual(expected)
  expect(s.values.has('account-a/credentials')).toBe(false)
  const fresh=new ConnectionManager({registry:new ProviderRegistry(()=>{}),types:s.types,secrets:s.secrets})
  await fresh.sync(freshStore.get().connections)
  expect(s.activated.some(value=>value?.includes('fake-access'))).toBe(false)
})
