<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { ConnectionSummary } from '../shared/types'
import { nextConnectionColor } from '../shared/types'
import { useI18n } from '../shared/i18n'
import BaseButton from '../shared/ui/BaseButton.vue'
import GoogleCalendarSelector from './GoogleCalendarSelector.vue'
import { googleAccountRequest, useConnectionsStore, type GoogleAccountStatus } from './connections'
const props = defineProps<{ id: string; connection: ConnectionSummary | null }>()
const emit = defineEmits<{ done: []; cancel: [] }>()
const { t } = useI18n()
const store = useConnectionsStore()
const name = ref(props.connection?.name ?? 'Google')
const clientId = ref(props.connection?.fields.clientId ?? '')
const clientSecret = ref('')
const calendarIds = ref(props.connection?.fields.calendarIds ?? '[]')
const color = ref(props.connection?.fields.color ?? nextConnectionColor(0))
function selectedServices(): string[] {
  try { const s:unknown = JSON.parse(props.connection?.fields.services ?? '["gmail","calendar"]'); return Array.isArray(s) ? s.filter(v=>v==='gmail'||v==='calendar') : [] } catch { return [] }
}
const selected = ref(selectedServices())
const status = ref<GoogleAccountStatus>({state:'disconnected'})
const saved = ref(Boolean(props.connection))
const busy = ref(false)
const error = ref('')
let poll: ReturnType<typeof setTimeout> | undefined
let disposed = false
const reconnect = computed(()=>Boolean(props.connection?.secrets.credentials) || ['connected','partial'].includes(status.value.state))
const canConnect = computed(()=>!busy.value && status.value.state!=='pending' && clientId.value.trim().length>0 && selected.value.length>0)
async function refresh():Promise<void> {
  if (!saved.value || disposed) return
  const next = await googleAccountRequest(props.id)
  if (disposed) return
  status.value = next
  clearTimeout(poll)
  if (next.state==='pending') poll=setTimeout(()=>void refresh(),1000)
}
onMounted(()=>void refresh())
onUnmounted(()=>{disposed=true;clearTimeout(poll);clientSecret.value='';if(status.value.state==='pending') void googleAccountRequest(props.id,'cancel')})
async function save():Promise<boolean> {
  error.value=''
  try {
    const calendars:unknown = JSON.parse(calendarIds.value)
    if (!Array.isArray(calendars) || calendars.length>50 || new Set(calendars).size!==calendars.length || calendars.some(v=>typeof v!=='string'||!v.trim()||v.length>1024)) throw new Error()
    if (!/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId.value.trim()) || !selected.value.length) throw new Error()
  } catch {error.value='malformed';return false}
  try {
    await store.save(props.id,{type:'google',name:name.value.trim()||'Google',fields:{clientId:clientId.value.trim(),services:JSON.stringify(selected.value),calendarIds:calendarIds.value,color:color.value}})
    saved.value=true;return true
  } catch {error.value='offline';return false}
}
async function connect():Promise<void> {
  if (!canConnect.value || disposed) return
  busy.value=true;clearTimeout(poll)
  try {
    if (!await save() || disposed) return
    const desktopValue = clientSecret.value;clientSecret.value=''
    status.value=await googleAccountRequest(props.id,'connect',desktopValue)
    if (disposed) { if (status.value.state==='pending') await googleAccountRequest(props.id,'cancel'); return }
    if(status.value.state==='pending') poll=setTimeout(()=>void refresh(),1000)
  } finally {busy.value=false}
}
async function action(which:'cancel'|'disconnect'):Promise<void> {
  busy.value=true;clearTimeout(poll);clientSecret.value=''
  try {status.value=await googleAccountRequest(props.id,which)} finally {busy.value=false}
}
async function saveSettings():Promise<void> {busy.value=true;try{if(await save()) await refresh()}finally{busy.value=false}}
</script>
<template>
  <form class="google-form" @submit.prevent="connect">
    <p>{{ t('google.setup') }}</p>
    <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener noreferrer">{{ t('google.console') }}</a>
    <label>{{ t('admin.connections.form.name') }}<input v-model="name" name="name" :disabled="busy || status.state==='pending'" /></label>
    <label>{{ t('google.clientId') }}<input v-model="clientId" name="clientId" autocomplete="off" :disabled="busy || status.state==='pending'" /></label>
    <label>{{ t('google.clientSecret') }}<input v-model="clientSecret" name="clientSecret" type="password" autocomplete="new-password" :spellcheck="false" :disabled="busy || status.state==='pending'" /></label>
    <small>{{ t('google.secretHelp') }}</small>
    <fieldset :disabled="busy || status.state==='pending'">
      <legend>{{ t('google.services') }}</legend>
      <label class="check"><input v-model="selected" type="checkbox" value="gmail" />{{ t('google.gmail') }}</label>
      <label class="check"><input v-model="selected" type="checkbox" value="calendar" />{{ t('google.calendar') }}</label>
    </fieldset>
    <small>{{ t('google.scopeHelp') }}</small>
    <GoogleCalendarSelector v-if="saved && status.services?.includes('calendar') && selected.includes('calendar')" :id="id" v-model="calendarIds" :disabled="busy || status.state==='pending'" />
    <details v-if="selected.includes('calendar')">
      <summary>{{ t('google.manualCalendars') }}</summary>
      <label>{{ t('google.calendarIds') }}<input v-model="calendarIds" name="calendarIds" :disabled="busy || status.state==='pending'" /></label>
      <small>{{ t('google.calendarHelp') }}</small>
    </details>
    <label>{{ t('google.color') }}<input v-model="color" type="color" :disabled="busy || status.state==='pending'" /></label>
    <div class="account-status" role="status" aria-live="polite">
      <strong>{{ t('google.state.'+status.state) }}</strong>
      <span v-if="status.email">{{ status.email }}</span>
      <span v-if="status.services?.length">{{ t('google.granted') }}: {{ status.services.map(s=>t('google.'+s)).join(', ') }}</span>
      <p v-if="status.error || error" class="error">{{ t('google.error.'+(error || status.error)) }}</p>
    </div>
    <p>{{ t('google.disconnectHelp') }}</p>
    <div class="actions">
      <BaseButton data-action="connect" variant="primary" :disabled="!canConnect" @click="connect">{{ t(reconnect?'google.reconnect':'google.connect') }}</BaseButton>
      <BaseButton v-if="status.state==='pending'" data-action="cancel-oauth" :disabled="busy" @click="action('cancel')">{{ t('google.cancel') }}</BaseButton>
      <BaseButton v-if="saved && status.state!=='pending'" data-action="disconnect" :disabled="busy" @click="action('disconnect')">{{ t('google.disconnect') }}</BaseButton>
      <BaseButton :disabled="busy || status.state==='pending'" @click="saveSettings">{{ t('admin.connections.form.save') }}</BaseButton>
      <BaseButton @click="emit('cancel')">{{ t('common.close') }}</BaseButton>
    </div>
  </form>
</template>
<style scoped>
.google-form { display:flex; flex-direction:column; gap:var(--space-2); color:var(--text); }
p,small { margin:0; color:var(--text-muted); font-size:var(--fs-sm); line-height:1.5; }
a { color:var(--accent); min-height:56px; display:flex; align-items:center; }
label { display:flex; flex-direction:column; gap:var(--space-1); font-size:var(--fs-sm); }
input { box-sizing:border-box; width:100%; min-height:56px; padding:10px; font:inherit; color:var(--text); background:var(--surface); border:1px solid var(--border-strong); border-radius:var(--radius-sm); }
fieldset { border:1px solid var(--border-strong); border-radius:var(--radius-sm); }
.check { min-height:56px; flex-direction:row; align-items:center; gap:12px; }
.check input { width:24px; min-height:24px; height:24px; }
.account-status { display:flex; flex-direction:column; gap:var(--space-1); border-left:3px solid var(--accent); padding:12px; word-break:break-word; }
.error { color:var(--danger); }
.actions { display:flex; flex-wrap:wrap; gap:var(--space-2); }
.actions :deep(button) { min-height:56px; }
</style>
