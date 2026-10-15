import { describe, expect, it } from 'vitest'
import { createGoogleCalendarProvider } from '../src/providers/google-calendar.js'
import { createGoogleClient, GOOGLE_SCOPES, type GoogleApiClient, type GoogleIdentity } from '../src/connections/google-client.js'
import type { ConnectionServiceContext } from '../src/connections/types.js'
const event = (id = 'e1') => ({ id, summary: '<b>Same title</b>', status: 'confirmed', start: { dateTime: '2026-10-10T15:00:00+02:00', timeZone: 'Europe/Paris' }, end: { dateTime: '2026-10-10T16:00:00+02:00', timeZone: 'Europe/Paris' }, htmlLink: 'https://calendar.google.com/calendar/event?eid=abc', conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:123' }, { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }] }, description: 'private notes https://example.com' })
function harness(id = 'a', calendarIds = '["cal1","cal2"]') {
  let now = Date.parse('2026-10-10T12:00:00Z'), identity: GoogleIdentity | null = { subject: id, email: id + '@example.com', services: ['calendar'] }
  const controller = new AbortController(), calls: { path: string; query?: Record<string, string | string[]> }[] = [], opens: string[] = []
  const responses: Record<string, unknown> = { '/users/me/calendarList': { items: [{ id: 'cal1', summary: 'Same name', timeZone: 'Europe/Paris', primary: true }, { id: 'cal2', summary: 'Same name', timeZone: 'America/New_York' }] }, '/calendars/cal1/events': { items: [event()], timeZone: 'Europe/Paris' }, '/calendars/cal2/events': { items: [] }, '/calendars/cal1/events/e1': event() }
  const ctx: ConnectionServiceContext = { id, channel: 'google-calendar:' + id, serviceId: 'calendar', fields: { calendarIds }, secrets: {}, account: { signal: controller.signal, request: async op => op({ revision: 1, secrets: {} }, controller.signal), refresh: async () => ({ revision: 2, secrets: {} }) } }
  const client: GoogleApiClient = { identity: () => identity, get: async (service, path, query) => { expect(service).toBe('calendar'); calls.push({ path, query }); const v = responses[path + (query?.pageToken ? '?' + query.pageToken : '')]; if (v instanceof Error) throw v; return v } }
  const provider = createGoogleCalendarProvider(ctx, { client, now: () => now, openUrl: async url => { opens.push(url) } })
  return { provider, responses, calls, opens, ctx, client, tick: (ms = 1000) => { now += ms }, identity: (v: GoogleIdentity | null) => { identity = v }, abort: () => controller.abort() }
}
const command = { connectionId: 'a', calendarId: 'cal1', eventId: 'e1' }
describe('Google Calendar read-only service', () => {
  it('normalizes offsets, retains stable calendar/account IDs and omits private notes and URLs', async () => {
    const h = harness(), s = await h.provider.poll!()
    expect(s).toMatchObject({ connectionId: 'a', account: { email: 'a@example.com' }, freshness: 'fresh', events: [{ id: 'e1', connectionId: 'a', calendarId: 'cal1', calendarLabel: 'Same name', title: '<b>Same title</b>', start: 1791637200000, end: 1791640800000, allDay: false, timeZone: 'Europe/Paris', open: { available: true, reason: null }, join: { available: true, reason: null } }] })
    expect(s.calendars?.map(c => c.id)).toEqual(['cal1', 'cal2']); expect(JSON.stringify(s)).not.toMatch(/private notes|https:|subject/)
    expect(h.calls.find(c => c.path === '/calendars/cal1/events')?.query).toMatchObject({ singleEvents: 'true', showDeleted: 'true', orderBy: 'startTime', timeZone: 'UTC', timeMin: '2026-10-10T11:00:00.000Z', timeMax: '2026-10-24T12:00:00.000Z' })
    const b = harness('b'); expect((await b.provider.poll!()).events?.[0].connectionId).toBe('b')
  })
  it('preserves all-day exclusive dates and recurring exceptions, omits cancelled instances', async () => {
    const h = harness(); h.responses['/calendars/cal1/events'] = { items: [{ id: 'all1', summary: 'All day', start: { date: '2026-10-11' }, end: { date: '2026-10-13' } }, { ...event('rec1'), recurringEventId: 'master1', originalStartTime: { dateTime: '2026-10-10T14:00:00+02:00' } }, { id: 'gone', status: 'cancelled' }] }
    const s = await h.provider.poll!(); expect(s.events).toHaveLength(2); expect(s.events?.find(e => e.id === 'all1')).toMatchObject({ allDay: true, startDate: '2026-10-11', endDate: '2026-10-13', start: 1791676800000, end: 1791849600000 }); expect(s.events?.find(e => e.id === 'rec1')?.recurringEventId).toBe('master1')
  })
  it('normalizes IANA timezone times without an explicit offset and rejects impossible local times', async () => {
    const h = harness(); h.responses['/calendars/cal1/events'] = { items: [{ ...event(), start: { dateTime: '2026-10-10T15:00:00', timeZone: 'Europe/Paris' }, end: { dateTime: '2026-10-10T16:00:00', timeZone: 'Europe/Paris' } }] }
    expect((await h.provider.poll!()).events?.[0].start).toBe(1791637200000)
    h.responses['/calendars/cal1/events'] = { items: [{ ...event(), start: { dateTime: '2026-03-29T02:30:00', timeZone: 'Europe/Paris' } }] }; expect((await h.provider.poll!()).calendars?.[0]).toMatchObject({ freshness: 'stale', error: 'malformed' })
  })
  it('retains only failed calendar stale while another succeeds and disables stale joining', async () => {
    const h = harness(); await h.provider.poll!(); h.tick(); h.responses['/calendars/cal1/events'] = Object.assign(new Error('private-error'), { code: 'forbidden' }); h.responses['/calendars/cal2/events'] = { items: [event('e2')] }
    const s = await h.provider.poll!(); expect(s.calendars?.[0]).toMatchObject({ freshness: 'stale', error: 'forbidden', events: [{ id: 'e1', join: { available: false, reason: 'stale' } }] }); expect(s.calendars?.[1]).toMatchObject({ freshness: 'fresh', error: null, events: [{ id: 'e2' }] }); expect(s.events).toHaveLength(2); expect(await h.provider.commands!.join(command, { loopback: true })).toMatchObject({ ok: false }); expect(h.opens).toEqual([])
  })
  it('isolates discovery failure, missing selection and invalid calendar configuration', async () => {
    const h = harness(); await h.provider.poll!(); h.responses['/users/me/calendarList'] = Object.assign(new Error(), { code: 'timeout' }); expect(await h.provider.poll!()).toMatchObject({ freshness: 'stale', error: 'timeout', events: [{ id: 'e1' }] })
    h.responses['/users/me/calendarList'] = { items: [{ id: 'cal2', summary: 'Same name' }] }; const s = await h.provider.poll!(); expect(s.calendars?.find(c => c.id === 'cal1')).toMatchObject({ freshness: 'stale', error: 'forbidden' }); expect(s.calendars?.find(c => c.id === 'cal2')?.freshness).toBe('fresh')
    const bad = harness('a', 'not JSON'); expect(await bad.provider.poll!()).toMatchObject({ events: null, error: 'malformed' }); expect(bad.calls).toEqual([])
  })
  it('uses discovered primary stable ID by default and bounds event pagination', async () => {
    const h = harness('a', '[]'); h.responses['/calendars/cal1/events'] = { items: [event()], nextPageToken: 'page2' }; h.responses['/calendars/cal1/events?page2'] = { items: [event('e2')], nextPageToken: 'page3' }
    const s = await h.provider.poll!(); expect(s.events?.map(e => e.id)).toEqual(['e1', 'e2']); expect(s.truncated).toBe(true); expect(h.calls.filter(c => c.path.startsWith('/calendars/'))).toHaveLength(2)
  })
  it('joins only the current stored event via attached allowlisted video and returns opening failures', async () => {
    const h = harness(); await h.provider.poll!(); expect(await h.provider.commands!.join(command, { loopback: true })).toEqual({ ok: true }); expect(h.opens).toEqual(['https://meet.google.com/abc-defg-hij']); expect(h.calls.at(-1)?.path).toBe('/calendars/cal1/events/e1')
    h.responses['/calendars/cal1/events/e1'] = { ...event(), status: 'cancelled' }; expect(await h.provider.commands!.join(command, { loopback: true })).toMatchObject({ ok: false }); expect(h.opens).toHaveLength(1)
  })
  it('rejects arbitrary, unknown, cross-account and remote actions and uses the verified account for opening', async () => {
    const h = harness(); await h.provider.poll!()
    for (const payload of [{ ...command, connectionId: 'b' }, { ...command, calendarId: 'cal2' }, { ...command, eventId: 'unknown' }, { ...command, url: 'https://example.com' }]) expect(await h.provider.commands!.join(payload, { loopback: true })).toMatchObject({ ok: false, error: 'refused' })
    expect(await h.provider.commands!.join(command, { loopback: false })).toMatchObject({ ok: false }); expect(h.opens).toEqual([])
    expect(await h.provider.commands!.open(command, { loopback: true })).toEqual({ ok: true })
  })
  for (const destination of ['http://meet.google.com/abc-defg-hij', 'https://meet.google.com.evil.example/abc-defg-hij', 'https://user@meet.google.com/abc-defg-hij', 'https://meet.google.com:444/abc-defg-hij', 'https://example.com', 'sip:test@example.com']) it('rejects unsupported video ' + destination, async () => {
    const h = harness(); h.responses['/calendars/cal1/events'] = { items: [{ ...event(), conferenceData: { entryPoints: [{ entryPointType: 'video', uri: destination }] } }] }; expect((await h.provider.poll!()).events?.[0].join.available).toBe(false); expect(await h.provider.commands!.join(command, { loopback: true })).toMatchObject({ ok: false }); expect(h.opens).toEqual([])
  })
  it('refuses stale age, account replacement and stop during event revalidation', async () => {
    const h = harness(); await h.provider.poll!(); h.tick(121000); expect(await h.provider.commands!.join(command, { loopback: true })).toMatchObject({ ok: false }); expect(h.opens).toEqual([])
    h.identity({ subject: 'b', email: 'b@example.com', services: ['calendar'] }); h.responses['/users/me/calendarList'] = Object.assign(new Error(), { code: 'offline' }); expect((await h.provider.poll!()).events).toBeNull()
    const other = harness(); let resolve!: (v: unknown) => void
    const p = createGoogleCalendarProvider(other.ctx, { now: () => Date.parse('2026-10-10T12:00:00Z'), client: { identity: other.client.identity, get: async (service, path, q) => path.endsWith('/e1') ? new Promise(r => { resolve = r }) : other.client.get(service, path, q) }, openUrl: async url => { other.opens.push(url) } })
    await p.poll!(); const pending = p.commands!.join(command, { loopback: true }); p.stop!(); resolve(event()); expect(await pending).toMatchObject({ ok: false }); expect(other.opens).toEqual([])
  })
  it('keeps event counts unknown across consecutive initial event and discovery failures', async () => {
    const h = harness(); h.responses['/calendars/cal1/events'] = Object.assign(new Error(), { code: 'offline' }); h.responses['/calendars/cal2/events'] = Object.assign(new Error(), { code: 'offline' })
    expect((await h.provider.poll!()).events).toBeNull()
    h.responses['/users/me/calendarList'] = Object.assign(new Error(), { code: 'offline' }); expect((await h.provider.poll!()).events).toBeNull()
  })
  it('integrates the real Google client for discovered stable IDs, bounded events and event revalidation', async () => {
    const h = harness('a', '[]'), ctx = h.ctx
    ctx.fields.clientId = 'example.apps.googleusercontent.com'; ctx.fields.services = '["calendar"]'
    ctx.secrets = { credentials: JSON.stringify({ version: 1, clientId: ctx.fields.clientId, accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 9999999999999, subject: 'a', email: 'a@example.com', scopes: GOOGLE_SCOPES.calendar }) }
    ctx.account.request = async op => op({ revision: 1, secrets: ctx.secrets }, ctx.account.signal)
    const urls: URL[] = []
    const client = createGoogleClient(ctx, { now: () => 10000, fetch: async (input: string | URL | Request) => {
      const url = new URL(String(input)); urls.push(url)
      const path = url.pathname.replace('/calendar/v3', '')
      return new Response(JSON.stringify(h.responses[path]), { headers: { 'Content-Type': 'application/json' } })
    } })
    const p = createGoogleCalendarProvider(ctx, { client, now: () => Date.parse('2026-10-10T12:00:00Z'), openUrl: async url => { h.opens.push(url) } })
    expect((await p.poll!()).events?.[0].calendarId).toBe('cal1'); expect(await p.commands!.join(command, { loopback: true })).toEqual({ ok: true })
    expect(urls.map(u => u.pathname)).toEqual(['/calendar/v3/users/me/calendarList', '/calendar/v3/calendars/cal1/events', '/calendar/v3/calendars/cal1/events/e1'])
    expect(urls.every(u => u.origin === 'https://www.googleapis.com')).toBe(true); expect(urls[1].searchParams.get('singleEvents')).toBe('true'); expect(h.opens).toEqual(['https://meet.google.com/abc-defg-hij'])
  })

  it('marks existing calendars stale if authorization is aborted during discovery', async () => {
    const h = harness(); let defer = false, resolve!: (v: unknown) => void
    const p = createGoogleCalendarProvider(h.ctx, { now: () => Date.parse('2026-10-10T12:00:00Z'), client: { identity: h.client.identity, get: async (service, path, q) => defer ? new Promise(r => { resolve = r }) : h.client.get(service, path, q) } })
    await p.poll!(); defer = true; const pending = p.poll!(); h.abort(); resolve({ items: [] }); expect(await pending).toMatchObject({ freshness: 'stale', error: 'unauthorized', events: [{ id: 'e1', join: { available: false, reason: 'stale' } }] })
  })

  it('retains stale event truncation when a bounded calendar fails while another succeeds', async () => {
    const h = harness()
    h.responses['/calendars/cal1/events'] = { items: [event()], nextPageToken: 'page2' }
    h.responses['/calendars/cal1/events?page2'] = { items: [event('e2')], nextPageToken: 'page3' }
    const first = await h.provider.poll!()
    expect(first.truncated).toBe(true)
    expect(first.calendars?.find(c => c.id === 'cal1')).toMatchObject({ truncated: true, freshness: 'fresh' })
    h.tick(); h.responses['/calendars/cal1/events'] = Object.assign(new Error(), { code: 'timeout' })
    h.responses['/calendars/cal2/events'] = { items: [event('e3')] }
    const second = await h.provider.poll!()
    expect(second.calendars?.find(c => c.id === 'cal1')).toMatchObject({ truncated: true, freshness: 'stale', error: 'timeout', updatedAt: first.calendars?.find(c => c.id === 'cal1')?.updatedAt, events: [{ id: 'e1' }, { id: 'e2' }] })
    expect(second.calendars?.find(c => c.id === 'cal2')).toMatchObject({ truncated: false, freshness: 'fresh', events: [{ id: 'e3' }] })
    expect(second.truncated).toBe(true)
  })

  for (const id of ['a'.repeat(300), 'a'.repeat(1024), 'a'.repeat(300) + '_20261010T130000Z']) it('preserves and revalidates an exact Calendar identifier of length ' + id.length, async () => {
    const h = harness(), recurringEventId = 'b'.repeat(1024)
    h.responses['/calendars/cal1/events'] = { items: [{ ...event(id), recurringEventId }] }
    h.responses['/calendars/cal1/events/' + id] = { ...event(id), recurringEventId }
    const snapshot = await h.provider.poll!()
    expect(snapshot.events?.[0]).toMatchObject({ id, recurringEventId })
    expect(await h.provider.commands!.join({ ...command, eventId: id }, { loopback: true })).toEqual({ ok: true })
    expect(h.calls.at(-1)?.path).toBe('/calendars/cal1/events/' + id)
    expect(h.opens).toEqual(['https://meet.google.com/abc-defg-hij'])
    expect(await h.provider.commands!.open({ ...command, eventId: id }, { loopback: true })).toEqual({ ok: true })
  })
  it('rejects over-bound Calendar event and recurring IDs without changing stored identifiers or fetching command paths', async () => {
    const h = harness(); await h.provider.poll!()
    const calls = h.calls.length
    expect(await h.provider.commands!.join({ ...command, eventId: 'a'.repeat(1025) }, { loopback: true })).toEqual({ ok: false, error: 'refused' })
    expect(h.calls).toHaveLength(calls)
    h.responses['/calendars/cal1/events'] = { items: [event('a'.repeat(1025))] }
    expect((await h.provider.poll!()).calendars?.find(c => c.id === 'cal1')).toMatchObject({ freshness: 'stale', error: 'malformed', events: [{ id: 'e1' }] })
    h.responses['/calendars/cal1/events'] = { items: [{ ...event(), recurringEventId: 'a'.repeat(1025) }] }
    expect((await h.provider.poll!()).calendars?.find(c => c.id === 'cal1')).toMatchObject({ freshness: 'stale', error: 'malformed', events: [{ id: 'e1' }] })
  })

})

describe('Google Calendar account accents', () => {
  it.each([['#AABBCC', '#aabbcc'], ['red;background:url(https://example.com)', '#5b8def'], ['', '#5b8def']])('publishes a normalized connection color for %s', async (color, expected) => {
    const h = harness(); h.ctx.fields.color = color
    const snapshot = await h.provider.poll!()
    expect(snapshot.account).toEqual({ email: 'a@example.com', color: expected })
    expect(snapshot.events?.[0]?.color).toBe(expected)
  })
})
