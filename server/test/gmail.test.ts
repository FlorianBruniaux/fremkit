import { describe, expect, it } from 'vitest'
import { createGmailProvider } from '../src/providers/gmail.js'
import { createGoogleClient, GOOGLE_SCOPES, type GoogleApiClient, type GoogleIdentity } from '../src/connections/google-client.js'
import type { ConnectionServiceContext } from '../src/connections/types.js'
const metadata = (id = 'm1', labels = ['INBOX', 'UNREAD']) => ({ id, threadId: 't1', labelIds: labels, internalDate: '1000', snippet: 'private body', payload: { body: { data: 'private attachment' }, headers: [{ name: 'fRoM', value: 'Sender <sender@example.com>' }, { name: 'Subject', value: '<b>Same subject</b>' }, { name: 'Date', value: 'Thu, 01 Oct 2026 10:00:00 +0200' }] } })
function context(id = 'a'): ConnectionServiceContext {
  const controller = new AbortController()
  return { id, serviceId: 'gmail', channel: 'gmail:' + id, fields: {}, secrets: {}, account: { signal: controller.signal, request: async op => op({ revision: 1, secrets: {} }, controller.signal), refresh: async () => ({ revision: 2, secrets: {} }) } }
}
function harness(id = 'a') {
  let now = 10000, identity: GoogleIdentity | null = { subject: id, email: id + '@example.com', services: ['gmail'] }
  const calls: { service: string; path: string; query?: Record<string, string | string[]> }[] = []
  const responses: Record<string, unknown> = { '/users/me/messages': { messages: [{ id: 'm1', threadId: 't1' }], resultSizeEstimate: 99 }, '/users/me/messages/m1': metadata() }
  const client: GoogleApiClient = { identity: () => identity, get: async (service, path, query) => { calls.push({ service, path, query }); const v = responses[path + (query?.pageToken ? '?' + query.pageToken : '')]; if (v instanceof Error) throw v; return v } }
  const provider = createGmailProvider(context(id), { client, now: () => now, openUrl: async () => {} })
  return { provider, responses, calls, tick: (ms = 1000) => { now += ms }, identity: (v: GoogleIdentity | null) => { identity = v } }
}
describe('read-only Gmail metadata', () => {
  it('normalizes selected headers without body/snippet and labels estimates', async () => {
    const h = harness(), s = await h.provider.poll!()
    expect(s).toMatchObject({ connectionId: 'a', account: { email: 'a@example.com' }, freshness: 'fresh', loadedCount: 1, estimatedUnreadCount: 99, truncated: false, messages: [{ id: 'm1', threadId: 't1', sender: 'Sender <sender@example.com>', subject: '<b>Same subject</b>', receivedAt: 1000, open: { available: true, reason: null } }] })
    expect(h.calls[0]).toEqual({ service: 'gmail', path: '/users/me/messages', query: { maxResults: '25', labelIds: ['INBOX', 'UNREAD'], includeSpamTrash: 'false', fields: 'messages(id,threadId),nextPageToken,resultSizeEstimate' } })
    expect(h.calls[1].query).toEqual({ format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'], fields: 'id,threadId,labelIds,internalDate,payload(headers)' })
    expect(JSON.stringify(s)).not.toMatch(/private body|private attachment|snippet/)
  })
  it('filters changed labels and deduplicates pages without conflating two accounts', async () => {
    const a = harness(), b = harness('b')
    a.responses['/users/me/messages'] = { messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'page2', resultSizeEstimate: 9 }
    a.responses['/users/me/messages?page2'] = { messages: [{ id: 'm1' }] }
    a.responses['/users/me/messages/m2'] = metadata('m2', ['INBOX'])
    const first = await a.provider.poll!(), second = await b.provider.poll!()
    expect(first.messages).toHaveLength(1); expect(second.messages).toHaveLength(1)
    expect(first.account?.email).toBe('a@example.com'); expect(second.account?.email).toBe('b@example.com')
    expect(a.calls.filter(c => c.path === '/users/me/messages/m1')).toHaveLength(1)
  })
  it('bounds pagination and metadata requests with truncation', async () => {
    const h = harness(); h.responses['/users/me/messages'] = { messages: Array.from({ length: 25 }, (_, i) => ({ id: 'm' + i })), nextPageToken: 'page2' }
    h.responses['/users/me/messages?page2'] = { messages: Array.from({ length: 25 }, (_, i) => ({ id: 'm' + (i + 25) })), nextPageToken: 'page3' }
    for (let i = 0; i < 50; i++) h.responses['/users/me/messages/m' + i] = metadata('m' + i)
    const s = await h.provider.poll!(); expect(s.messages).toHaveLength(50); expect(s.truncated).toBe(true); expect(s.estimatedUnreadCount).toBeNull(); expect(h.calls).toHaveLength(52)
  })
  for (const code of ['forbidden', 'unauthorized', 'timeout', 'rateLimited', 'offline']) it('retains metadata with fixed ' + code + ' failure', async () => {
    const h = harness(), first = await h.provider.poll!(); h.tick(); h.responses['/users/me/messages'] = Object.assign(new Error('private-secret'), { code })
    const s = await h.provider.poll!(); expect(s.messages?.[0].subject).toBe(first.messages?.[0].subject); expect(s).toMatchObject({ freshness: 'stale', error: code, updatedAt: 10000 }); expect(JSON.stringify(s)).not.toContain('private-secret')
  })
  it('preserves last good malformed metadata but clears data across identity replacement', async () => {
    const h = harness(); await h.provider.poll!(); h.responses['/users/me/messages/m1'] = { id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'], payload: { headers: [{ name: 'From', value: {} }] } }
    expect(await h.provider.poll!()).toMatchObject({ freshness: 'stale', error: 'malformed', loadedCount: 1 })
    h.identity({ subject: 'other', email: 'other@example.com', services: ['gmail'] }); expect((await h.provider.poll!()).messages).toBeNull()
  })
  it('does not fetch absent grants and reports unknown rather than zero', async () => {
    const h = harness(); h.identity({ subject: 'a', email: 'a@example.com', services: [] }); expect(await h.provider.poll!()).toMatchObject({ error: 'forbidden', messages: null, loadedCount: null }); expect(h.calls).toEqual([])
  })
  it('refuses remote, unknown, cross-account and URL commands; opening uses a selected, current resource', async () => {
    const h = harness(); await h.provider.poll!()
    for (const payload of [{ connectionId: 'b', messageId: 'm1' }, { connectionId: 'a', messageId: 'unknown' }, { connectionId: 'a', messageId: 'm1', url: 'https://example.com' }]) expect(await h.provider.commands!.open(payload, { loopback: true })).toMatchObject({ ok: false, error: 'refused' })
    expect(await h.provider.commands!.open({ connectionId: 'a', messageId: 'm1' }, { loopback: false })).toMatchObject({ ok: false })
    expect(await h.provider.commands!.open({ connectionId: 'a', messageId: 'm1' }, { loopback: true })).toEqual({ ok: true })
  })
  it('coalesces polls and refuses late publication after stop', async () => {
    let resolve!: (value: unknown) => void
    const ctx = context(); let calls = 0
    const p = createGmailProvider(ctx, { client: { identity: () => ({ subject: 'a', email: 'a@example.com', services: ['gmail'] }), get: async () => { calls++; return new Promise(r => { resolve = r }) } } })
    const one = p.poll!(), two = p.poll!(); p.stop!(); resolve({ messages: [{ id: 'm1' }] }); expect(await one).toMatchObject({ messages: null, freshness: 'unavailable' }); expect(await two).toEqual(await one); expect(calls).toBe(1)
  })
  it('holds poll coalescing until all metadata requests settle after one failure', async () => {
    const ctx = context(); const resolvers: ((value: unknown) => void)[] = []; let reads = 0
    const p = createGmailProvider(ctx, { client: { identity: () => ({ subject: 'a', email: 'a@example.com', services: ['gmail'] }), get: async (_service, path) => {
      if (path === '/users/me/messages') return { messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] }
      reads++; if (path.endsWith('/m1')) throw Object.assign(new Error(), { code: 'timeout' })
      return new Promise(r => resolvers.push(r))
    } } })
    const first = p.poll!(); let settled = false; void first.then(() => { settled = true }); await new Promise<void>(r => setImmediate(r))
    expect(settled).toBe(false)
    const second = p.poll!(); await Promise.resolve(); expect(reads).toBe(3)
    resolvers[0](metadata('m2')); resolvers[1](metadata('m3')); expect(await second).toEqual(await first)
  })
  it('integrates the real Google client with repeated labels and metadata headers at the HTTP boundary', async () => {
    const ctx = context(); ctx.fields = { clientId: 'example.apps.googleusercontent.com', services: '["gmail"]' }
    ctx.secrets = { credentials: JSON.stringify({ version: 1, clientId: ctx.fields.clientId, accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 999999, subject: 'a', email: 'a@example.com', scopes: GOOGLE_SCOPES.gmail }) }
    ctx.account.request = async op => op({ revision: 1, secrets: ctx.secrets }, ctx.account.signal)
    const urls: URL[] = []
    const client = createGoogleClient(ctx, { now: () => 10000, fetch: async (input: string | URL | Request) => {
      const url = new URL(String(input)); urls.push(url)
      return new Response(JSON.stringify(url.pathname.endsWith('/m1') ? metadata() : { messages: [{ id: 'm1' }] }), { headers: { 'Content-Type': 'application/json' } })
    } })
    const snapshot = await createGmailProvider(ctx, { client, now: () => 10000 }).poll!()
    expect(snapshot.loadedCount).toBe(1); expect(urls[0].origin).toBe('https://gmail.googleapis.com'); expect(urls[0].searchParams.getAll('labelIds')).toEqual(['INBOX', 'UNREAD']); expect(urls[0].searchParams.has('q')).toBe(false)
    expect(urls[1].searchParams.getAll('metadataHeaders')).toEqual(['From', 'Subject', 'Date']); expect(urls[1].searchParams.get('format')).toBe('metadata')
  })

  it('does not publish fresh data when its grant disappears during the list read', async () => {
    const ctx = context(); let granted = true, resolve!: (v: unknown) => void
    const p = createGmailProvider(ctx, { client: { identity: () => ({ subject: 'a', email: 'a@example.com', services: granted ? ['gmail'] : [] }), get: async () => new Promise(r => { resolve = r }) } })
    const pending = p.poll!(); granted = false; resolve({ messages: [] }); expect((await pending).freshness).not.toBe('fresh')
  })

  it('retains prior metadata as explicitly stale when a grant is revoked during a refresh', async () => {
    let resolve!: (v: unknown) => void
    const client: GoogleApiClient = { identity: () => ({ subject: 'a', email: 'a@example.com', services: granted ? ['gmail'] : [] }), get: async (_service, path) => pendingRead ? new Promise(r => { resolve = r }) : path.endsWith('/m1') ? metadata() : { messages: [{ id: 'm1' }] } }
    let granted = true, pendingRead = false
    const p = createGmailProvider(context(), { client }); await p.poll!(); pendingRead = true
    const pending = p.poll!(); granted = false; resolve({ messages: [] }); expect(await pending).toMatchObject({ freshness: 'stale', error: 'forbidden', messages: [{ id: 'm1', open: { available: false, reason: 'stale' } }] })
  })

})

// Account accents must remain inert CSS values, tied to this connection.
describe('Gmail account accents', () => {
  it.each([['#AABBCC', '#aabbcc'], ['red;background:url(https://example.com)', '#5b8def'], ['', '#5b8def']])('publishes a normalized connection color for %s', async (color, expected) => {
    const ctx = context(); ctx.fields.color = color
    const client: GoogleApiClient = { identity: () => ({ subject: 'a', email: 'a@example.com', services: ['gmail'] }), get: async () => ({ messages: [] }) }
    const snapshot = await createGmailProvider(ctx, { client }).poll!()
    expect(snapshot.account).toEqual({ email: 'a@example.com', color: expected })
  })
})
