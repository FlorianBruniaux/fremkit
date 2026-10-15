import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { GoogleOAuthBroker } from '../src/connections/google-oauth.js'
import { GOOGLE_SCOPES, type GoogleCredentials } from '../src/connections/google-client.js'
const brokers: GoogleOAuthBroker[] = []
afterEach(async () => { for (const b of brokers.splice(0)) await b.close() })
const fields = { clientId: 'test.apps.googleusercontent.com', services: '["gmail","calendar"]' }
function setup(options: { timeoutMs?: number; scope?: string; error?: string; subject?: string; gate?: Promise<void> } = {}) {
  let url = ''
  let verifier = ''
  let committed: GoogleCredentials | undefined
  let current = true
  const broker = new GoogleOAuthBroker({ timeoutMs: options.timeoutMs ?? 2000, openBrowser: async u => { url = u }, fetch: async (u, init) => {
    if (String(u).endsWith('/token')) {
      verifier = new URLSearchParams(String(init?.body)).get('code_verifier') ?? ''
      await options.gate
      if (options.error) return Response.json({ error: options.error, error_description: 'private-value' }, { status: 400 })
      return Response.json({ access_token: 'fake-access', refresh_token: 'fake-refresh', token_type: 'Bearer', expires_in: 3600, scope: options.scope ?? ['openid','email', ...GOOGLE_SCOPES.gmail, ...GOOGLE_SCOPES.calendar].join(' ') })
    }
    expect(String(u)).toBe('https://openidconnect.googleapis.com/v1/userinfo')
    expect((init?.headers as Record<string,string>).Authorization).toBe('Bearer fake-access')
    return Response.json({ sub: options.subject ?? 'account-a', email: 'a@example.com', email_verified: true })
  } })
  brokers.push(broker)
  const start = (previous: GoogleCredentials | null = null) => broker.start('a', fields, previous, 'fake-client-secret', async b => { if (!current) throw new Error('retired'); committed = b }, () => current)
  const callback = (params: Record<string,string>) => { const auth = new URL(url); const callback = new URL(auth.searchParams.get('redirect_uri')!); for (const [k,v] of Object.entries(params)) callback.searchParams.set(k,v); return callback.href }
  return { broker, start, callback, auth: () => new URL(url), committed: () => committed, verifier: () => verifier, retire: () => { current = false; broker.cancel('a', 'replaced') } }
}
async function settled(broker: GoogleOAuthBroker) {
  for (let i=0; i<100; i++) { const status = broker.status('a'); if (status.state !== 'pending') return status; await new Promise(r => setTimeout(r, 5)) }
  throw new Error('did not settle')
}
describe('desktop Google OAuth', () => {
  it('exchanges once with PKCE, verified identity, selected minimal scopes and a secret-free callback', async () => {
    const s = setup(); await s.start()
    expect(s.auth().searchParams.get('code_challenge_method')).toBe('S256')
    expect(s.auth().searchParams.get('scope')?.split(' ')).toEqual(['openid','email',...GOOGLE_SCOPES.gmail, ...GOOGLE_SCOPES.calendar])
    const callback = s.callback({ code: 'fake-code', state: s.auth().searchParams.get('state')! })
    const response = await fetch(callback)
    expect(await response.text()).not.toMatch(/fake-code|fake-access|script|img/)
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect((await settled(s.broker)).state).toBe('connected')
    expect(s.committed()?.subject).toBe('account-a')
    expect(createHash('sha256').update(s.verifier()).digest('base64url')).toBe(s.auth().searchParams.get('code_challenge'))
    await expect(fetch(callback)).rejects.toThrow()
  })
  it.each<Record<string,string>>([{state:'wrong'}, {}])('rejects absent/wrong state without exchange (%j)', async params => {
    const s = setup(); await s.start()
    const response = await fetch(s.callback({ code:'fake-code',...params }))
    expect(response.status).toBe(400)
    expect((await settled(s.broker)).error).toBe('invalidState')
    expect(s.committed()).toBeUndefined()
  })
  it.each(['access_denied', 'admin_policy_enforced'])('reports %s without raw remote text', async error => {
    const s = setup(); await s.start()
    await fetch(s.callback({ state:s.auth().searchParams.get('state')!, error }))
    expect((await settled(s.broker)).error).toBe(error === 'access_denied' ? 'refused' : 'workspacePolicy')
    expect(s.committed()).toBeUndefined()
  })
  it('reports PKCE exchange failure without provider text', async () => {
    const s = setup({ error:'invalid_grant' }); await s.start()
    await fetch(s.callback({ code:'bad', state:s.auth().searchParams.get('state')! }))
    expect((await settled(s.broker)).error).toBe('unauthorized')
    expect(JSON.stringify(s.broker.status('a'))).not.toContain('private-value')
  })
  it('preserves actual partial grants without claiming complete authorization', async () => {
    const s = setup({ scope: ['openid','email',...GOOGLE_SCOPES.gmail].join(' ') }); await s.start()
    await fetch(s.callback({ code:'fake', state:s.auth().searchParams.get('state')! }))
    expect((await settled(s.broker))).toMatchObject({ state:'partial', services:['gmail'], error:'partial' })
    expect(s.committed()?.scopes).not.toContain(GOOGLE_SCOPES.calendar[0])
  })
  it('rejects a different subject on reconnect', async () => {
    const s = setup({subject:'other-account'})
    await s.start({ version:1, clientId:fields.clientId, accessToken:'old',refreshToken:'old', expiresAt:0, subject:'account-a',email:'a@example.com', scopes:[] })
    await fetch(s.callback({ code:'fake', state:s.auth().searchParams.get('state')! }))
    expect((await settled(s.broker)).error).toBe('accountMismatch')
    expect(s.committed()).toBeUndefined()
  })
  it('closes on timeout and explicit cancellation', async () => {
    const s = setup({timeoutMs:30}); await s.start(); const u=s.callback({})
    expect((await settled(s.broker)).error).toBe('timeout')
    await expect(fetch(u)).rejects.toThrow()
    await s.start(); const v=s.callback({}); s.broker.cancel('a')
    expect(s.broker.status('a').error).toBe('cancelled'); await expect(fetch(v)).rejects.toThrow()
  })
  it('rejects late completion after deletion/replacement even if network ignores abort', async () => {
    let release!:()=>void
    const s = setup({gate:new Promise<void>(r => {release=r})}); await s.start()
    await fetch(s.callback({code:'fake',state:s.auth().searchParams.get('state')!}))
    s.retire(); release(); await new Promise(r => setTimeout(r,15))
    expect(s.committed()).toBeUndefined(); expect(s.broker.status('a').error).toBe('replaced')
  })
})

