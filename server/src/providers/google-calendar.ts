import { z } from 'zod'
import { calendarEventUrl, openGoogleUrl } from './google-links.js'
import type { ConnectionServiceContext } from '../connections/types.js'
import { createGoogleClient, parseCalendarIds, type GoogleApiClient } from '../connections/google-client.js'
import type { Provider } from './types.js'
import { GOOGLE_ACTION_MAX_AGE_MS, googleFailure, type Freshness, type GoogleAction, type GoogleFailure } from './gmail.js'
import { normalizeColor } from './calendar.js'
export interface GoogleCalendarEvent { id: string; connectionId: string; calendarId: string; calendarLabel: string; title: string | null; start: number; end: number; allDay: boolean; startDate: string | null; endDate: string | null; timeZone: string | null; recurringEventId: string | null; color: string; open: GoogleAction; join: GoogleAction }
export interface GoogleCalendarState { id: string; label: string; timeZone: string | null; selected: boolean; events: GoogleCalendarEvent[] | null; truncated: boolean; updatedAt: number | null; freshness: Freshness; error: GoogleFailure | null }
export interface GoogleCalendarSnapshot { connectionId: string; account: { email: string; color: string } | null; calendars: GoogleCalendarState[] | null; events: GoogleCalendarEvent[] | null; window: { start: number; end: number } | null; truncated: boolean; updatedAt: number | null; checkedAt: number | null; freshness: Freshness; error: GoogleFailure | null }
export interface GoogleCalendarProviderDeps { client?: GoogleApiClient; now?: () => number; openUrl?: (url: string) => Promise<void> }
const CalendarId = z.string().min(1).max(1024).refine(v => !/[\x00-\x1f\x7f]/.test(v))
// Read identifiers are opaque, including generated recurring-instance suffixes.
const CalendarEventId = z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/)
const token = z.string().min(1).max(2048).optional()
const calendarSchema = z.object({ id: CalendarId, summary: z.string().max(4096).optional(), timeZone: z.string().max(256).optional(), primary: z.boolean().optional(), deleted: z.boolean().optional() })
const discoverySchema = z.object({ items: z.array(calendarSchema).max(100).default([]), nextPageToken: token })
const boundarySchema = z.object({ date: z.string().max(10).optional(), dateTime: z.string().max(64).optional(), timeZone: z.string().max(256).optional() })
const eventSchema = z.object({ id: CalendarEventId, summary: z.string().max(16384).optional(), status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(), start: boundarySchema.optional(), end: boundarySchema.optional(), recurringEventId: CalendarEventId.optional(), htmlLink: z.string().max(4096).optional(), hangoutLink: z.string().max(4096).optional(), conferenceData: z.object({ entryPoints: z.array(z.object({ entryPointType: z.string().max(64), uri: z.string().max(4096) })).max(30).optional() }).optional() })
const eventsSchema = z.object({ items: z.array(eventSchema).max(100).default([]), nextPageToken: token, timeZone: z.string().max(256).optional() })
const EVENT_FIELDS = 'id,summary,status,start,end,recurringEventId,htmlLink,hangoutLink,conferenceData(entryPoints(entryPointType,uri))'
const invalid = (): never => { throw new z.ZodError([]) }
function safeUrl(value: string | undefined, host: string): URL | null {
  if (!value || /[\x00-\x20\x7f\\]/.test(value)) return null
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === host && !url.username && !url.password && !url.port ? url : null } catch { return null }
}
function meeting(raw: z.infer<typeof eventSchema>): string | null {
  const links = [...(raw.conferenceData?.entryPoints?.filter(e => e.entryPointType === 'video').map(e => e.uri) ?? []), ...(raw.hangoutLink ? [raw.hangoutLink] : [])]
  for (const link of links) { const url = safeUrl(link, 'meet.google.com'); if (url && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(url.pathname) && !url.search && !url.hash) return url.href }
  return null
}
function dateValue(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return invalid()
  const ms = Date.parse(date + 'T00:00:00Z')
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date ? ms : invalid()
}
function timed(value: string, zone?: string): number {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value)
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return invalid()
  const wall = dateValue(match[1]) + Number(match[2]) * 3600000 + Number(match[3]) * 60000 + Number(match[4]) * 1000 + Number((match[5] ?? '').padEnd(3, '0'))
  if (match[6]) { if (match[6] !== 'Z' && (Number(match[6].slice(1, 3)) > 23 || Number(match[6].slice(4)) > 59)) return invalid(); const ms = Date.parse(value); return Number.isFinite(ms) ? ms : invalid() }
  if (!zone) return invalid()
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    const local = (ms: number): number => { const parts = Object.fromEntries(formatter.formatToParts(ms).map(p => [p.type, p.value])); return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) + ms % 1000 }
    const offsets = new Set([-86400000, 0, 86400000].map(delta => local(wall + delta) - (wall + delta)))
    const candidates = [...offsets].map(offset => wall - offset).filter(ms => local(ms) === wall)
    // An ambiguous fall-back wall time uses the earlier occurrence; nonexistent times fail closed.
    return candidates.length ? Math.min(...candidates) : invalid()
  } catch { return invalid() }
}
function normalize(raw: z.infer<typeof eventSchema>, calendar: GoogleCalendarState, ctx: ConnectionServiceContext, email?: string): GoogleCalendarEvent | null {
  if (raw.status === 'cancelled') return null
  if (!raw.start || !raw.end) return invalid()
  const allDay = raw.start.date !== undefined && raw.end.date !== undefined
  if (allDay && (raw.start.dateTime || raw.end.dateTime) || !allDay && (raw.start.date || raw.end.date)) return invalid()
  const zone = raw.start.timeZone ?? calendar.timeZone
  const start = allDay ? dateValue(raw.start.date!) : timed(raw.start.dateTime ?? '', raw.start.timeZone)
  const end = allDay ? dateValue(raw.end.date!) : timed(raw.end.dateTime ?? '', raw.end.timeZone ?? raw.start.timeZone)
  if (end <= start) return invalid()
  const destination = calendarEventUrl(raw.htmlLink, email)
  return { id: raw.id, connectionId: ctx.id, calendarId: calendar.id, calendarLabel: calendar.label, title: raw.summary ?? null, start, end, allDay, startDate: allDay ? raw.start.date! : null, endDate: allDay ? raw.end.date! : null, timeZone: zone ?? null, recurringEventId: raw.recurringEventId ?? null, color: normalizeColor(ctx.fields.color), open: { available: destination !== null, reason: destination ? null : 'unsupportedDestination' }, join: { available: meeting(raw) !== null, reason: meeting(raw) ? null : 'unsupportedDestination' } }
}
function staleCalendar(c: GoogleCalendarState, error: GoogleFailure): GoogleCalendarState {
  return { ...c, freshness: c.events === null ? 'unavailable' : 'stale', error, events: c.events?.map(e => ({ ...e, open: { available: false, reason: 'stale' }, join: { available: false, reason: 'stale' } })) ?? null }
}
export function createGoogleCalendarProvider(ctx: ConnectionServiceContext, deps: GoogleCalendarProviderDeps = {}): Provider<GoogleCalendarSnapshot> {
  const client = deps.client ?? createGoogleClient(ctx), now = deps.now ?? Date.now
  const empty = (): GoogleCalendarSnapshot => ({ connectionId: ctx.id, account: null, calendars: null, events: null, window: null, truncated: false, updatedAt: null, checkedAt: null, freshness: 'unavailable', error: 'unconfigured' })
  let last = empty(), marker: string | undefined, generation = 0, inflight: Promise<GoogleCalendarSnapshot> | undefined
  const current = (epoch: number, subject: string): boolean => epoch === generation && !ctx.account.signal.aborted && client.identity()?.subject === subject && !!client.identity()?.services.includes('calendar')
  const stale = (error: GoogleFailure) => { const calendars = last.calendars?.map(c => c.selected ? staleCalendar(c, error) : c) ?? null; last = { ...last, calendars, events: last.events === null ? null : calendars?.flatMap(c => c.events ?? []) ?? null, checkedAt: now(), freshness: last.events === null ? 'unavailable' : 'stale', error } }
  function cancelled(epoch: number, subject: string): GoogleCalendarSnapshot {
    if (epoch === generation) {
      const identity = client.identity()
      if (identity && identity.subject !== subject) { last = empty(); marker = identity.subject }
      else stale(ctx.account.signal.aborted || !identity ? 'unauthorized' : 'forbidden')
    }
    return last
  }
  async function refresh(): Promise<GoogleCalendarSnapshot> {
    const epoch = generation, identity = client.identity()
    if (identity && marker !== identity.subject) { last = empty(); marker = identity.subject }
    if (!identity || ctx.account.signal.aborted) { stale(ctx.account.signal.aborted ? 'unauthorized' : 'unconfigured'); return last }
    last = { ...last, account: { email: identity.email, color: normalizeColor(ctx.fields.color) } }
    if (!identity.services.includes('calendar')) { stale('forbidden'); return last }
    try {
      const selected = parseCalendarIds(ctx.fields.calendarIds), found = new Map<string, z.infer<typeof calendarSchema>>()
      let pageToken: string | undefined, discoveryTruncated = false
      const tokens = new Set<string>()
      for (let page = 0; page < 2; page++) {
        if (!current(epoch, identity.subject)) return cancelled(epoch, identity.subject)
        const data = discoverySchema.parse(await client.get('calendar', '/users/me/calendarList', { maxResults: '100', showDeleted: 'false', fields: 'items(id,summary,timeZone,primary,deleted),nextPageToken', ...(pageToken ? { pageToken } : {}) }))
        if (!current(epoch, identity.subject)) return cancelled(epoch, identity.subject)
        for (const calendar of data.items) if (!calendar.deleted) found.set(calendar.id, calendar)
        pageToken = data.nextPageToken; if (!pageToken) break
        if (tokens.has(pageToken) || page === 1) { discoveryTruncated = true; break } tokens.add(pageToken)
      }
      const ids = selected.length ? selected : [...found.values()].filter(c => c.primary).map(c => c.id).slice(0, 1)
      if (!ids.length) { stale(discoveryTruncated ? 'malformed' : 'forbidden'); return last }
      const window = { start: now() - 3600000, end: now() + 14 * 86400000 }
      const previous = new Map(last.calendars?.map(c => [c.id, c]) ?? [])
      const states = new Map<string, GoogleCalendarState>()
      for (const c of found.values()) states.set(c.id, { id: c.id, label: c.summary ?? c.id, timeZone: c.timeZone ?? null, selected: ids.includes(c.id), events: null, truncated: false, updatedAt: null, freshness: 'unavailable', error: null })
      for (const id of ids) {
        if (!current(epoch, identity.subject)) return cancelled(epoch, identity.subject)
        const discovered = states.get(id), old = previous.get(id)
        const calendar = discovered ?? { ...(old ?? { id, label: id, timeZone: null, events: null, truncated: false, updatedAt: null, freshness: 'unavailable' as const, error: null }), selected: true }
        if (!discovered) { states.set(id, staleCalendar(calendar, 'forbidden')); continue }
        try {
          const events = new Map<string, GoogleCalendarEvent>(), eventTokens = new Set<string>(); let nextPage: string | undefined, truncated = false
          for (let page = 0; page < 2; page++) {
            if (!current(epoch, identity.subject)) return cancelled(epoch, identity.subject)
            const data = eventsSchema.parse(await client.get('calendar', '/calendars/' + encodeURIComponent(id) + '/events', { maxResults: '100', singleEvents: 'true', showDeleted: 'true', orderBy: 'startTime', timeZone: 'UTC', timeMin: new Date(window.start).toISOString(), timeMax: new Date(window.end).toISOString(), fields: 'items(' + EVENT_FIELDS + '),nextPageToken,timeZone', ...(nextPage ? { pageToken: nextPage } : {}) }))
            if (!current(epoch, identity.subject)) return cancelled(epoch, identity.subject)
            for (const raw of data.items) { const event = normalize(raw, calendar, ctx, identity.email); if (event && event.end > window.start && event.start < window.end) events.set(event.id, event); else events.delete(raw.id) }
            nextPage = data.nextPageToken; if (!nextPage) break
            if (eventTokens.has(nextPage) || page === 1) { truncated = true; break } eventTokens.add(nextPage)
          }
          states.set(id, { ...calendar, events: [...events.values()].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)), truncated, updatedAt: now(), freshness: 'fresh', error: null })
        } catch (error) { states.set(id, staleCalendar({ ...calendar, events: old?.events ?? null, updatedAt: old?.updatedAt ?? null, truncated: old?.truncated ?? false }, googleFailure(error))) }
      }
      if (!current(epoch, identity.subject)) return cancelled(epoch, identity.subject)
      const calendars = [...states.values()], error = calendars.find(c => c.selected && c.error)?.error ?? null
      const events = calendars.some(c => c.events !== null) ? calendars.flatMap(c => c.events ?? []).sort((a, b) => a.start - b.start || a.calendarId.localeCompare(b.calendarId) || a.id.localeCompare(b.id)) : null
      last = { connectionId: ctx.id, account: { email: identity.email, color: normalizeColor(ctx.fields.color) }, calendars, events, window, truncated: discoveryTruncated || calendars.some(c => c.truncated), updatedAt: calendars.some(c => c.selected && c.freshness === 'fresh') ? now() : last.updatedAt, checkedAt: now(), freshness: error ? events === null ? 'unavailable' : 'stale' : 'fresh', error }
    } catch (error) { if (current(epoch, identity.subject)) stale(googleFailure(error)); else cancelled(epoch, identity.subject) }
    return last
  }
  const payloadSchema = z.object({ connectionId: z.literal(ctx.id), calendarId: CalendarId, eventId: CalendarEventId, instanceId: z.string().min(1).max(200).optional() }).strict()
  async function action(kind: 'open' | 'join', payload: unknown, loopback: boolean): Promise<unknown> {
    const request = payloadSchema.safeParse(payload)
    if (!loopback || !request.success) return { ok: false, error: 'refused' }
    const calendar = last.calendars?.find(c => c.id === request.data.calendarId && c.selected), event = calendar?.events?.find(e => e.id === request.data.eventId)
    if (!event || !calendar) return { ok: false, error: 'refused' }
    const epoch = generation, snapshot = last, subject = marker
    if (!subject || !current(epoch, subject) || calendar.freshness !== 'fresh' || calendar.updatedAt === null || now() - calendar.updatedAt > GOOGLE_ACTION_MAX_AGE_MS) return { ok: false, error: 'unavailable', reason: 'stale' }
    if (!event[kind].available) return { ok: false, error: 'unavailable', reason: event[kind].reason }
    try {
      const raw = eventSchema.parse(await client.get('calendar', '/calendars/' + encodeURIComponent(calendar.id) + '/events/' + encodeURIComponent(event.id), { fields: EVENT_FIELDS }))
      if (raw.id !== event.id || raw.status === 'cancelled' || !normalize(raw, calendar, ctx, client.identity()?.email)) return { ok: false, error: 'unavailable' }
      const destination = kind === 'join' ? meeting(raw) : calendarEventUrl(raw.htmlLink, client.identity()?.email)
      if (!destination || !current(epoch, subject) || last !== snapshot || now() - calendar.updatedAt > GOOGLE_ACTION_MAX_AGE_MS) return { ok: false, error: 'unavailable' }
      await (deps.openUrl ?? openGoogleUrl)(destination)
      return { ok: true }
    } catch (error) { return { ok: false, error: googleFailure(error) } }
  }
  return { channel: ctx.channel, get intervalMs() { return last.error ? 30000 : 60000 }, poll() { if (!inflight) { const p = refresh(); inflight = p; void p.finally(() => { if (inflight === p) inflight = undefined }) } return inflight }, stop() { generation++; inflight = undefined; stale('offline') }, commands: { open: (payload, context) => action('open', payload, context?.loopback === true), join: (payload, context) => action('join', payload, context?.loopback === true) } }
}
