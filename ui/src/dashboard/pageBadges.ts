import { channelAllowed, type Page, type WidgetManifest } from '../shared/types'
export type BadgeKind = 'claude' | 'github' | 'gmail'
export interface BadgeSource { channel: string; kind: BadgeKind }
export interface PageBadge { count: number; lowerBound: boolean; unavailable: boolean; kinds: BadgeKind[] }
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)

/** One provider subscription per selected source, even with duplicate widgets. */
export function badgeSources(page: Page, manifests: Record<string, WidgetManifest>): BadgeSource[] {
  const sources = new Map<string, BadgeSource>()
  for (const widget of page.widgets) {
    const m = manifests[widget.widgetId]
    if (!m) continue
    const add = (channel: string, kind: BadgeKind) => {
      if (channelAllowed(m.subscriptions ?? [], channel)) sources.set(channel, { channel, kind })
    }
    if (widget.widgetId === 'claude-sessions') add('claude-sessions', 'claude')
    if (widget.widgetId === 'github-inbox' && validId(widget.settings.connection)) add('github:' + widget.settings.connection, 'github')
    if (widget.widgetId === 'gmail-inbox' && Array.isArray(widget.settings.accounts)) {
      for (const id of widget.settings.accounts.slice(0, 50)) if (validId(id)) add('gmail:' + id, 'gmail')
    }
  }
  return [...sources.values()]
}
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
function ids(rows: unknown[], key: string): number {
  return new Set(rows.map(row => record(row)?.[key]).filter(id => typeof id === 'string' && id.length > 0)).size
}

/** Count observed rows, never estimates or inferred Codex activity. Unavailable is not zero. */
export function pageBadge(sources: BadgeSource[], snapshots: Record<string, unknown>, now: number): PageBadge | undefined {
  if (!sources.length) return undefined
  let count = 0, lowerBound = false, unavailable = false
  for (const { channel, kind } of sources) {
    const data = record(snapshots[channel])
    if (!data || data.error) { unavailable = true; continue }
    if (kind === 'claude') {
      if (!Array.isArray(data.sessions)) { unavailable = true; continue }
      count += ids(data.sessions.filter(s => { const session = record(s); return session?.state === 'permission' || session?.state === 'error' || !!record(session?.question) }), 'sessionId')
    } else if (kind === 'github') {
      if (!Array.isArray(data.notifications) || record(data.errors)?.notifications) { unavailable = true; continue }
      const n = ids(data.notifications, 'id'); count += n; lowerBound ||= n >= 50
    } else {
      if (data.connectionId !== channel.slice('gmail:'.length) || data.freshness !== 'fresh' || typeof data.updatedAt !== 'number' || !Number.isFinite(data.updatedAt) || now < data.updatedAt || now - data.updatedAt > 120000 || !Array.isArray(data.messages)) { unavailable = true; continue }
      count += ids(data.messages, 'id'); lowerBound ||= data.truncated === true
    }
  }
  if (count === 0 && !unavailable) return undefined
  return { count, lowerBound: lowerBound || unavailable, unavailable, kinds: [...new Set(sources.map(s => s.kind))] }
}
