<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useSocket } from '../shared/socket'
import { useI18n } from '../shared/i18n'
const props=defineProps<{id:string;modelValue:string;disabled?:boolean}>()
const emit=defineEmits<{'update:modelValue':[value:string]}>()
const {t}=useI18n()
const calendars=ref<Array<{id:string;label:string}>|null>(null)
const error=ref('')
let unsubscribe:(()=>void)|undefined
const selected=computed<string[]>(()=>{try{const value:unknown=JSON.parse(props.modelValue);return Array.isArray(value)&&value.every(v=>typeof v==='string')?value:[]}catch{return []}})
onMounted(()=>{
  unsubscribe=useSocket().subscribe('google-calendar:'+props.id,(raw:unknown)=>{
    if(!raw || typeof raw!=='object') return
    const value=raw as {connectionId?:unknown;calendars?:unknown;error?:unknown}
    if(value.connectionId!==props.id) return
    error.value=typeof value.error==='string'?value.error:''
    if(value.calendars===null){calendars.value=null;return}
    if(!Array.isArray(value.calendars) || value.calendars.length>1000) return
    const rows=value.calendars.filter((row):row is {id:string;label:string}=>Boolean(row)&&typeof row==='object'&&typeof row.id==='string'&&typeof row.label==='string')
    if(rows.length!==value.calendars.length || new Set(rows.map(r=>r.id)).size!==rows.length) return
    calendars.value=rows.map(({id,label})=>({id,label}))
  })
})
onUnmounted(()=>unsubscribe?.())
function toggle(id:string,checked:boolean):void {
  if(props.disabled) return
  const next=selected.value.filter(value=>value!==id)
  if(checked) next.push(id)
  emit('update:modelValue',JSON.stringify(next))
}
</script>
<template>
  <fieldset :disabled="disabled">
    <legend>{{ t('google.chooseCalendars') }}</legend>
    <p>{{ t('google.primaryHelp') }}</p>
    <p v-if="error" class="error">{{ t('google.error.'+error) }}</p>
    <p v-if="calendars===null">{{ t('google.loadingCalendars') }}</p>
    <p v-else-if="!calendars.length">{{ t('google.noCalendars') }}</p>
    <label v-for="calendar in calendars" :key="calendar.id">
      <input type="checkbox" :value="calendar.id" :checked="selected.includes(calendar.id)" @change="toggle(calendar.id,($event.target as HTMLInputElement).checked)" />
      <span>{{ calendar.label }}<small>{{ calendar.id }}</small></span>
    </label>
  </fieldset>
</template>
<style scoped>
fieldset { border:1px solid var(--border-strong); border-radius:var(--radius-sm); }
p { margin:0 0 8px; color:var(--text-muted); font-size:var(--fs-sm); }
label { display:flex; align-items:center; min-height:56px; gap:12px; padding:4px; cursor:pointer; }
input { width:24px; height:24px; }
span { min-width:0; overflow-wrap:anywhere; }
small { display:block; color:var(--text-muted); }
.error { color:var(--danger); }
</style>
