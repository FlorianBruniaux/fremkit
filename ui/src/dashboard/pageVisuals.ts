import type { Page, WidgetManifest } from '../shared/types'
import { DEFAULT_ICON } from '../shared/icons'

interface Visual { icon: string; color?: string; group: string }
// Resolve from widget content, so renamed pages retain their visual identity. No user IDs.
function visual(page: Page, manifests: Record<string, WidgetManifest>): Visual {
  for (const widget of page.widgets) {
    const id = widget.widgetId
    if (id.startsWith('claude-')) return { icon: 'claude', color: '#d97757', group: 'ai' }
    if (id.startsWith('codex-')) return { icon: 'code', color: '#45bd9f', group: 'ai' }
    if (id === 'youtube-control') return { icon: 'play', color: '#ff4545', group: 'media' }
    if (id === 'local-models') return { icon: 'brain', color: '#b595ec', group: 'ai' }
    if (id.startsWith('github-')) return { icon: 'github', group: 'dev' }
    if (id.startsWith('docker-')) return { icon: 'container', color: '#52b6ed', group: 'dev' }
    if (id === 'google-tasks') return { icon: 'list', color: '#4285f4', group: 'daily' }
    if (id.startsWith('gmail-') || id.startsWith('google-')) return { icon: 'mail', color: '#72a4fa', group: 'daily' }
    if (['cpu', 'memory', 'disk', 'network', 'processes'].includes(id)) return { icon: 'cpu', color: '#69c8b6', group: 'system' }
    if (['clipboard', 'calendar'].includes(id)) return { icon: 'monitor', color: '#e0b76d', group: 'daily' }
  }
  const manifest = page.widgets.map(w => manifests[w.widgetId]).find(Boolean)
  return { icon: manifest?.icon ?? DEFAULT_ICON, group: manifest?.category ?? 'other' }
}

/** Decorative group boundaries never reorder pages or alter their selection indices. */
export function pageVisuals(pages: Page[], manifests: Record<string, WidgetManifest>) {
  const visuals = pages.map(page => visual(page, manifests))
  return visuals.map((v, i) => ({ ...v, divider: i > 0 && visuals[i - 1]?.group !== v.group }))
}
