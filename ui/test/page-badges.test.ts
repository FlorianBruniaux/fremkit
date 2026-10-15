import { describe, expect, it } from 'vitest'
import { badgeSources, pageBadge } from '../src/dashboard/pageBadges'
import { pageVisuals } from '../src/dashboard/pageVisuals'
import type { Page, WidgetManifest } from '../src/shared/types'

const instance = (widgetId: string, settings: Record<string, unknown> = {}) => ({
  instanceId: widgetId, widgetId, x: 0, y: 0, w: 1, h: 1, showTitle: true, settings,
})
const manifest = (subscriptions: string[]) => ({ subscriptions }) as WidgetManifest

describe('page attention badges', () => {
  it('subscribes only to channels permitted by the widget manifest and deduplicates duplicates', () => {
    const page: Page = { id: 'work', name: 'Work', widgets: [
      instance('github-inbox', { connection: 'github-one' }),
      instance('github-inbox', { connection: 'github-one' }),
      instance('gmail-inbox', { accounts: ['one', 'two'] }),
    ] }
    const sources = badgeSources(page, {
      'github-inbox': manifest(['github:*']),
      'gmail-inbox': manifest(['gmail:one']),
    })
    expect(sources).toEqual([
      { channel: 'github:github-one', kind: 'github' },
      { channel: 'gmail:one', kind: 'gmail' },
    ])
  })

  it('counts observed rows and labels partial or stale data without showing a false zero', () => {
    const sources = [
      { channel: 'github:one', kind: 'github' as const },
      { channel: 'gmail:two', kind: 'gmail' as const },
    ]
    const at = 100_000
    const snapshots = {
      'github:one': { notifications: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] },
      'gmail:two': { connectionId: 'two', messages: [{ id: 'm' }], freshness: 'stale', updatedAt: at },
    }
    expect(pageBadge(sources, snapshots, at)).toEqual({
      count: 2, lowerBound: true, unavailable: true, kinds: ['github', 'gmail'],
    })
    expect(pageBadge([{ channel: 'gmail:two', kind: 'gmail' }], snapshots, at)?.unavailable).toBe(true)
    expect(pageBadge([{ channel: 'github:one', kind: 'github' }], { 'github:one': { notifications: [] } }, at)).toBeUndefined()
  })

  it('keeps renamed page order while deriving service icons and group dividers', () => {
    const pages: Page[] = [
      { id: 'a', name: 'My chats', widgets: [instance('claude-sessions')] },
      { id: 'b', name: 'Coding', widgets: [instance('codex-sessions')] },
      { id: 'c', name: 'Mail', widgets: [instance('gmail-inbox')] },
    ]
    expect(pageVisuals(pages, {})).toMatchObject([
      { icon: 'claude', divider: false },
      { icon: 'code', divider: false },
      { icon: 'mail', divider: true },
    ])
  })
})
