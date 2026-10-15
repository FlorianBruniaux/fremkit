import { describe, expect, it } from 'vitest'
import { ConnectionManager } from '../src/connections/manager.js'
import { ConnectionTypeRegistry } from '../src/connections/registry.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import type { ConnectionServiceContext } from '../src/connections/types.js'
import { createGoogleClient, GOOGLE_SCOPES, parseCalendarIds, parseGoogleCredentials, parseGoogleServices } from '../src/connections/google-client.js'
import { createGoogleType } from '../src/connections/types/google.js'

const clientId = 'test.apps.googleusercontent.com'
const bundle = (extra = {}) => ({ version: 1, clientId, accessToken: 'fake-access', refreshToken: 'fake-refresh', subject: 'subject-a', email: 'a@example.com', expiresAt: Date.now() + 3600000, scopes: Object.values(GOOGLE_SCOPES).flat(), ...extra })
async function setup(extra = {}) {
  const values = new Map([['a/credentials', JSON.stringify(bundle(extra))], ['b/credentials', JSON.stringify(bundle({ subject: 'subject-b', email: 'b@example.com' }))]])
  const contexts: ConnectionServiceContext[] = []
  const type = createGoogleType(['gmail', 'calendar'].map(id => ({ id, channelPrefix: id, createProvider: ctx => { contexts.push(ctx); return { channel: ctx.channel } } })))
  const registry = new ProviderRegistry(() => {})
  const manager = new ConnectionManager({ registry, types: new ConnectionTypeRegistry([type]), secrets: { get: async k => values.get(k) ?? null, set: async (k,v) => { values.set(k,v) }, delete: async k => { values.delete(k) } } })
  const connections = ['a','b'].map(id => ({ id, type: 'google', name: id, fields: { clientId, services: '["gmail","calendar"]' } }))
  await manager.sync(connections)
  const restart = async () => {
    await manager.sync([])
    const fresh = new ConnectionManager({ registry: new ProviderRegistry(() => {}), types: new ConnectionTypeRegistry([type]), secrets: {
      get: async k => values.get(k) ?? null,
      set: async (k,v) => { values.set(k,v) },
      delete: async k => { values.delete(k) },
    } })
    await fresh.sync(connections)
    return fresh
  }
  return { contexts, values, manager, connections, restart }
}

describe('Google parsers and request boundary', () => {
  it('rejects malformed services, calendars and bundles without retaining raw errors', () => {
    expect(parseGoogleCredentials('not json')).toBeNull()
    expect(parseGoogleCredentials(JSON.stringify(bundle({ expiresAt: 'tomorrow' })))).toBeNull()
    expect(parseGoogleServices('["gmail"]')).toEqual(['gmail'])
    expect(parseCalendarIds(undefined)).toEqual([])
    for (const input of ['{}', '["gmail","gmail"]', '["drive"]', '[]']) expect(() => parseGoogleServices(input)).toThrow('malformed')
    for (const input of ['{}', '[""]', '["a","a"]']) expect(() => parseCalendarIds(input)).toThrow('malformed')
  })
  it('allows only granted selected services and hard-coded relative GET paths', async () => {
    const { contexts } = await setup({ scopes: GOOGLE_SCOPES.gmail })
    const calls: string[] = []
    const client = createGoogleClient(contexts[0], { fetch: async (url: string, init: RequestInit) => { calls.push(String(url)); expect(init.redirect).toBe('error'); expect(init.method).toBe('GET'); return Response.json({ messages: [] }) } })
    expect(client.identity()?.services).toEqual(['gmail'])
    await expect(client.get('calendar', '/users/me/calendarList')).rejects.toMatchObject({ code: 'forbidden' })
    for (const path of ['https://evil.example', '//evil.example', '/users/me/messages/../profile', '/users/me/messages/a?bad=value', '/users/me/messages/%2e%2e']) await expect(client.get('gmail', path)).rejects.toMatchObject({ code: 'malformed' })
    expect(await client.get('gmail', '/users/me/messages', { labelIds: ['INBOX','UNREAD'] })).toEqual({ messages: [] })
    expect(new URL(calls[0]).searchParams.getAll('labelIds')).toEqual(['INBOX','UNREAD'])
  })
})