it('refuses wrong callback host and path without consuming the valid attempt',async()=>{
  const s=setup();await s.start()
  const callback=s.callback({code:'fake',state:s.auth().searchParams.get('state')!})
  const wrongPath=new URL(callback);wrongPath.pathname='/other'
  expect((await fetch(wrongPath)).status).toBe(400)
  const hostStatus=await new Promise<number>((resolve,reject)=>{const request=httpRequest(callback,{headers:{Host:'evil.example'}},response=>{response.resume();resolve(response.statusCode!)});request.on('error',reject);request.end()})
  expect(hostStatus).toBe(400)
  expect(s.broker.status('a').state).toBe('pending')
  await fetch(callback);expect((await settled(s.broker)).state).toBe('connected')
})

it('awaits an already-started credential commit when closing the server',async()=>{
  let auth='';let release!:()=>void;let entered!:()=>void
  const committing=new Promise<void>(r=>{entered=r});const gate=new Promise<void>(r=>{release=r})
  const broker=new GoogleOAuthBroker({openBrowser:async u=>{auth=u},fetch:async u=>String(u).endsWith('/token')?Response.json({access_token:'fake',refresh_token:'fake',token_type:'Bearer',expires_in:3600,scope:GOOGLE_SCOPES.gmail.join(' ')}):Response.json({sub:'a',email:'a@example.com',email_verified:true})})
  await broker.start('a',{...fields,services:'["gmail"]'},null,undefined,async()=>{entered();await gate},()=>true)
  const u=new URL(auth);const callback=new URL(u.searchParams.get('redirect_uri')!);callback.searchParams.set('state',u.searchParams.get('state')!);callback.searchParams.set('code','fake')
  await fetch(callback);await committing
  let closed=false
  const close=Promise.resolve(broker.close()).then(()=>{closed=true})
  await new Promise(r=>setTimeout(r,5));const premature=closed
  release();await close
  expect(premature).toBe(false);expect(closed).toBe(true)
})

it('does not reopen or rearm a listener cancelled while binding',async()=>{
  const s=setup({timeoutMs:20})
  const pending=s.start();s.broker.cancel('a');await pending
  expect(s.broker.status('a').error).toBe('cancelled')
  await new Promise(r=>setTimeout(r,30))
  expect(s.broker.status('a').error).toBe('cancelled')
})

it('requests only the Tasks scope for a Tasks-only connection', async () => {
  let authorizationUrl = ''
  const broker = new GoogleOAuthBroker({openBrowser: async url => {authorizationUrl = url}})
  brokers.push(broker)
  const result = await broker.start('tasks-account', {clientId: fields.clientId, services: '["tasks"]'}, null, undefined, async () => {}, () => true)
  expect(result.state).toBe('pending')
  expect(new URL(authorizationUrl).searchParams.get('scope')?.split(' ')).toEqual(['openid', 'email', ...GOOGLE_SCOPES.tasks])
})
