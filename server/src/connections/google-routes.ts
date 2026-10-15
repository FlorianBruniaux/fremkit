import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Connection } from '../config/schema.js'
import type { ConfigStore } from '../config/store.js'
import type { SecretStore } from '../secrets/index.js'
import type { ConnectionManager } from './manager.js'
import type { ConnectionTypeRegistry } from './registry.js'
import { isOriginAllowed } from '../ws/routes.js'
import { isAllowedHost, isCrossSiteFetch } from '../http/guard.js'
import { GoogleOAuthBroker, type GoogleOAuthDeps, type GoogleOAuthStatus } from './google-oauth.js'
import { GOOGLE_SCOPES, GoogleClientError, grantedGoogleServices, parseCalendarIds, parseGoogleBinding, parseGoogleServices } from './google-client.js'

export interface GoogleOAuthRouteOptions { store: ConfigStore; types: ConnectionTypeRegistry; manager: ConnectionManager; secrets: SecretStore; oauth?: GoogleOAuthDeps }
interface Binding { fingerprint: string; valid: boolean; configValid: boolean; observed: string; revision: number }
const connectSchema = z.object({ clientSecret: z.string().max(16384).optional() }).strict()
const fingerprint = (c: Connection | undefined) => c ? JSON.stringify([c.type,c.name,Object.keys(c.fields).sort().map(k=>[k,c.fields[k]])]) : ''