describe('Google shared refresh', () => {
  it.each([undefined, 'rotated'])('coalesces services, preserves omitted refresh token, persists restart, isolates accounts (%s)', async rotated => {
    const { contexts, values, restart } = await setup({ expiresAt: 0 })
    let count = 0
    const fakeFetch = async (url: string, init: RequestInit) => {
      if (String(url).endsWith('/token')) { count++; expect(new URLSearchParams(String(init.body)).get('refresh_token')).toBe('fake-refresh'); return Response.json({ access_token: 'renewed', expires_in: 3600, token_type: 'Bearer', ...(rotated ? { refresh_token: rotated } : {}) }) }
      expect((init.headers as Record<string,string>).Authorization).toBe('Bearer renewed')
      return Response.json({ ok: true })
    }
    const a = createGoogleClient(contexts[0], { fetch: fakeFetch })
    const b = createGoogleClient(contexts[1], { fetch: fakeFetch })
    await Promise.all([a.get('gmail','/users/me/messages'), b.get('calendar','/users/me/calendarList')])
    expect(count).toBe(1)
    expect(JSON.parse(values.get('a/credentials')!).refreshToken).toBe(rotated ?? 'fake-refresh')
    expect(JSON.parse(values.get('b/credentials')!).accessToken).toBe('fake-access')
    await restart()
    const restarted = createGoogleClient(contexts.at(-4)!, { fetch: fakeFetch })
    expect(restarted.identity()?.email).toBe('a@example.com')
    await restarted.get('gmail', '/users/me/messages')
    expect(count).toBe(1)
  })
  it('maps invalid_grant without leaking provider responses and preserves prior bundle', async () => {
    const { contexts, values } = await setup({ expiresAt: 0 })
    const before = values.get('a/credentials')
    const client = createGoogleClient(contexts[0], { fetch: async () => Response.json({ error: 'invalid_grant', error_description: 'fake-secret' }, { status: 400 }) })
    await expect(client.get('gmail','/users/me/messages')).rejects.toMatchObject({ code: 'unauthorized', message: 'unauthorized' })
    expect(values.get('a/credentials')).toBe(before)
  })
})

it('retries a rejected access token once using the account refresh revision',async()=>{
  const {contexts}=await setup()
  let exchanges=0;let reads=0
  const client=createGoogleClient(contexts[0],{fetch:async(url:string)=>{
    if(url.endsWith('/token')){exchanges++;return Response.json({access_token:'new',expires_in:3600,token_type:'Bearer'})}
    reads++;return Response.json({error:'rejected'},{status:401})
  }})
  await expect(client.get('gmail','/users/me/messages')).rejects.toMatchObject({code:'unauthorized'})
  expect(exchanges).toBe(1);expect(reads).toBe(2)
})
it.each([[403,'forbidden'],[429,'rateLimited'],[503,'offline']] as const)('maps HTTP %s without leaking response content',async(code,expected)=>{
  const {contexts}=await setup()
  const client=createGoogleClient(contexts[0],{fetch:async()=>Response.json({detail:'fake-private'}, {status:code})})
  await expect(client.get('gmail','/users/me/messages')).rejects.toMatchObject({code:expected,message:expected})
})
it('aborts a timed out request and reports a bounded error',async()=>{
  const {contexts}=await setup()
  const client=createGoogleClient(contexts[0],{timeoutMs:10,fetch:async(_url:string,init:RequestInit)=>new Promise((_resolve,reject)=>init.signal?.addEventListener('abort',()=>reject(new Error('fake-private'))))})
  await expect(client.get('gmail','/users/me/messages')).rejects.toMatchObject({code:'timeout'})
})
