import { z } from 'zod'
import { normalizeColor } from './calendar.js'
import { gmailThreadUrl, openGoogleUrl } from './google-links.js'
import type { ConnectionServiceContext } from '../connections/types.js'
import { createGoogleClient, type GoogleApiClient } from '../connections/google-client.js'
import type { Provider } from './types.js'
export type GoogleFailure = 'unconfigured' | 'unauthorized' | 'forbidden' | 'offline' | 'timeout' | 'rateLimited' | 'malformed'
export type Freshness = 'fresh' | 'stale' | 'unavailable'
export interface GoogleAction { available: boolean; reason: 'accountRoutingUnverified' | 'unsupportedDestination' | 'stale' | null }
export interface GmailMessage { id: string; threadId: string; sender: string | null; subject: string | null; date: string | null; receivedAt: number | null; labels: string[]; open: GoogleAction }
export interface GmailSnapshot {
  connectionId: string; account: { email: string; color: string } | null; messages: GmailMessage[] | null; loadedCount: number | null
  estimatedUnreadCount: number | null; truncated: boolean; updatedAt: number | null; checkedAt: number | null; freshness: Freshness; error: GoogleFailure | null
}
export interface GmailProviderDeps { client?: GoogleApiClient; now?: () => number; openUrl?: (url: string) => Promise<void> }
export const GOOGLE_ACTION_MAX_AGE_MS = 120000
export const GoogleResourceId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)
const pageSchema = z.object({ messages: z.array(z.object({ id: GoogleResourceId })).max(25).default([]), nextPageToken: z.string().min(1).max(2048).optional(), resultSizeEstimate: z.number().int().nonnegative().optional() })
const messageSchema = z.object({ id: GoogleResourceId, threadId: GoogleResourceId, labelIds: z.array(z.string().max(256)).max(100), internalDate: z.string().regex(/^\d{1,16}$/).optional(), payload: z.object({ headers: z.array(z.object({ name: z.string().max(256), value: z.string().max(16384) })).max(100).default([]) }).optional() })
export function googleFailure(error: unknown): GoogleFailure {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return code === 'unconfigured' || code === 'unauthorized' || code === 'forbidden' || code === 'offline' || code === 'timeout' || code === 'rateLimited' || code === 'malformed' ? code : error instanceof z.ZodError ? 'malformed' : 'offline'
}
export function createGmailProvider(ctx: ConnectionServiceContext, deps: GmailProviderDeps = {}): Provider<GmailSnapshot> {
  const client = deps.client ?? createGoogleClient(ctx), now = deps.now ?? Date.now
  const empty = (): GmailSnapshot => ({ connectionId: ctx.id, account: null, messages: null, loadedCount: null, estimatedUnreadCount: null, truncated: false, updatedAt: null, checkedAt: null, freshness: 'unavailable', error: 'unconfigured' })
  let last = empty(), marker: string | undefined, generation = 0, inflight: Promise<GmailSnapshot> | undefined
  const current = (epoch: number, identity: string): boolean => epoch === generation && !ctx.account.signal.aborted && client.identity()?.subject === identity && !!client.identity()?.services.includes('gmail')
  const stale = (error: GoogleFailure): GmailSnapshot => ({ ...last, checkedAt: now(), freshness: last.messages === null ? 'unavailable' : 'stale', error, messages: last.messages?.map(m => ({ ...m, open: { available: false, reason: 'stale' } })) ?? null })
  function cancelled(epoch: number, subject: string): GmailSnapshot {
    if (epoch === generation) {
      const identity = client.identity()
      if (identity && identity.subject !== subject) { last = empty(); marker = identity.subject }
      else last = stale(ctx.account.signal.aborted || !identity ? 'unauthorized' : 'forbidden')
    }
    return last
  }
  async function refresh(): Promise<GmailSnapshot> {
    const epoch = generation, identity = client.identity()
    if (identity && marker !== identity.subject) { last = empty(); marker = identity.subject }
    if (!identity || ctx.account.signal.aborted) { last = stale(ctx.account.signal.aborted ? 'unauthorized' : 'unconfigured'); return last }
    last = { ...last, account: { email: identity.email, color: normalizeColor(ctx.fields.color) } }
    if (!identity.services.includes('gmail')) { last = stale('forbidden'); return last }
    try {
      const ids = new Set<string>(), tokens = new Set<string>(); let token: string | undefined, estimated: number | null = null, truncated = false
      for (let page = 0; page < 3; page++) {
        if (!current(epoch, identity.subject)) return cancelled(epoch, identity.subject)
        const raw = pageSchema.parse(await client.get('gmail', '/users/me/messages', { maxResults: '25', labelIds: ['INBOX', 'UNREAD'], includeSpamTrash: 'false', fields: 'messages(id,threadId),nextPageToken,resultSizeEstimate', ...(token ? { pageToken: token } : {}) }))
        if (!current(epoch, identity.subject)) return cancelled(epoch, identity.subject)
        if (page === 0) estimated = raw.resultSizeEstimate ?? null
        for (const m of raw.messages) { if (ids.size < 50) ids.add(m.id); else if (!ids.has(m.id)) truncated = true }
        token = raw.nextPageToken
        if (!token) break
        if (tokens.has(token) || ids.size === 50 || page === 2) { truncated = true; break }
        tokens.add(token)
      }
      const messages: GmailMessage[] = [], selected = [...ids]
      // Four concurrent metadata reads, at most fifty IDs and three list pages per poll.
      for (let offset = 0; offset < selected.length; offset += 4) {
        if (!current(epoch, identity.subject)) return cancelled(epoch, identity.subject)
        const batch = await Promise.allSettled(selected.slice(offset, offset + 4).map(async id => {
          const m = messageSchema.parse(await client.get('gmail', '/users/me/messages/' + encodeURIComponent(id), { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'], fields: 'id,threadId,labelIds,internalDate,payload(headers)' }))
          if (m.id !== id) throw new z.ZodError([])
          if (!m.labelIds.includes('INBOX') || !m.labelIds.includes('UNREAD')) return null
          const header = (name: string) => m.payload?.headers.find(h => h.name.toLowerCase() === name)?.value ?? null
          const received = m.internalDate === undefined ? null : Number(m.internalDate)
          return { id: m.id, threadId: m.threadId, sender: header('from'), subject: header('subject'), date: header('date'), receivedAt: received !== null && Number.isSafeInteger(received) ? received : null, labels: [...new Set(m.labelIds)], open: { available: gmailThreadUrl(m.threadId, identity.email) !== null, reason: gmailThreadUrl(m.threadId, identity.email) ? null : 'unsupportedDestination' as const } }
        }))
        if (!current(epoch, identity.subject)) return cancelled(epoch, identity.subject)
        for (const result of batch) { if (result.status === 'rejected') throw result.reason; if (result.value) messages.push(result.value) }
      }
      if (current(epoch, identity.subject)) last = { connectionId: ctx.id, account: { email: identity.email, color: normalizeColor(ctx.fields.color) }, messages, loadedCount: messages.length, estimatedUnreadCount: estimated, truncated, updatedAt: now(), checkedAt: now(), freshness: 'fresh', error: null }
    } catch (error) { if (current(epoch, identity.subject)) last = stale(googleFailure(error)); else cancelled(epoch, identity.subject) }
    return last
  }
  return {
    channel: ctx.channel, get intervalMs() { return last.error ? 30000 : 60000 },
    poll() { if (!inflight) { const p = refresh(); inflight = p; void p.finally(() => { if (inflight === p) inflight = undefined }) } return inflight },
    stop() { generation++; inflight = undefined; last = stale('offline') },
    commands: { open: async (payload, context) => {
      const request = z.object({ connectionId: z.literal(ctx.id), messageId: GoogleResourceId, instanceId: z.string().min(1).max(200).optional() }).strict().safeParse(payload)
      if (!context?.loopback || !request.success || !last.messages?.some(m => m.id === request.data.messageId)) return { ok: false, error: 'refused' }
      if (last.freshness !== 'fresh' || last.updatedAt === null || now() - last.updatedAt > GOOGLE_ACTION_MAX_AGE_MS || ctx.account.signal.aborted || client.identity()?.subject !== marker || !client.identity()?.services.includes('gmail')) return { ok: false, error: 'unavailable', reason: 'stale' }
      const epoch = generation, snapshot = last, subject = marker
      const message = snapshot.messages!.find(m => m.id === request.data.messageId)!
      if (!subject || !message.open.available) return { ok: false, error: 'unavailable', reason: message.open.reason }
      try {
        const raw = messageSchema.parse(await client.get('gmail', '/users/me/messages/' + encodeURIComponent(message.id), { format: 'metadata', fields: 'id,threadId,labelIds' }))
        if (raw.id !== message.id || raw.threadId !== message.threadId) return { ok: false, error: 'unavailable' }
        const destination = gmailThreadUrl(raw.threadId, client.identity()?.email)
        if (!destination || !current(epoch, subject) || last !== snapshot || now() - snapshot.updatedAt! > GOOGLE_ACTION_MAX_AGE_MS) return { ok: false, error: 'unavailable' }
        await (deps.openUrl ?? openGoogleUrl)(destination)
        return { ok: true }
      } catch (error) { return { ok: false, error: googleFailure(error) } }
    } },
  }
}
