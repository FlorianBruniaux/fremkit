import { z } from 'zod'
import { normalizeColor } from './calendar.js'
import { openGoogleUrl } from './google-links.js'
import { googleFailure, GOOGLE_ACTION_MAX_AGE_MS, type GoogleFailure, type Freshness, type GoogleAction } from './gmail.js'
import { createGoogleClient, type GoogleApiClient } from '../connections/google-client.js'
import type { ConnectionServiceContext } from '../connections/types.js'
import type { Provider } from './types.js'

const resourceId = z.string().regex(/^[A-Za-z0-9_@.+~!=\-]{1,512}$/).refine(s => s !== '.' && s !== '..')
const pageToken = z.string().min(1).max(2048).optional()
const taskSchema = z.object({ id: resourceId, title: z.string().max(1024).default(''), status: z.enum(['needsAction', 'completed']), parent: resourceId.optional(), position: z.string().max(256).optional(), due: z.string().datetime({ offset: true }).optional(), completed: z.string().datetime({ offset: true }).optional(), notes: z.string().max(8192).optional(), deleted: z.boolean().optional(), webViewLink: z.string().max(8192).optional() })
const listPage = z.object({ items: z.array(z.object({ id: resourceId, title: z.string().max(1024).default('') })).max(50).default([]), nextPageToken: pageToken })
const tasksPage = z.object({ items: z.array(taskSchema).max(100).default([]), nextPageToken: pageToken })
export interface GoogleTask { id: string; title: string; status: 'needsAction' | 'completed'; parent: string | null; position: string; dueDate: string | null; completed: string | null; notes: string | null; open: GoogleAction }
export interface GoogleTaskList { id: string; title: string; tasks: GoogleTask[] | null; truncated: boolean; updatedAt: number | null; freshness: Freshness; error: GoogleFailure | null }
export interface GoogleTasksSnapshot { connectionId: string; account: { email: string; color: string } | null; lists: GoogleTaskList[] | null; truncated: boolean; updatedAt: number | null; checkedAt: number | null; freshness: Freshness; error: GoogleFailure | null }
export interface GoogleTasksDeps { client?: GoogleApiClient; now?: () => number; openUrl?: (url: string) => Promise<void> }

