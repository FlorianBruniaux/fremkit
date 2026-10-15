/** @vitest-environment jsdom */
import { expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import GoogleCalendarSelector from '../src/admin/GoogleCalendarSelector.vue'
import { setLocale } from '../src/shared/i18n'
const socket=vi.hoisted(()=>({callback:undefined as ((v:unknown)=>void)|undefined,channel:'',unsubscribe:vi.fn()}))
vi.mock('../src/shared/socket',()=>({useSocket:()=>({subscribe:(channel:string,cb:(v:unknown)=>void)=>{socket.channel=channel;socket.callback=cb;return socket.unsubscribe}})}))
it('selects stable calendar IDs without mixing accounts and releases subscription',async()=>{
  setLocale('en')
  const w=mount(GoogleCalendarSelector,{props:{id:'account-a',modelValue:'[]',disabled:false}})
  expect(socket.channel).toBe('google-calendar:account-a');expect(w.text()).toContain('primary')
  socket.callback!({connectionId:'account-b',calendars:[{id:'wrong',label:'Wrong'}]});await w.vm.$nextTick();expect(w.text()).not.toContain('Wrong')
  socket.callback!({connectionId:'account-a',calendars:[{id:'calendar-one',label:'Work'},{id:'calendar-two',label:'Work'}],error:null});await w.vm.$nextTick()
  const boxes=w.findAll('input[type="checkbox"]');expect(boxes).toHaveLength(2)
  await boxes[1].setValue(true)
  expect(w.emitted('update:modelValue')?.[0]).toEqual(['["calendar-two"]'])
  w.unmount();expect(socket.unsubscribe).toHaveBeenCalled()
})
