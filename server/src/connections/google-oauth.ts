import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { z } from 'zod'
import { GOOGLE_SCOPES, GoogleClientError, googleJson, googleTokenSchema, grantedGoogleServices, parseGoogleServices, type GoogleCredentials, type GoogleDisconnected, type GoogleNetworkDeps, type GoogleService } from './google-client.js'

export type GoogleOAuthError = 'invalidState' | 'refused' | 'workspacePolicy' | 'accountMismatch' | 'cancelled' | 'replaced' | 'timeout' | 'partial' | 'unconfigured' | 'unauthorized' | 'forbidden' | 'offline' | 'rateLimited' | 'malformed'
export interface GoogleOAuthStatus { state: 'disconnected' | 'pending' | 'connected' | 'partial' | 'error'; error?: GoogleOAuthError; email?: string; services?: GoogleService[] }
export interface GoogleOAuthDeps extends GoogleNetworkDeps { openBrowser?: (url: string) => Promise<void> }
interface Attempt { server: Server; abort: AbortController; timer?: ReturnType<typeof setTimeout>; status: GoogleOAuthStatus; consumed: boolean }
const userinfoSchema = z.object({ sub: z.string().min(1).max(255), email: z.string().email().max(320), email_verified: z.literal(true) })
const openBrowser = (url: string): Promise<void> => new Promise((resolve, reject) => {
  execFile('/usr/bin/open', [url], { shell: false, timeout: 15000 }, error => error ? reject(new GoogleClientError('offline')) : resolve())
})

/** Each browser consent has its own short-lived loopback listener and one-use state. */
export class GoogleOAuthBroker {
  private attempts = new Map<string, Attempt>()
  private exchanges = new Set<Promise<void>>()
  constructor(private readonly deps: GoogleOAuthDeps = {}) {}
  status(id: string): GoogleOAuthStatus { return { ...(this.attempts.get(id)?.status ?? { state: 'disconnected' }) } }
  private release(attempt: Attempt): void {
    clearTimeout(attempt.timer)
    attempt.abort.abort()
    attempt.server.close()
    attempt.server.closeAllConnections()
  }
  cancel(id: string, reason: 'cancelled' | 'replaced' = 'cancelled'): void {
    const attempt = this.attempts.get(id)
    if (!attempt || attempt.status.state !== 'pending') return
    attempt.status = { state: 'error', error: reason }
    this.release(attempt)
  }
  forget(id: string): void { this.cancel(id); this.attempts.delete(id) }
  async close(): Promise<void> {
    for (const id of this.attempts.keys()) this.cancel(id)
    await Promise.allSettled(this.exchanges)
    this.attempts.clear()
  }

