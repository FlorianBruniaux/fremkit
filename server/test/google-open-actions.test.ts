import { describe, expect, it } from 'vitest'
import { createGmailProvider } from '../src/providers/gmail.js'
import { createGoogleCalendarProvider } from '../src/providers/google-calendar.js'
import type { ConnectionServiceContext } from '../src/connections/types.js'
import type { GoogleApiClient, GoogleIdentity } from '../src/connections/google-client.js'

const start = Date.parse('2026-10-11T12:00:00Z')
const metadata = { id: '19aa0011', threadId: '19bb0022', labelIds: ['INBOX', 'UNREAD'], internalDate: String(start), payload: { headers: [] } }
const event = { id: 'event1', status: 'confirmed', start: { dateTime: '2026-10-11T13:00:00Z' }, end: { dateTime: '2026-10-11T14:00:00Z' }, htmlLink: 'https://calendar.google.com/calendar/event?eid=Y2FsZW5kYXJldmVudA&authuser=0&unsafe=discard' }
function harness(service: 'gmail' | 'calendar') {
  let identity: GoogleIdentity | null = { subject: 'account-a', email: 'a+work@example.com', services: [service] }, now = start
  const controller = new AbortController(), opened: string[] = [], calls: string[] = []
  const ctx: ConnectionServiceContext = { id: 'account-a', channel: service === 'gmail' ? 'gmail:account-a' : 'google-calendar:account-a', serviceId: service, fields: { calendarIds: '[]' }, secrets: {}, account: { signal: controller.signal, request: async op => op({ revision: 1, secrets: {} }, controller.signal), refresh: async () => ({ revision: 2, secrets: {} }) } }
  const responses: Record<string, unknown> = { '/users/me/messages': { messages: [{ id: metadata.id }] }, ['/users/me/messages/' + metadata.id]: metadata, '/users/me/calendarList': { items: [{ id: 'primary-calendar', primary: true }] }, '/calendars/primary-calendar/events': { items: [event] }, '/calendars/primary-calendar/events/event1': event }
  const client: GoogleApiClient = { identity: () => identity, get: async (_service, path) => { calls.push(path); const value = responses[path]; if (value instanceof Error) throw value; return value } }
  const openUrl = async (url: string) => { opened.push(url) }
  const provider = service === 'gmail' ? createGmailProvider(ctx, { client, now: () => now, openUrl }) : createGoogleCalendarProvider(ctx, { client, now: () => now, openUrl })
  const payload = service === 'gmail' ? { connectionId: ctx.id, messageId: metadata.id, instanceId: 'gmail-tile' } : { connectionId: ctx.id, calendarId: 'primary-calendar', eventId: event.id, instanceId: 'calendar-tile' }
  return { provider, payload, opened, responses, calls, ctx, client, openUrl, tick: () => { now += 120001 }, replace: () => { identity = { subject: 'account-b', email: 'b@example.com', services: [service] } } }
}
describe('account-specific Google opening', () => {
  it('opens the revalidated Gmail thread using the verified email, with the host instance stamp', async () => {
    const h = harness('gmail'); const snapshot: any = await h.provider.poll!()
    expect(snapshot.messages[0].open).toEqual({ available: true, reason: null })
    expect(await h.provider.commands!.open(h.payload, { loopback: true })).toEqual({ ok: true })
    expect(h.opened).toEqual(['https://mail.google.com/mail/?authuser=a%2Bwork%40example.com#all/19bb0022'])
    expect(h.calls.at(-1)).toBe('/users/me/messages/19aa0011')
  })
  it('opens the API Calendar event with explicit verified email, discarding default-account and unrelated query fields', async () => {
    const h = harness('calendar'); const snapshot: any = await h.provider.poll!()
    expect(snapshot.events[0].open).toEqual({ available: true, reason: null })
    expect(await h.provider.commands!.open(h.payload, { loopback: true })).toEqual({ ok: true })
    expect(h.opened).toEqual(['https://calendar.google.com/calendar/event?eid=Y2FsZW5kYXJldmVudA&authuser=a%2Bwork%40example.com'])
    expect(h.calls.at(-1)).toBe('/calendars/primary-calendar/events/event1')
  })
  it('accepts the legacy Google Calendar API HTML-link host and emits only the canonical account-specific destination', async () => {
    const h=harness('calendar');const legacy={...event,htmlLink:'https://www.google.com/calendar/event?eid=Y2FsZW5kYXJldmVudA&ctz=Europe%2FParis'}
    h.responses['/calendars/primary-calendar/events']={items:[legacy]};h.responses['/calendars/primary-calendar/events/event1']=legacy
    const snapshot:any=await h.provider.poll!();expect(snapshot.events[0].open.available).toBe(true)
    expect(await h.provider.commands!.open(h.payload,{loopback:true})).toEqual({ok:true})
    expect(h.opened).toEqual(['https://calendar.google.com/calendar/event?eid=Y2FsZW5kYXJldmVudA&authuser=a%2Bwork%40example.com'])
  })
  for (const service of ['gmail', 'calendar'] as const) {
    it(service + ' rejects injected URL/account, empty host stamps and remote commands without side effects', async () => {
      const h = harness(service); await h.provider.poll!()
      for (const payload of [{ ...h.payload, url: 'https://evil.example' }, { ...h.payload, account: 'b@example.com' }, { ...h.payload, instanceId: '' }, { ...h.payload, connectionId: 'account-b' }]) expect(await h.provider.commands!.open(payload, { loopback: true })).toMatchObject({ ok: false, error: 'refused' })
      expect(await h.provider.commands!.open(h.payload, { loopback: false })).toMatchObject({ ok: false })
      expect(h.opened).toEqual([])
    })
    it(service + ' refuses old snapshots and account replacement', async () => {
      const h = harness(service); await h.provider.poll!(); h.tick()
      expect(await h.provider.commands!.open(h.payload, { loopback: true })).toMatchObject({ ok: false })
      const next = harness(service); await next.provider.poll!(); next.replace()
      expect(await next.provider.commands!.open(next.payload, { loopback: true })).toMatchObject({ ok: false }); expect(next.opened).toEqual([]); expect(h.opened).toEqual([])
    })
    it(service + ' returns a fixed failure when the OS opener fails', async () => {
      const h = harness(service), deps = { client: h.client, now: () => start, openUrl: async () => { throw new Error('private host detail') } }
      const p = service === 'gmail' ? createGmailProvider(h.ctx, deps) : createGoogleCalendarProvider(h.ctx, deps)
      await p.poll!(); expect(await p.commands!.open(h.payload, { loopback: true })).toEqual({ ok: false, error: 'offline' })
    })
    it(service + ' does not open if disconnected during exact-resource revalidation', async () => {
      const h = harness(service); let resolve!: (value: unknown) => void, defer = false
      const deps = { client: { identity: h.client.identity, get: async (s: any, path: string, q: any) => defer ? new Promise(r => { resolve = r }) : h.client.get(s, path, q) }, now: () => start, openUrl: h.openUrl }
      const p = service === 'gmail' ? createGmailProvider(h.ctx, deps) : createGoogleCalendarProvider(h.ctx, deps)
      await p.poll!(); defer = true; const pending = p.commands!.open(h.payload, { loopback: true }); await Promise.resolve();
      expect(resolve).toBeTypeOf('function'); p.stop!(); resolve(service === 'gmail' ? metadata : event)
      expect(await pending).toMatchObject({ ok: false }); expect(h.opened).toEqual([])
    })
  }
  for (const htmlLink of ['https://calendar.google.com.evil.example/calendar/event?eid=abc', 'https://user@calendar.google.com/calendar/event?eid=abc', 'https://calendar.google.com/calendar/event?eid=abc#redirect', 'https://calendar.google.com/calendar/settings?eid=abc', 'https://calendar.google.com/calendar/event?eid=abc&authuser=0&authuser=1', 'https://calendar.google.com/calendar/event']) {
    it('refuses unsupported Calendar HTML link ' + htmlLink, async () => {
      const h = harness('calendar'); h.responses['/calendars/primary-calendar/events'] = { items: [{ ...event, htmlLink }] }; h.responses['/calendars/primary-calendar/events/event1'] = { ...event, htmlLink }; await h.provider.poll!()
      expect(await h.provider.commands!.open(h.payload, { loopback: true })).toMatchObject({ ok: false }); expect(h.opened).toEqual([])
    })
  }
  it('rejects changed resource identities before calling the opener', async () => {
    const h = harness('gmail'); await h.provider.poll!(); h.responses['/users/me/messages/' + metadata.id] = { ...metadata, id: 'other-id' }
    expect(await h.provider.commands!.open(h.payload, { loopback: true })).toMatchObject({ ok: false }); expect(h.opened).toEqual([])
    const c = harness('calendar'); await c.provider.poll!(); c.responses['/calendars/primary-calendar/events/event1'] = { ...event, id: 'other-id' }
    expect(await c.provider.commands!.open(c.payload, { loopback: true })).toMatchObject({ ok: false }); expect(c.opened).toEqual([])
  })
})
