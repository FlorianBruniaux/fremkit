import { z } from 'zod'
import { readJsonCapped } from '../net/json.js'
import type { ConnectionCredentials, ConnectionServiceContext } from './types.js'

export type GoogleService = 'gmail' | 'calendar' | 'tasks'
export interface GoogleIdentity { subject: string; email: string; services: GoogleService[] }
export interface GoogleCredentials {
  version: 1; clientId: string; clientSecret?: string; accessToken: string; refreshToken: string
  expiresAt: number; subject: string; email: string; scopes: string[]
}
export const GOOGLE_SCOPES: Record<GoogleService, string[]> = {
  gmail: ['https://www.googleapis.com/auth/gmail.metadata'],
  tasks: ['https://www.googleapis.com/auth/tasks.readonly'],
  calendar: ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly'],
}
export class GoogleClientError extends Error {
  constructor(readonly code: 'unconfigured' | 'unauthorized' | 'forbidden' | 'offline' | 'timeout' | 'rateLimited' | 'malformed') { super(code); this.name = 'GoogleClientError' }
}
export interface GoogleApiClient {
  identity(): GoogleIdentity | null
  get(service: GoogleService, path: string, query?: Record<string, string | string[]>): Promise<unknown>
}
export interface GoogleNetworkDeps { fetch?: typeof fetch; now?: () => number; timeoutMs?: number }
const nonempty = z.string().min(1).max(16384)
const credentialSchema = z.object({
  version: z.literal(1), clientId: z.string().regex(/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/),
  clientSecret: nonempty.optional(), accessToken: nonempty, refreshToken: nonempty,
  expiresAt: z.number().finite().nonnegative(), subject: z.string().min(1).max(255), email: z.string().email().max(320),
  scopes: z.array(z.string().min(1).max(256)).max(100),
})
export function parseGoogleCredentials(raw: string | undefined): GoogleCredentials | null {
  if (!raw || raw.length > 65536) return null
  try { const parsed = credentialSchema.safeParse(JSON.parse(raw)); return parsed.success ? parsed.data : null } catch { return null }
}
/** A disconnected account retains identity only, never an API credential. */
export interface GoogleDisconnected {
  version: 1; disconnected: true; clientId: string; subject: string; email: string
}
const disconnectedSchema = credentialSchema.pick({ version: true, clientId: true, subject: true, email: true })
  .extend({ disconnected: z.literal(true) }).strict()
export function parseGoogleBinding(raw: string | undefined): GoogleCredentials | GoogleDisconnected | null {
  const credentials = parseGoogleCredentials(raw)
  if (credentials) return credentials
  if (!raw || raw.length > 65536) return null
  try { const parsed = disconnectedSchema.safeParse(JSON.parse(raw)); return parsed.success ? parsed.data : null } catch { return null }
}
function list(raw: string | undefined, fallback: string): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? fallback)
    if (!Array.isArray(value) || value.length > 50 || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 1024 || /[\x00-\x1f\x7f]/.test(v)) || new Set(value).size !== value.length) throw new Error()
    return value as string[]
  } catch { throw new GoogleClientError('malformed') }
}
export function parseGoogleServices(raw: string | undefined): GoogleService[] {
  const services = list(raw, '[]')
  if (!services.length || services.some(s => s !== 'gmail' && s !== 'calendar' && s !== 'tasks')) throw new GoogleClientError('malformed')
  return services as GoogleService[]
}
export function parseCalendarIds(raw: string | undefined): string[] { return list(raw, '[]') }
export function grantedGoogleServices(bundle: GoogleCredentials, selected: GoogleService[]): GoogleService[] {
  return selected.filter(service => GOOGLE_SCOPES[service].every(scope => bundle.scopes.includes(scope)))
}

/** Bounded body, deadline and no redirect forwarding. Errors never include remote text or URLs. */
export async function googleJson(url: string, init: RequestInit, deps: GoogleNetworkDeps = {}, signal?: AbortSignal): Promise<unknown> {
  const deadline = AbortSignal.timeout(deps.timeoutMs ?? 15000)
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
  try {
    const response = await (deps.fetch ?? fetch)(url, { ...init, redirect: 'error', signal: combined })
    const body = await readJsonCapped(response, 2 * 1024 * 1024).catch(() => { throw new GoogleClientError('malformed') })
    if (!response.ok) {
      const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
      if (response.status === 401 || error === 'invalid_grant') throw new GoogleClientError('unauthorized')
      if (response.status === 403) throw new GoogleClientError('forbidden')
      if (response.status === 429) throw new GoogleClientError('rateLimited')
      throw new GoogleClientError(response.status >= 500 ? 'offline' : 'malformed')
    }
    return body
  } catch (error) {
    if (signal?.aborted) throw new GoogleClientError('unauthorized')
    if (deadline.aborted) throw new GoogleClientError('timeout')
    if (error instanceof GoogleClientError) throw error
    throw new GoogleClientError('offline')
  }
}
export const googleTokenSchema = z.object({ access_token: nonempty, refresh_token: nonempty.optional(), token_type: z.literal('Bearer'), expires_in: z.number().positive().max(86400), scope: z.string().max(32768).optional() })