/** Only Google-supplied Tasks UI links, with the intended account email. */
export function googleTaskUrl(raw: string | undefined, email: string): string | null {
  if (!raw || /[\x00-\x20\x7f]/.test(raw)) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null
    if (u.hostname !== 'tasks.google.com' && !(u.hostname === 'calendar.google.com' && /^\/calendar(?:\/u\/\d+)?\/r\/tasks(?:\/|$)/.test(u.pathname))) return null
    // An account index in the path must not override the verified email.
    if (u.hostname === 'calendar.google.com') u.pathname = u.pathname.replace(/^\/calendar\/u\/\d+\/r\/tasks/, '/calendar/r/tasks')
    else u.pathname = u.pathname.replace(/^\/u\/\d+(?=\/|$)/, '') || '/'
    u.searchParams.set('authuser', email)
    return u.href
  } catch { return null }
}
export function createGoogleTasksProvider(ctx: ConnectionServiceContext, deps: GoogleTasksDeps = {}): Provider<GoogleTasksSnapshot> {
  const client = deps.client ?? createGoogleClient(ctx), now = deps.now ?? Date.now
  const empty = (): GoogleTasksSnapshot => ({ connectionId: ctx.id, account: null, lists: null, truncated: false, updatedAt: null, checkedAt: null, freshness: 'unavailable', error: 'unconfigured' })
  let last = empty(), marker: string | undefined, generation = 0, inflight: Promise<GoogleTasksSnapshot> | undefined
  const current = (epoch: number, subject: string) => epoch === generation && !ctx.account.signal.aborted && client.identity()?.subject === subject && !!client.identity()?.services.includes('tasks')
  const staleList = (l: GoogleTaskList, error: GoogleFailure): GoogleTaskList => ({ ...l, error, freshness: l.tasks === null ? 'unavailable' : 'stale', tasks: l.tasks?.map(t => ({ ...t, open: { available: false, reason: 'stale' } })) ?? null })
  const stale = (error: GoogleFailure): GoogleTasksSnapshot => ({ ...last, error, checkedAt: now(), freshness: last.lists === null ? 'unavailable' : 'stale', lists: last.lists?.map(l => staleList(l, error)) ?? null })
  function cancelled(epoch: number, subject: string) {
    if (epoch === generation) {
      const identity = client.identity()
      if (identity && identity.subject !== subject) { last = empty(); marker = identity.subject }
      else last = stale(ctx.account.signal.aborted || !identity ? 'unauthorized' : 'forbidden')
    }
    return last
  }
  async function readList(id: string, title: string, epoch: number, subject: string, email: string): Promise<GoogleTaskList> {
    const tasks = new Map<string, GoogleTask>(), tokens = new Set<string>(); let token: string | undefined, truncated = false
    try {
      for (let page = 0; page < 3; page++) {
        if (!current(epoch, subject)) throw { code: 'unauthorized' }
        const raw = tasksPage.parse(await client.get('tasks', '/lists/' + encodeURIComponent(id) + '/tasks', { maxResults: '100', showCompleted: 'true', showHidden: 'true', showDeleted: 'false', showAssigned: 'true', fields: 'items(id,title,status,parent,position,due,completed,notes,deleted,webViewLink),nextPageToken', ...(token ? { pageToken: token } : {}) }))
        if (!current(epoch, subject)) throw { code: 'unauthorized' }
        for (const task of raw.items) {
          if (task.deleted) continue
          tasks.set(task.id, { id: task.id, title: task.title, status: task.status, parent: task.parent ?? null, position: task.position ?? '', dueDate: task.due?.slice(0, 10) ?? null, completed: task.completed ?? null, notes: task.notes ?? null, open: { available: googleTaskUrl(task.webViewLink, email) !== null, reason: googleTaskUrl(task.webViewLink, email) ? null : 'unsupportedDestination' } })
        }
        token = raw.nextPageToken
        if (!token) break
        if (tokens.has(token) || page === 2) { truncated = true; break }
        tokens.add(token)
      }
      return { id, title, tasks: [...tasks.values()].sort((a, b) => a.position.localeCompare(b.position) || a.id.localeCompare(b.id)), truncated, updatedAt: now(), freshness: 'fresh', error: null }
    } catch (error) {
      const previous = last.lists?.find(l => l.id === id)
      return staleList(previous ? { ...previous, title } : { id, title, tasks: null, truncated: false, updatedAt: null, freshness: 'unavailable', error: null }, googleFailure(error))
    }
  }
  async function refresh(): Promise<GoogleTasksSnapshot> {
    const epoch = generation, identity = client.identity()
    if (identity && marker !== identity.subject) { last = empty(); marker = identity.subject }
    if (!identity || ctx.account.signal.aborted) { last = stale(ctx.account.signal.aborted ? 'unauthorized' : 'unconfigured'); return last }
    last = { ...last, account: { email: identity.email, color: normalizeColor(ctx.fields.color) } }
    if (!identity.services.includes('tasks')) { last = stale('forbidden'); return last }
    try {
      const chosen = new Map<string, string>(), tokens = new Set<string>(); let token: string | undefined, truncated = false
      for (let page = 0; page < 2; page++) {
        if (!current(epoch, identity.subject)) return cancelled(epoch, identity.subject)
        const raw = listPage.parse(await client.get('tasks', '/users/@me/lists', { maxResults: '50', fields: 'items(id,title),nextPageToken', ...(token ? { pageToken: token } : {}) }))
        if (!current(epoch, identity.subject)) return cancelled(epoch, identity.subject)
        for (const l of raw.items) { if (chosen.size < 50 || chosen.has(l.id)) chosen.set(l.id, l.title); else truncated = true }
        token = raw.nextPageToken
        if (!token) break
        if (tokens.has(token) || chosen.size >= 50 || page === 1) { truncated = true; break }
        tokens.add(token)
      }
      const entries = [...chosen], lists: GoogleTaskList[] = []
      // Four concurrent lists, at most fifty lists and three task pages per list.
      for (let i = 0; i < entries.length; i += 4) {
        if (!current(epoch, identity.subject)) return cancelled(epoch, identity.subject)
        lists.push(...await Promise.all(entries.slice(i, i + 4).map(([id, title]) => readList(id, title, epoch, identity.subject, identity.email))))
        if (!current(epoch, identity.subject)) return cancelled(epoch, identity.subject)
      }
      last = { connectionId: ctx.id, account: { email: identity.email, color: normalizeColor(ctx.fields.color) }, lists, truncated, updatedAt: now(), checkedAt: now(), freshness: 'fresh', error: null }
    } catch (error) { if (current(epoch, identity.subject)) last = stale(googleFailure(error)); else cancelled(epoch, identity.subject) }
    return last
  }
  return {
    channel: ctx.channel, get intervalMs() { return last.error || last.lists?.some(l => l.error) ? 30000 : 60000 },
    poll() { if (!inflight) { const p = refresh(); inflight = p; void p.finally(() => { if (inflight === p) inflight = undefined }) } return inflight },
    stop() { generation++; inflight = undefined; last = stale('offline') },
    commands: { open: async (payload, context) => {
      const request = z.object({ connectionId: z.literal(ctx.id), listId: resourceId, taskId: resourceId, instanceId: z.string().min(1).max(200).optional() }).strict().safeParse(payload)
      if (!context?.loopback || !request.success) return { ok: false, error: 'refused' }
      const { listId, taskId } = request.data, list = last.lists?.find(l => l.id === listId), task = list?.tasks?.find(t => t.id === taskId), subject = marker, epoch = generation
      if (!list || !task) return { ok: false, error: 'refused' }
      if (!subject || !current(epoch, subject) || last.freshness !== 'fresh' || list.freshness !== 'fresh' || list.updatedAt === null || now() - list.updatedAt > GOOGLE_ACTION_MAX_AGE_MS || !task.open.available) return { ok: false, error: 'unavailable' }
      const snapshot = last
      try {
        const raw = taskSchema.parse(await client.get('tasks', '/lists/' + encodeURIComponent(listId) + '/tasks/' + encodeURIComponent(taskId), { fields: 'id,title,status,deleted,webViewLink' }))
        const destination = googleTaskUrl(raw.webViewLink, client.identity()?.email ?? '')
        if (raw.id !== taskId || raw.deleted || !destination || !current(epoch, subject) || last !== snapshot || now() - list.updatedAt > GOOGLE_ACTION_MAX_AGE_MS) return { ok: false, error: 'unavailable' }
        await (deps.openUrl ?? openGoogleUrl)(destination)
        return { ok: true }
      } catch (error) { return { ok: false, error: googleFailure(error) } }
    } },
  }
}