/** Register as an encapsulated Fastify plugin beside the existing connection routes. */
export async function googleOAuthRoutes(app: FastifyInstance, opts: GoogleOAuthRouteOptions): Promise<void> {
  const { store, manager, secrets, types } = opts
  const broker = new GoogleOAuthBroker(opts.oauth)
  const bindings = new Map<string, Binding>()
  let ownConfigEvent = false
  let previousConfig = store.get()
  const off = store.onChange(config => {
    const own=ownConfigEvent;ownConfigEvent=false
    const unrelatedChange = JSON.stringify(previousConfig) !== JSON.stringify(config)
    previousConfig = config
    for (const [id,binding] of bindings) {
      const observed=fingerprint(config.connections.find(c=>c.id===id))
      // Every external commit is an authority revision, including an absent-row save.
      // Comparing fingerprints alone cannot distinguish deletion or A-B-A during recovery.
      if (!own && !(observed === '' && binding.observed === '' && unrelatedChange)) {
        binding.revision++
        if (observed!==binding.observed || observed!==binding.fingerprint) {
          binding.valid=false;binding.configValid=false;broker.cancel(id,'replaced')
        }
      }
      binding.observed=observed
    }
  })
  app.addHook('onClose', async()=>{await broker.close();off();bindings.clear()})
  app.addHook('onRequest', async(req,reply)=>{
    if (!isAllowedHost(req.headers.host) || !isOriginAllowed(req.headers.origin) || isCrossSiteFetch(req.headers)) return reply.code(403).send({error:'forbidden'})
  })
  const connection = (id:string) => {
    const c=store.get().connections.find(c=>c.id===id && c.type==='google')
    return types.get('google') && c
  }
  const status = async (id:string):Promise<GoogleOAuthStatus & { requestedScopes?: string[] }> => {
    const c=connection(id)
    if (!c) return {state:'disconnected'}
    const active=broker.status(id)
    if (active.state==='pending' || active.state==='error') return active
    const b=parseGoogleBinding((await secrets.get(id+'/credentials'))??undefined)
    if (!b || b.clientId!==c.fields.clientId) return {state:'disconnected'}
    if ('disconnected' in b) return {state:'disconnected',email:b.email,services:[]}
    const selected=parseGoogleServices(c.fields.services)
    const services=grantedGoogleServices(b,selected)
    return {state: services.length===selected.length?'connected':'partial',email:b.email,services,requestedScopes:selected.flatMap(s=>GOOGLE_SCOPES[s]),...(services.length===selected.length?{}:{error:'partial'})}
  }
  // Both config copies lose the binding before the single atomic secret item is replaced.
  const replace = async(c:Connection, expected:AbortSignal|undefined, value:string, binding:Binding, isAttemptCurrent:()=>boolean = ()=>true) => {
    let quarantined=false
    let quarantineAttempted=false
    const initialRevision=binding.revision
    const current = () => binding.valid && binding.configValid && bindings.get(c.id)===binding && isAttemptCurrent()
      && (quarantined && !connection(c.id) || fingerprint(connection(c.id))===binding.fingerprint)
    const owned = async (fn: (config: ReturnType<ConfigStore['get']>) => ReturnType<ConfigStore['get']>) => {
      try { await store.update(config=>{const result=fn(config);ownConfigEvent=true;return result}) } finally {ownConfigEvent=false}
    }
    const quarantine = async()=>{
      quarantineAttempted=true
      await owned(config=>{
        const found=config.connections.find(x=>x.id===c.id)
        if (!binding.configValid || (quarantined ? found && fingerprint(found)!==binding.fingerprint : fingerprint(found)!==binding.fingerprint)) throw new Error('connection retired')
        return {...config,connections:config.connections.filter(x=>x.id!==c.id)}
      })
      quarantined=true
      await owned(config=>{
        if(config.connections.some(x=>x.id===c.id)) throw new Error('connection retired')
        return config
      })
    }
    const restore = () => owned(config=>{
      if(!binding.configValid || !current() || config.connections.some(x=>x.id===c.id)) throw new Error('connection retired')
      return {...config,connections:[...config.connections,c]}
    })
    let recoveryRow:Connection|undefined
    let recoveryRevision:number|undefined
    const quarantineRollback = async()=>{
      const removeForRecovery = (config: ReturnType<ConfigStore['get']>) => {
        // Cleanup authority is separate from consent. Capture the external row, never the
        // obsolete original, when another writer took ownership during the awaited write.
        if(recoveryRevision===undefined || recoveryRevision!==binding.revision) {
          recoveryRow=binding.configValid?c:config.connections.find(x=>x.id===c.id)
          recoveryRevision=binding.revision
        }
        return {...config,connections:config.connections.filter(x=>x.id!==c.id)}
      }
      // Repeat if a writer interleaves these two saves: both persisted copies must lose
      // the row, and any later external row must be captured rather than discarded.
      let revision:number
      do {
        revision=binding.revision
        await owned(removeForRecovery)
        await owned(removeForRecovery)
      } while(revision!==binding.revision)
    }
    const rollback = () => owned(config=>{
      // A subsequent external write wins, including delete and A-B-A. Never overwrite it.
      const originalStillOwned=quarantineAttempted && binding.configValid && binding.revision===initialRevision
      const row=recoveryRevision===undefined && originalStillOwned ? c : recoveryRevision===binding.revision ? recoveryRow : undefined
      if(!row || config.connections.some(x=>x.id===c.id)) return config
      return {...config,connections:[...config.connections,row]}
    })
    try { await manager.updateSecretsIfCurrent(c,expected,{credentials:value},{quarantine,quarantineRollback,commit:restore,rollback},current) }
    finally { await manager.sync(store.get().connections) }
  }
  app.get<{Params:{id:string}}>('/api/connections/:id/google',async(req,reply)=>{
    const active=broker.status(req.params.id)
    // Quarantine temporarily removes the config row, but consent remains controllable.
    if (bindings.get(req.params.id)?.configValid && (active.state==='pending' || active.state==='error')) return active
    if (!connection(req.params.id)) return reply.code(404).send({error:'unconfigured'})
    try { return await status(req.params.id) } catch { return reply.code(400).send({error:'malformed'}) }
  })
  app.post<{Params:{id:string}}>('/api/connections/:id/google/connect',async(req,reply)=>{
    const id=req.params.id,c=connection(id)
    if(!c) return reply.code(404).send({error:'unconfigured'})
    const parsed=connectSchema.safeParse(req.body??{})
    if(!parsed.success || store.degraded) return reply.code(400).send({error:'malformed'})
    // Do not await credential reads before reserving this binding: a concurrent request may replace it.
    const prior=bindings.get(id);if(prior) prior.valid=false
    broker.cancel(id)
    const binding={fingerprint:fingerprint(c),valid:true,configValid:true,observed:fingerprint(c),revision:0};bindings.set(id,binding)
    try {
      parseGoogleServices(c.fields.services);parseCalendarIds(c.fields.calendarIds)
      const expected=manager.captureGenerationForRepair(id)
      const previous=parseGoogleBinding((await secrets.get(id+'/credentials'))??undefined)
      const current=()=>binding.valid && bindings.get(id)===binding && (expected===undefined || !expected.aborted) && fingerprint(connection(id))===binding.fingerprint
      if(!current()) throw new Error('connection retired')
      return await broker.start(id,c.fields,previous,parsed.data.clientSecret,(b,isAttemptCurrent)=>replace(c,expected,JSON.stringify(b),binding,isAttemptCurrent),current)
    } catch(error) {return reply.code(409).send({error:error instanceof GoogleClientError?error.code:'replaced'})}
  })
  app.post<{Params:{id:string}}>('/api/connections/:id/google/cancel',async(req,reply)=>{
    const binding=bindings.get(req.params.id)
    if(!connection(req.params.id) && !binding?.configValid) return reply.code(404).send({error:'unconfigured'})
    if(binding) binding.valid=false
    broker.cancel(req.params.id);return broker.status(req.params.id)
  })
  app.post<{Params:{id:string}}>('/api/connections/:id/google/disconnect',async(req,reply)=>{
    const id=req.params.id,c=connection(id)
    if(!c) return reply.code(404).send({error:'unconfigured'})
    const previous=bindings.get(id);if(previous) previous.valid=false
    broker.forget(id)
    const binding={fingerprint:fingerprint(c),valid:true,configValid:true,observed:fingerprint(c),revision:0};bindings.set(id,binding)
    try {
      const expected=manager.captureGenerationForRepair(id)
      const old=parseGoogleBinding((await secrets.get(id+'/credentials'))??undefined)
      const value=old?JSON.stringify({version:1,disconnected:true,clientId:old.clientId,subject:old.subject,email:old.email}):''
      await replace(c,expected,value,binding)
      bindings.delete(id)
      return {state:'disconnected',...(old?{email:old.email}:{})}
    }
    catch{return reply.code(409).send({error:'replaced'})}
  })
}