function apiUrl(service: GoogleService, path: string, query: Record<string, string | string[]>): string {
  const id = '(?:[a-zA-Z0-9_@.+~!-]|%[0-9a-fA-F]{2})+'
  const taskId = '(?:[a-zA-Z0-9_@.+~!=-]|%[0-9a-fA-F]{2})+'
  const valid = service === 'tasks' ? new RegExp('^(?:/users/@me/lists|/lists/' + taskId + '/tasks(?:/' + taskId + ')?)$') : service === 'gmail' ? new RegExp('^/users/me/messages(?:/' + id + ')?$') : new RegExp('^(?:/users/me/calendarList|/calendars/' + id + '/events(?:/' + id + ')?)$')
  if (!valid.test(path) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(decodeURIComponent(path))) throw new GoogleClientError('malformed')
  const base = service === 'tasks' ? 'https://tasks.googleapis.com/tasks/v1' : service === 'gmail' ? 'https://gmail.googleapis.com/gmail/v1' : 'https://www.googleapis.com/calendar/v3'
  const url = new URL(base + path)
  for (const [key, values] of Object.entries(query)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key) || key === 'access_token' || key === 'key' || key === 'oauth_token') throw new GoogleClientError('malformed')
    for (const value of Array.isArray(values) ? values : [values]) url.searchParams.append(key, value)
  }
  return url.href
}
export function createGoogleClient(ctx: ConnectionServiceContext, input?: unknown): GoogleApiClient {
  const deps = (input ?? {}) as GoogleNetworkDeps
  const now = deps.now ?? Date.now
  const read = (secrets: Readonly<Record<string, string>>) => {
    const bundle = parseGoogleCredentials(secrets.credentials)
    if (!bundle || bundle.clientId !== ctx.fields.clientId) throw new GoogleClientError('unconfigured')
    return bundle
  }
  const identity = (): GoogleIdentity | null => {
    try { const b = read(ctx.secrets); return { subject: b.subject, email: b.email, services: grantedGoogleServices(b, parseGoogleServices(ctx.fields.services)) } } catch { return null }
  }
  const refresh = async (snapshot: ConnectionCredentials) => ctx.account.refresh(snapshot.revision, async (current, signal) => {
    const b = read(current.secrets)
    const body = new URLSearchParams({ client_id: b.clientId, refresh_token: b.refreshToken, grant_type: 'refresh_token' })
    if (b.clientSecret) body.set('client_secret', b.clientSecret)
    const parsed = googleTokenSchema.safeParse(await googleJson('https://oauth2.googleapis.com/token', { method: 'POST', body }, deps, signal))
    if (!parsed.success) throw new GoogleClientError('malformed')
    const r = parsed.data
    const replacement: GoogleCredentials = { ...b, accessToken: r.access_token, refreshToken: r.refresh_token ?? b.refreshToken, expiresAt: now() + r.expires_in * 1000, scopes: r.scope === undefined ? b.scopes : r.scope.split(/\s+/).filter(Boolean) }
    return { credentials: JSON.stringify(replacement) }
  })
  return {
    identity,
    async get(service, path, query = {}) {
      const url = apiUrl(service, path, query)
      try {
        return await ctx.account.request(async (initial, signal) => {
          const check = (snapshot: ConnectionCredentials) => {
            const b = read(snapshot.secrets)
            if (!grantedGoogleServices(b, parseGoogleServices(ctx.fields.services)).includes(service)) throw new GoogleClientError('forbidden')
            return b
          }
          let snapshot = initial
          let b = check(snapshot)
          let refreshed = false
          if (b.expiresAt <= now() + 30000) { snapshot = await refresh(snapshot); b = check(snapshot); refreshed = true }
          const send = () => googleJson(url, { method: 'GET', headers: { Authorization: 'Bearer ' + b.accessToken } }, deps, signal)
          try { return await send() } catch (error) {
            if (!(error instanceof GoogleClientError) || error.code !== 'unauthorized' || refreshed) throw error
            snapshot = await refresh(snapshot); b = check(snapshot)
            return send()
          }
        })
      } catch (error) {
        if (error instanceof GoogleClientError) throw error
        throw new GoogleClientError(ctx.account.signal.aborted ? 'unauthorized' : 'offline')
      }
    },
  }
}