  async start(id: string, fields: Record<string,string>, previous: GoogleCredentials | GoogleDisconnected | null, clientSecret: string | undefined,
    commit: (bundle: GoogleCredentials, isAttemptCurrent: () => boolean) => Promise<void>, isCurrent: () => boolean): Promise<GoogleOAuthStatus> {
    if (!/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(fields.clientId ?? '')) throw new GoogleClientError('malformed')
    if (clientSecret && (clientSecret.length > 16384 || /[\x00-\x1f]/.test(clientSecret))) throw new GoogleClientError('malformed')
    const selected = parseGoogleServices(fields.services)
    this.cancel(id)
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const scopes = ['openid', 'email', ...selected.flatMap(service => GOOGLE_SCOPES[service])]
    let redirect = ''
    const server = createServer((request, response) => {
      // No logger, external subresources, echoed callback parameters or reflected provider errors.
      response.setHeader('Content-Type', 'text/plain; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
      response.setHeader('Referrer-Policy', 'no-referrer')
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.setHeader('Connection', 'close')
      const answer = (status: number) => { response.statusCode = status; response.end('Return to Fremkit to check the account status.') }
      if (request.method !== 'GET' || request.headers.host !== new URL(redirect).host || !request.url?.startsWith('/oauth2/callback?')) { answer(400); return }
      let callback: URL
      try { callback = new URL(request.url, redirect) } catch { answer(400); return }
      if (callback.origin !== new URL(redirect).origin || callback.pathname !== '/oauth2/callback' || attempt.consumed || attempt.status.state !== 'pending') { answer(400); return }
      const received = callback.searchParams.get('state') ?? ''
      if (callback.searchParams.getAll('state').length !== 1 || Buffer.byteLength(received) !== Buffer.byteLength(state) || !timingSafeEqual(Buffer.from(received), Buffer.from(state))) {
        attempt.status = { state: 'error', error: 'invalidState' }; answer(400); response.once('finish', () => this.release(attempt)); return
      }
      attempt.consumed = true
      const error = callback.searchParams.get('error')
      if (error) {
        attempt.status = { state: 'error', error: error === 'admin_policy_enforced' || error === 'org_internal' ? 'workspacePolicy' : 'refused' }
        answer(200); response.once('finish', () => this.release(attempt)); return
      }
      const code = callback.searchParams.get('code')
      if (!code || callback.searchParams.getAll('code').length !== 1 || code.length > 8192) {
        attempt.status = { state: 'error', error: 'malformed' }; answer(400); response.once('finish', () => this.release(attempt)); return
      }
      answer(200)
      // Stop accepting immediately; keep the exchange deadline until commit completes.
      server.close()
      const running = exchange(code)
      this.exchanges.add(running)
      void running.finally(() => this.exchanges.delete(running))
    })
    server.requestTimeout = 10000
    server.headersTimeout = 10000
    server.maxHeadersCount = 32
    const attempt: Attempt = { server, abort: new AbortController(), status: { state: 'pending' }, consumed: false }
    this.attempts.set(id, attempt)
    const isAttemptCurrent = () => !attempt.abort.signal.aborted && this.attempts.get(id) === attempt
    const live = () => isAttemptCurrent() && isCurrent()
    const exchange = async (code: string) => {
      try {
        const body = new URLSearchParams({ client_id: fields.clientId, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect })
        const secret = clientSecret || (previous?.clientId === fields.clientId && 'clientSecret' in previous ? previous.clientSecret : undefined)
        if (secret) body.set('client_secret', secret)
        const parsed = googleTokenSchema.safeParse(await googleJson('https://oauth2.googleapis.com/token', { method: 'POST', body }, this.deps, attempt.abort.signal))
        if (!parsed.success || parsed.data.scope === undefined) throw new GoogleClientError('malformed')
        const token = parsed.data
        if (!live()) return
        const identity = userinfoSchema.safeParse(await googleJson('https://openidconnect.googleapis.com/v1/userinfo', { method: 'GET', headers: { Authorization: 'Bearer ' + token.access_token } }, this.deps, attempt.abort.signal))
        if (!identity.success) throw new GoogleClientError('malformed')
        if (previous && identity.data.sub !== previous.subject) throw new Error('accountMismatch')
        const refreshToken = token.refresh_token ?? (previous?.clientId === fields.clientId && 'refreshToken' in previous ? previous.refreshToken : undefined)
        if (!refreshToken) throw new GoogleClientError('unauthorized')
        const bundle: GoogleCredentials = { version: 1, clientId: fields.clientId, ...(secret ? { clientSecret: secret } : {}), accessToken: token.access_token, refreshToken, expiresAt: (this.deps.now ?? Date.now)() + token.expires_in * 1000, subject: identity.data.sub, email: identity.data.email, scopes: token.scope!.split(/\s+/).filter(Boolean) }
        if (!live()) return
        await commit(bundle, isAttemptCurrent)
        if (attempt.abort.signal.aborted || this.attempts.get(id) !== attempt) return
        const services = grantedGoogleServices(bundle, selected)
        attempt.status = { state: services.length === selected.length ? 'connected' : 'partial', email: bundle.email, services, ...(services.length === selected.length ? {} : { error: 'partial' as const }) }
      } catch (error) {
        if (attempt.abort.signal.aborted || this.attempts.get(id) !== attempt) return
        attempt.status = { state: 'error', error: error instanceof GoogleClientError ? error.code : error instanceof Error && error.message === 'accountMismatch' ? 'accountMismatch' : 'replaced' }
      } finally { this.release(attempt) }
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(new GoogleClientError('unauthorized'))
        attempt.abort.signal.addEventListener('abort', aborted, { once: true })
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          attempt.abort.signal.removeEventListener('abort', aborted)
          resolve()
        })
      })
      if (!live()) { this.release(attempt); return this.status(id) }
      const address = server.address()
      if (!address || typeof address === 'string') throw new GoogleClientError('offline')
      redirect = `http://127.0.0.1:${address.port}/oauth2/callback`
      attempt.timer = setTimeout(() => {
        attempt.status = { state: 'error', error: 'timeout' }; this.release(attempt)
      }, this.deps.timeoutMs ?? 5 * 60 * 1000)
      attempt.timer.unref()
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      for (const [key, value] of Object.entries({ client_id: fields.clientId, redirect_uri: redirect, response_type: 'code', scope: scopes.join(' '), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent select_account' })) auth.searchParams.set(key, value)
      if (previous) auth.searchParams.set('login_hint', previous.email)
      if (!live()) { this.cancel(id, 'replaced'); return this.status(id) }
      await (this.deps.openBrowser ?? openBrowser)(auth.href)
      return this.status(id)
    } catch {
      if (!attempt.abort.signal.aborted) attempt.status = { state: 'error', error: 'offline' }
      this.release(attempt); return this.status(id)
    }
  }
}
