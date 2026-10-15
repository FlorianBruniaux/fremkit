import { computed, onUnmounted, ref, watch } from 'vue'
import type { Page, WidgetManifest } from '../shared/types'
import type { Socket } from '../shared/socket'
import { badgeSources, pageBadge, type PageBadge } from './pageBadges'

/** Reuses the host socket and authorized widget selections; no extra credentials or API calls. */
export function usePageBadges(pages: () => Page[], manifests: () => Record<string, WidgetManifest>, socket: Socket) {
  const snapshots = ref<Record<string, unknown>>({})
  const now = ref(Date.now())
  const plans = computed(() => pages().map(p => ({ id: p.id, sources: badgeSources(p, manifests()) })))
  let subscriptions: (() => void)[] = []
  watch(() => JSON.stringify(plans.value), () => {
    subscriptions.forEach(off => off()); subscriptions = []
    snapshots.value = {}
    const channels = new Set(plans.value.flatMap(p => p.sources.map(s => s.channel)))
    for (const channel of channels) subscriptions.push(socket.subscribe(channel, data => {
      snapshots.value[channel] = data; now.value = Date.now()
    }))
  }, { immediate: true, flush: 'sync' })
  watch(socket.status, status => { if (status !== 'open') snapshots.value = {} })
  // Gmail carries a timestamp. Other providers publish only on changes, so receive-time is
  // deliberately not a freshness clock for an unchanged Claude/GitHub snapshot.
  const timer = window.setInterval(() => { now.value = Date.now() }, 15000)
  onUnmounted(() => { subscriptions.forEach(off => off()); window.clearInterval(timer) })
  return computed<Record<string, PageBadge>>(() => {
    const badges: Record<string, PageBadge> = {}
    for (const p of plans.value) {
      const badge = pageBadge(p.sources, socket.status.value === 'open' ? snapshots.value : {}, now.value)
      if (badge) badges[p.id] = badge
    }
    return badges
  })
}
